import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createJiraSearchClient } from "../src/jira-client.js";
import type { JiraIssueLite } from "../src/jira-client.js";

/** 本地 mock jira 服务：表单登录（login.jsp GET 表单 → POST 验账 → Set-Cookie）
 *  + Dashboard 验证 + search。测试不触外网 */

interface MockJiraState {
  /** search 请求收到的 JQL（依次记录） */
  searchJqls: string[];
  /** search 请求收到的 Cookie 头（依次记录） */
  searchCookies: (string | undefined)[];
  /** 登录 POST 收到的 body（依次记录） */
  loginBodies: string[];
  /** 置 true 时，下一次（带 cookie 的）search 强制 401（模拟会话过期） */
  failNextSearchWith401: boolean;
  /** 登录校验用合法账号 */
  validUser: string;
  validPassword: string;
}

const ISSUES: unknown[] = [
  {
    key: "PRJ-1",
    fields: {
      summary: "第一个工单",
      status: { name: "In Progress" },
      priority: { name: "Major" },
      issuetype: { name: "Bug" },
      assignee: { name: "zhangsan" },
      reporter: { name: "lisi" },
      updated: "2026-10-08T10:00:00.000+0800",
    },
  },
  {
    key: "PRJ-2",
    fields: {
      summary: "第二个工单",
      status: { name: "Open" },
      priority: { name: "Minor" },
      issuetype: { name: "Task" },
      assignee: null,
      reporter: { name: "lisi" },
      updated: "2026-10-07T09:00:00.000+0800",
    },
  },
];

async function startMockJira(state: MockJiraState): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cookie = req.headers.cookie;

      if (req.method === "GET" && url.pathname === "/login.jsp") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><form id="login-form" action="/login.jsp" method="post">` +
            `<input type="hidden" name="atl_token" value="csrf-123" />` +
            `<input type="text" name="os_username" />` +
            `<input type="password" name="os_password" />` +
            `</form></body></html>`,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/login.jsp") {
        state.loginBodies.push(body);
        const params = new URLSearchParams(body);
        if (
          params.get("os_username") === state.validUser &&
          params.get("os_password") === state.validPassword &&
          params.get("os_cookie") === "true"
        ) {
          res.writeHead(200, {
            "Set-Cookie": "JSESSIONID=sess-abc; Path=/",
            "Content-Type": "text/html",
          });
          res.end("");
        } else {
          // 登录失败：jira 实际会回登录页（匿名态由 Dashboard 验证阶段判出）
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("");
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/secure/Dashboard.jspa") {
        const authed = cookie?.includes("JSESSIONID=sess-abc") ?? false;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><head><meta name="ajs-remote-user" content="${authed ? state.validUser : ""}"></head><body></body></html>`,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/rest/api/2/search") {
        state.searchJqls.push(url.searchParams.get("jql") ?? "");
        state.searchCookies.push(cookie);
        const authed = cookie?.includes("JSESSIONID=sess-abc") ?? false;
        if (!authed || state.failNextSearchWith401) {
          state.failNextSearchWith401 = false;
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ issues: ISSUES }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function makeState(): MockJiraState {
  return {
    searchJqls: [],
    searchCookies: [],
    loginBodies: [],
    failNextSearchWith401: false,
    validUser: "bot",
    validPassword: "pw",
  };
}

describe("jira 轻量客户端（mock HTTP：表单登录 → search 两段）", () => {
  it("登录后 search：JQL 含 project/assignee in/updated 子句，请求带 cookie，字段映射正确", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = createJiraSearchClient({
        baseUrl: mock.url,
        username: "bot",
        password: "pw",
      });

      const result = await client.searchIssues({
        project: "PRJ",
        assignees: ["zhangsan", "lisi"],
        daysBack: 3,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      // JQL 三段
      expect(state.searchJqls).toHaveLength(1);
      const jql = state.searchJqls[0] as string;
      expect(jql).toContain('project = "PRJ"');
      expect(jql).toContain('assignee in ("zhangsan", "lisi")');
      expect(jql).toContain("updated >= -3d");
      expect(jql).toContain("ORDER BY updated DESC");
      // search 带上了登录拿到的 cookie
      expect(state.searchCookies[0]).toContain("JSESSIONID=sess-abc");
      // 登录 POST：表单三段 + hidden CSRF 回带
      expect(state.loginBodies).toHaveLength(1);
      const loginParams = new URLSearchParams(state.loginBodies[0] ?? "");
      expect(loginParams.get("os_username")).toBe("bot");
      expect(loginParams.get("os_password")).toBe("pw");
      expect(loginParams.get("os_cookie")).toBe("true");
      expect(loginParams.get("atl_token")).toBe("csrf-123");
      // 字段映射
      const first = result.issues[0] as JiraIssueLite;
      expect(first).toEqual({
        key: "PRJ-1",
        summary: "第一个工单",
        status: "In Progress",
        priority: "Major",
        issue_type: "Bug",
        assignee: "zhangsan",
        reporter: "lisi",
        updated: "2026-10-08T10:00:00.000+0800",
      });
      expect(result.issues[1]?.assignee).toBeNull();
    } finally {
      await mock.close();
    }
  });

  it("401 视为会话过期：清态重登一次后重试成功（登录发生两次）", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = createJiraSearchClient({
        baseUrl: mock.url,
        username: "bot",
        password: "pw",
      });
      // 先建立会话
      const warm = await client.searchIssues({ project: "PRJ" });
      expect(warm.status).toBe("success");
      expect(state.loginBodies).toHaveLength(1);

      // 会话过期：下一次 search 401 → 客户端应清 cookie 重登并重试
      state.failNextSearchWith401 = true;
      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("success");
      expect(state.loginBodies).toHaveLength(2);
      expect(state.searchJqls).toHaveLength(3); // warm + 401 那次 + 重试
    } finally {
      await mock.close();
    }
  });

  it("密码错误：登录后仍匿名态 → authentication_failed", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = createJiraSearchClient({
        baseUrl: mock.url,
        username: "bot",
        password: "wrong",
      });

      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("authentication_failed");
      expect(state.searchJqls).toHaveLength(0); // 未发起 search
    } finally {
      await mock.close();
    }
  });
});
