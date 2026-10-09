import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JiraClient } from "../src/index.js";
import type { JiraIssueLite } from "../src/index.js";

/** 本地 mock jira 服务：表单登录（login.jsp GET 表单 → POST 验账 → 302 + Set-Cookie）
 *  + Dashboard 匿名态验证 + REST API。测试不触外网 */

interface RecordedRequest {
  method: string;
  path: string;
  cookie: string | undefined;
  authorization: string | undefined;
  body: string;
}

interface MockJiraState {
  /** 全部 API 请求（/rest/api/2/* 与 /custom/*）按序记录 */
  apiRequests: RecordedRequest[];
  /** 登录 POST 收到的 body（依次记录） */
  loginBodies: string[];
  /** GET /login.jsp 收到的 Authorization 头（依次记录） */
  loginGetAuthorizations: (string | undefined)[];
  /** 置 true 时，下一次 API 请求强制 401 一次（模拟会话过期） */
  failNextApiWith401: boolean;
  /** 置 true 时，所有 API 请求恒 401（模拟重登后仍 401） */
  alwaysApi401: boolean;
  /** 非 undefined 时，API 请求统一回该状态码（错误码映射测试用） */
  apiStatusOverride: number | undefined;
  /** 置 true 时 GET /login.jsp 永不响应（超时中止测试用） */
  hangLogin: boolean;
  /** search 响应体覆盖（非法 JSON / 缺 issues 等形状测试用） */
  searchBodyOverride: string | undefined;
  /** createIssue 响应体覆盖（缺 key 测试用） */
  createBodyOverride: string | undefined;
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

const RAW_ISSUE = {
  key: "PRJ-1",
  fields: {
    summary: "第一个工单",
    customfield_11901: "私有字段原样保留",
    description: "原始描述",
  },
};

function makeState(): MockJiraState {
  return {
    apiRequests: [],
    loginBodies: [],
    loginGetAuthorizations: [],
    failNextApiWith401: false,
    alwaysApi401: false,
    apiStatusOverride: undefined,
    hangLogin: false,
    searchBodyOverride: undefined,
    createBodyOverride: undefined,
    validUser: "bot",
    validPassword: "pw",
  };
}

function hasSession(cookie: string | undefined): boolean {
  return cookie?.includes("JSESSIONID=sess-abc") ?? false;
}

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
        if (state.hangLogin) return; // 永不响应：客户端应超时中止
        state.loginGetAuthorizations.push(req.headers.authorization);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><form action="/decoy" method="post">` +
            `<input type="hidden" name="decoy_field" value="should-not-be-sent" />` +
            `</form>` +
            `<form id="login-form" action="/login.jsp" method="post">` +
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
          res.writeHead(302, {
            location: "/secure/Dashboard.jspa",
            "set-cookie": [
              "JSESSIONID=sess-abc; Path=/",
              "seraph.rememberme=xyz; Path=/",
            ],
          });
          res.end();
        } else {
          // 登录失败：jira 实际回登录页（匿名态由 Dashboard 验证阶段判出）
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><form><input name="os_username" /></form></body></html>`,
          );
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/secure/Dashboard.jspa") {
        const authed = hasSession(cookie);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><head><meta name="ajs-remote-user" content="${authed ? state.validUser : ""}"></head><body></body></html>`,
        );
        return;
      }

      // 其余一律视为 API 请求：先记录，再按故障开关分流
      state.apiRequests.push({
        method: req.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        cookie,
        authorization: req.headers.authorization,
        body,
      });

      if (state.alwaysApi401) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (state.failNextApiWith401) {
        state.failNextApiWith401 = false;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (!hasSession(cookie)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (state.apiStatusOverride !== undefined) {
        res.writeHead(state.apiStatusOverride, {
          "Content-Type": "application/json",
        });
        res.end("{}");
        return;
      }

      if (req.method === "GET" && url.pathname === "/rest/api/2/search") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(state.searchBodyOverride ?? JSON.stringify({ issues: ISSUES }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/rest/api/2/serverInfo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ baseUrl: "http://jira.local" }));
        return;
      }

      if (
        req.method === "POST" &&
        /^\/rest\/api\/2\/issue\/[^/]+\/comment$/.test(url.pathname)
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }

      if (req.method === "GET" && url.pathname === "/rest/api/2/issue/PRJ-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(RAW_ISSUE));
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname.startsWith("/rest/api/2/issue/")
      ) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errorMessages: ["Issue Does Not Exist"] }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/rest/api/2/issue") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          state.createBodyOverride ??
            JSON.stringify({ id: "100", key: "HIM-42", self: "http://x" }),
        );
        return;
      }

      if (url.pathname === "/custom/empty") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("");
        return;
      }

      if (url.pathname === "/custom/echo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            body,
            customHeader: req.headers["x-custom"] ?? null,
          }),
        );
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

function makeClient(url: string, extra?: Record<string, unknown>): JiraClient {
  return new JiraClient({
    baseUrl: url,
    username: "bot",
    password: "pw",
    ...extra,
  });
}

describe("认证链：表单登录 + cookie 重放", () => {
  it("登录成功后 search 带会话 cookie；登录 POST 回带 hidden CSRF，decoy 表单字段不提交", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("success");
      expect(state.loginBodies).toHaveLength(1);
      const loginParams = new URLSearchParams(state.loginBodies[0] ?? "");
      expect(loginParams.get("os_username")).toBe("bot");
      expect(loginParams.get("os_password")).toBe("pw");
      expect(loginParams.get("os_cookie")).toBe("true");
      expect(loginParams.get("atl_token")).toBe("csrf-123");
      expect(loginParams.get("decoy_field")).toBeNull();
      // search 重放了登录拿到的全部 cookie
      const searchReq = state.apiRequests.find((r) =>
        r.path.startsWith("/rest/api/2/search"),
      );
      expect(searchReq?.cookie).toContain("JSESSIONID=sess-abc");
      expect(searchReq?.cookie).toContain("seraph.rememberme=xyz");
    } finally {
      await mock.close();
    }
  });

  it("配置 redirect 凭据时登录页与 API 请求都带网关 Basic 头", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url, {
        redirectUsername: "gw",
        redirectPassword: "gp",
      });
      const result = await client.ping();

      expect(result.status).toBe("success");
      const expected = `Basic ${Buffer.from("gw:gp").toString("base64")}`;
      expect(state.loginGetAuthorizations[0]).toBe(expected);
      expect(state.apiRequests[0]?.authorization).toBe(expected);
    } finally {
      await mock.close();
    }
  });

  it("密码错误：登录后仍匿名态 → authentication_failed（未发起 API 请求）", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = new JiraClient({
        baseUrl: mock.url,
        username: "bot",
        password: "wrong",
      });
      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("authentication_failed");
      expect(state.apiRequests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

describe("认证链：401 自愈", () => {
  it("401 视为会话过期：清态重登一次后原请求重试成功（登录发生两次）", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const warm = await client.searchIssues({ project: "PRJ" });
      expect(warm.status).toBe("success");
      expect(state.loginBodies).toHaveLength(1);

      state.failNextApiWith401 = true;
      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("success");
      expect(state.loginBodies).toHaveLength(2);
      const searches = state.apiRequests.filter((r) =>
        r.path.startsWith("/rest/api/2/search"),
      );
      expect(searches).toHaveLength(3); // warm + 401 那次 + 重试
    } finally {
      await mock.close();
    }
  });

  it("重登后仍 401 → authentication_failed", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const warm = await client.searchIssues({ project: "PRJ" });
      expect(warm.status).toBe("success");

      state.alwaysApi401 = true;
      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("authentication_failed");
      expect(state.loginBodies).toHaveLength(2); // 重登恰好一次
    } finally {
      await mock.close();
    }
  });
});

describe("错误码映射", () => {
  it.each([
    [403, "permission_denied"],
    [404, "ticket_not_found"],
    [429, "rate_limited"],
    [500, "jira_server_error"],
  ])("HTTP %i → %s", async (httpStatus, code) => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const warm = await client.ping();
      expect(warm.status).toBe("success");

      state.apiStatusOverride = httpStatus;
      const result = await client.searchIssues({ project: "PRJ" });
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe(code);
    } finally {
      await mock.close();
    }
  });

  it("连接失败（端口不可达）→ network_error", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    const url = mock.url;
    await mock.close(); // 关掉服务，连接必失败

    const client = makeClient(url);
    const result = await client.ping();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("network_error");
  });

  it("超时中止 → network_error", async () => {
    const state = makeState();
    state.hangLogin = true;
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url, { timeoutMs: 200 });
      const result = await client.ping();
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("network_error");
    } finally {
      await mock.close();
    }
  });

  it("search 返回非法 JSON → invalid_response", async () => {
    const state = makeState();
    state.searchBodyOverride = "not json";
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.searchIssues({ project: "PRJ" });
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("invalid_response");
    } finally {
      await mock.close();
    }
  });

  it("search 响应缺 issues 数组 → invalid_response", async () => {
    const state = makeState();
    state.searchBodyOverride = JSON.stringify({ total: 0 });
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.searchIssues({ project: "PRJ" });
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("invalid_response");
    } finally {
      await mock.close();
    }
  });
});

describe("searchIssues：JQL 构造与 lite 映射", () => {
  function lastSearchUrl(state: MockJiraState): URL {
    const req = [...state.apiRequests]
      .reverse()
      .find((r) => r.path.startsWith("/rest/api/2/search"));
    return new URL(req?.path ?? "/", "http://localhost");
  }

  it("全组合：project + assignee in + daysBack + maxResults", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.searchIssues({
        project: "PRJ",
        assignees: ["zhangsan", "lisi"],
        daysBack: 3,
        maxResults: 50,
      });

      expect(result.status).toBe("success");
      const url = lastSearchUrl(state);
      const jql = url.searchParams.get("jql") ?? "";
      expect(jql).toContain('project = "PRJ"');
      expect(jql).toContain('assignee in ("zhangsan", "lisi")');
      expect(jql).toContain("updated >= -3d");
      expect(jql).toContain("ORDER BY updated DESC");
      expect(url.searchParams.get("maxResults")).toBe("50");
      expect(url.searchParams.get("fields")).toBe(
        "summary,status,priority,issuetype,assignee,reporter,updated",
      );
    } finally {
      await mock.close();
    }
  });

  it("缺省：无过滤条件时仅 updated >= -7d；单 assignee 用等号；maxResults 缺省 100", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      await client.searchIssues();
      let jql = lastSearchUrl(state).searchParams.get("jql") ?? "";
      expect(jql).toBe("updated >= -7d ORDER BY updated DESC");
      expect(lastSearchUrl(state).searchParams.get("maxResults")).toBe("100");

      await client.searchIssues({ assignees: ["solo"] });
      jql = lastSearchUrl(state).searchParams.get("jql") ?? "";
      expect(jql).toContain('assignee = "solo"');
      expect(jql).not.toContain(" in (");
    } finally {
      await mock.close();
    }
  });

  it("lite 映射字段逐项（缺字段填空串 / null；无 key 的工单被跳过）", async () => {
    const state = makeState();
    state.searchBodyOverride = JSON.stringify({
      issues: [
        ...ISSUES,
        { fields: { summary: "无 key 工单" } },
        { key: "PRJ-3", fields: {} },
      ],
    });
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.searchIssues({ project: "PRJ" });

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.data).toHaveLength(3);
      const first = result.data[0] as JiraIssueLite;
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
      expect(result.data[1]?.assignee).toBeNull();
      // 全缺字段 → 空串 / null 兜底
      expect(result.data[2]).toEqual({
        key: "PRJ-3",
        summary: "",
        status: "",
        priority: "",
        issue_type: "",
        assignee: null,
        reporter: null,
        updated: "",
      });
    } finally {
      await mock.close();
    }
  });
});

describe("getIssueRaw / ping", () => {
  it("成功返回未映射原始 JSON（私有字段原样保留）", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.getIssueRaw("PRJ-1");
      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.data).toEqual(RAW_ISSUE);
    } finally {
      await mock.close();
    }
  });

  it("404 → ticket_not_found；空 issueKey → invalid_input", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const missing = await client.getIssueRaw("MISSING-1");
      expect(missing.status).toBe("error");
      if (missing.status !== "error") return;
      expect(missing.code).toBe("ticket_not_found");

      const empty = await client.getIssueRaw("  ");
      expect(empty.status).toBe("error");
      if (empty.status !== "error") return;
      expect(empty.code).toBe("invalid_input");
    } finally {
      await mock.close();
    }
  });

  it("ping：认证 + serverInfo，返回解析 JSON", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.ping();
      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.data).toEqual({ baseUrl: "http://jira.local" });
    } finally {
      await mock.close();
    }
  });
});

describe("addComment / createIssue", () => {
  it('addComment：POST /issue/{key}/comment，body 包进 {"body": ...}', async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.addComment("HIM-123", "hello");
      expect(result.status).toBe("success");

      const req = state.apiRequests.find((r) => r.path.includes("/comment"));
      expect(req?.method).toBe("POST");
      expect(req?.path).toBe("/rest/api/2/issue/HIM-123/comment");
      expect(JSON.parse(req?.body ?? "")).toEqual({ body: "hello" });

      const empty = await client.addComment("", "x");
      expect(empty.status).toBe("error");
      if (empty.status !== "error") return;
      expect(empty.code).toBe("invalid_input");
    } finally {
      await mock.close();
    }
  });

  it('createIssue：fields 原样包进 {"fields": ...}，成功 data = { key }', async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const fields = {
        project: { key: "HIM" },
        summary: "标题",
        labels: ["a"],
      };
      const result = await client.createIssue(fields);

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.data).toEqual({ key: "HIM-42" });
      const req = state.apiRequests.find(
        (r) => r.method === "POST" && r.path === "/rest/api/2/issue",
      );
      expect(JSON.parse(req?.body ?? "")).toEqual({ fields });
    } finally {
      await mock.close();
    }
  });

  it("createIssue 响应缺 key → invalid_response", async () => {
    const state = makeState();
    state.createBodyOverride = JSON.stringify({ id: "100" });
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.createIssue({ summary: "x" });
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.code).toBe("invalid_response");
    } finally {
      await mock.close();
    }
  });
});

describe("request 原语", () => {
  it("自定义 method/headers/body 透传；响应 JSON 解析返回", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const result = await client.request("/custom/echo", {
        method: "PUT",
        headers: { "X-Custom": "yes", "Content-Type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.data).toEqual({
        method: "PUT",
        body: JSON.stringify({ a: 1 }),
        customHeader: "yes",
      });
      // request 原语同样带会话 cookie
      const req = state.apiRequests.find((r) => r.path === "/custom/echo");
      expect(req?.cookie).toContain("JSESSIONID=sess-abc");
    } finally {
      await mock.close();
    }
  });

  it("无 body 响应 → data 为 undefined；空路径 → invalid_input", async () => {
    const state = makeState();
    const mock = await startMockJira(state);
    try {
      const client = makeClient(mock.url);
      const noBody = await client.request("/custom/empty");
      expect(noBody.status).toBe("success");
      if (noBody.status !== "success") return;
      expect(noBody.data).toBeUndefined();

      const empty = await client.request("  ");
      expect(empty.status).toBe("error");
      if (empty.status !== "error") return;
      expect(empty.code).toBe("invalid_input");
    } finally {
      await mock.close();
    }
  });
});
