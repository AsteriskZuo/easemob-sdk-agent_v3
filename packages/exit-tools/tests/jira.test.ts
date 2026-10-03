import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createJiraExitTool } from "../src/jira.js";

type Responder = (
  req: IncomingMessage,
  body: string,
  res: ServerResponse,
) => void;

interface Captured {
  loginGetAuthorization: string | undefined;
  loginPosts: string[];
  loginPostCookies: Array<string | undefined>;
  commentPaths: string[];
  commentBodies: string[];
  commentCookies: Array<string | undefined>;
  commentAuthorizations: Array<string | undefined>;
  createBody: string | undefined;
  createAuthorization: string | undefined;
}

interface TestServer {
  origin: string;
  captured: Captured;
  close(): Promise<void>;
}

const VALID_USER = "bot";
const VALID_PASSWORD = "secret";

const LOGIN_PAGE = `<html><body>
<form action="/decoy" method="post">
  <input type="hidden" name="decoy_field" value="should-not-be-sent"/>
</form>
<form id="login-form" action="/login.jsp" method="post">
  <input type="hidden" name="os_destination" value="/secure/Dashboard.jspa"/>
  <input type="hidden" name="atl_token" value="tok123"/>
  <input name="os_username" type="text"/>
  <input name="os_password" type="password"/>
</form>
</body></html>`;

function startJiraServer(
  options: {
    failCommentWith401Once?: boolean;
    commentStatus?: number;
  } = {},
): Promise<TestServer> {
  const captured: Captured = {
    loginGetAuthorization: undefined,
    loginPosts: [],
    loginPostCookies: [],
    commentPaths: [],
    commentBodies: [],
    commentCookies: [],
    commentAuthorizations: [],
    createBody: undefined,
    createAuthorization: undefined,
  };
  let comment401Used = false;

  const responder: Responder = (req, body, res) => {
    const path = req.url ?? "";

    if (path === "/login.jsp" && req.method === "GET") {
      captured.loginGetAuthorization = req.headers.authorization;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(LOGIN_PAGE);
      return;
    }

    if (path === "/login.jsp" && req.method === "POST") {
      captured.loginPosts.push(body);
      captured.loginPostCookies.push(req.headers.cookie);
      const params = new URLSearchParams(body);
      const okLogin =
        params.get("os_username") === VALID_USER &&
        params.get("os_password") === VALID_PASSWORD;
      if (okLogin) {
        res.writeHead(302, {
          location: "/secure/Dashboard.jspa",
          "set-cookie": [
            "JSESSIONID=abc123; Path=/",
            "seraph.rememberme=xyz; Path=/",
          ],
        });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<html><body><form name="loginform"><input name="os_username"/></form></body></html>`,
        );
      }
      return;
    }

    if (path === "/rest/api/2/serverInfo" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ baseUrl: "http://jira.local" }));
      return;
    }

    if (path.startsWith("/rest/api/2/issue/") && path.endsWith("/comment")) {
      captured.commentPaths.push(path);
      captured.commentBodies.push(body);
      captured.commentCookies.push(req.headers.cookie);
      captured.commentAuthorizations.push(req.headers.authorization);
      if (options.failCommentWith401Once && !comment401Used) {
        comment401Used = true;
        res.writeHead(401);
        res.end("session expired");
        return;
      }
      const status = options.commentStatus ?? 200;
      res.writeHead(status);
      res.end(status === 200 ? "{}" : "boom");
      return;
    }

    if (path === "/rest/api/2/issue" && req.method === "POST") {
      captured.createBody = body;
      captured.createAuthorization = req.headers.authorization;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "100", key: "HIM-42", self: "http://x" }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => responder(req, body, res));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        captured,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    }),
  );
}

function baseConfig(origin: string): Record<string, string> {
  return {
    url: origin,
    project: "HIM",
    username: VALID_USER,
    password: VALID_PASSWORD,
  };
}

describe("jira destinationOf", () => {
  const tool = createJiraExitTool();

  it("host + issue_key", () => {
    expect(
      tool.destinationOf({
        url: "https://j1.private.easemob.com",
        project: "HIM",
        issue_key: "HIM-123",
      }),
    ).toBe("j1.private.easemob.com__HIM-123");
  });

  it("无 issue_key 时用 project", () => {
    expect(
      tool.destinationOf({
        url: "https://j1.private.easemob.com",
        project: "HIM",
      }),
    ).toBe("j1.private.easemob.com__HIM");
  });

  it("host 中 ':' 替换为 '_'", () => {
    expect(
      tool.destinationOf({ url: "http://example.com:8443", project: "HIM" }),
    ).toBe("example.com_8443__HIM");
  });

  it("缺 url → 抛错", () => {
    expect(() => tool.destinationOf({ project: "HIM" })).toThrow("'url'");
  });

  it("url 非法 → 抛错", () => {
    expect(() =>
      tool.destinationOf({ url: "not a url", project: "HIM" }),
    ).toThrow("不是合法地址");
  });

  it("缺 project → 抛错", () => {
    expect(() => tool.destinationOf({ url: "https://a.b" })).toThrow(
      "'project'",
    );
  });
});

describe("jira bind 校验", () => {
  it("缺 username → 抛错", () => {
    expect(() =>
      createJiraExitTool().bind({
        url: "https://a.b",
        project: "HIM",
        password: "p",
      }),
    ).toThrow("'username'");
  });

  it("缺 password → 抛错", () => {
    expect(() =>
      createJiraExitTool().bind({
        url: "https://a.b",
        project: "HIM",
        username: "u",
      }),
    ).toThrow("'password'");
  });
});

describe("jira bind 注入 createClient", () => {
  it("bind 把完整配置原样传给 createClient，deliver comment 调用假 client", async () => {
    const calls: Record<string, string>[] = [];
    const comments: { issueKey: string; body: string }[] = [];
    const fake = {
      addComment(issueKey: string, body: string) {
        comments.push({ issueKey, body });
        return Promise.resolve();
      },
      createIssue() {
        return Promise.resolve({ key: "HIM-9" });
      },
    };
    const tool = createJiraExitTool({
      createClient(config) {
        calls.push(config);
        return fake as never;
      },
    });
    const config = {
      url: "https://j.example.com",
      project: "HIM",
      issue_key: "HIM-1",
      username: "u",
      password: "p",
      redirect_username: "gw",
      redirect_password: "gp",
    };
    const exit = tool.bind(config);
    expect(calls[0]).toEqual(config);
    await exit.deliver({ op: "comment", body: "hi" });
    expect(comments).toEqual([{ issueKey: "HIM-1", body: "hi" }]);
  });

  it("deliver create：fields 组装（project.key/summary/extra 透传，description 缺省省略）", async () => {
    const created: Record<string, unknown>[] = [];
    const fake = {
      addComment() {
        return Promise.resolve();
      },
      createIssue(fields: Record<string, unknown>) {
        created.push(fields);
        return Promise.resolve({ key: "HIM-7" });
      },
    };
    const tool = createJiraExitTool({ createClient: () => fake as never });
    const exit = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      username: "u",
      password: "p",
    });
    await exit.deliver({
      op: "create",
      fields: { summary: "s", customfield_11901: "bug 内容" },
    });
    expect(created[0]).toEqual({
      project: { key: "HIM" },
      summary: "s",
      customfield_11901: "bug 内容",
    });
    await exit.deliver({
      op: "create",
      fields: { summary: "s2", description: "d" },
    });
    expect(created[1]).toEqual({
      project: { key: "HIM" },
      summary: "s2",
      description: "d",
    });
  });
});

describe("jira deliver（本地服务器 + 真实 JiraClient）", () => {
  const tool = createJiraExitTool();

  it("comment：登录后带 cookie 请求，路径与 JSON body 正确", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind({
        ...baseConfig(srv.origin),
        issue_key: "HIM-123",
      });
      await exit.deliver({ op: "comment", body: "hello" });
      expect(srv.captured.commentPaths).toEqual([
        "/rest/api/2/issue/HIM-123/comment",
      ]);
      expect(srv.captured.commentBodies).toEqual([
        JSON.stringify({ body: "hello" }),
      ]);
      expect(srv.captured.commentCookies[0]).toContain("JSESSIONID=abc123");
      expect(srv.captured.commentCookies[0]).toContain("seraph.rememberme=xyz");
    } finally {
      await srv.close();
    }
  });

  it("comment：对象 body 走 ```json 围栏渲染", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind({
        ...baseConfig(srv.origin),
        issue_key: "HIM-123",
      });
      await exit.deliver({ op: "comment", body: { a: 1 } });
      const parsed = JSON.parse(srv.captured.commentBodies[0]) as {
        body: string;
      };
      expect(parsed.body).toBe(
        "```json\n" + JSON.stringify({ a: 1 }, null, 2) + "\n```",
      );
    } finally {
      await srv.close();
    }
  });

  it("comment：隐藏字段与业务字段一并提交（id=login-form 优先于 decoy 表单）", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind({ ...baseConfig(srv.origin), issue_key: "HIM-1" });
      await exit.deliver({ op: "comment", body: "x" });
      const loginPost = srv.captured.loginPosts[0];
      expect(loginPost).toContain("os_username=bot");
      expect(loginPost).toContain(`os_password=${VALID_PASSWORD}`);
      expect(loginPost).toContain("os_cookie=true");
      expect(loginPost).toContain("os_destination=%2Fsecure%2FDashboard.jspa");
      expect(loginPost).toContain("atl_token=tok123");
      expect(loginPost).not.toContain("decoy_field");
    } finally {
      await srv.close();
    }
  });

  it("配置 redirect_* 时每个请求带网关 Basic 头", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind({
        ...baseConfig(srv.origin),
        issue_key: "HIM-1",
        redirect_username: "gw",
        redirect_password: "gp",
      });
      await exit.deliver({ op: "comment", body: "x" });
      const expected = `Basic ${Buffer.from("gw:gp").toString("base64")}`;
      expect(srv.captured.loginGetAuthorization).toBe(expected);
      expect(srv.captured.commentAuthorizations[0]).toBe(expected);
    } finally {
      await srv.close();
    }
  });

  it("comment：缺 issue_key → 抛错", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind(baseConfig(srv.origin));
      await expect(exit.deliver({ op: "comment", body: "x" })).rejects.toThrow(
        "'issue_key'",
      );
    } finally {
      await srv.close();
    }
  });

  it("create：fields.project.key/summary/description 正确，正常 resolve", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind(baseConfig(srv.origin));
      await expect(
        exit.deliver({
          op: "create",
          fields: { summary: "标题", description: "描述", labels: ["a"] },
        }),
      ).resolves.toBeUndefined();
      const parsed = JSON.parse(srv.captured.createBody ?? "") as {
        fields: Record<string, unknown>;
      };
      expect(parsed.fields.project).toEqual({ key: "HIM" });
      expect(parsed.fields.summary).toBe("标题");
      expect(parsed.fields.description).toBe("描述");
      expect(parsed.fields.labels).toEqual(["a"]);
    } finally {
      await srv.close();
    }
  });

  it("登录失败（错误密码 → 200 非 302）→ deliver 抛错", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind({
        ...baseConfig(srv.origin),
        issue_key: "HIM-1",
        password: "wrong",
      });
      await expect(exit.deliver({ op: "comment", body: "x" })).rejects.toThrow(
        "登录失败",
      );
    } finally {
      await srv.close();
    }
  });

  it("REST 401 一次后重登成功 → deliver 成功", async () => {
    const srv = await startJiraServer({ failCommentWith401Once: true });
    try {
      const exit = tool.bind({ ...baseConfig(srv.origin), issue_key: "HIM-1" });
      await expect(
        exit.deliver({ op: "comment", body: "x" }),
      ).resolves.toBeUndefined();
      expect(srv.captured.commentBodies).toEqual([
        JSON.stringify({ body: "x" }),
        JSON.stringify({ body: "x" }),
      ]);
      expect(srv.captured.loginPosts).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it("服务器 500 → 抛错（含状态码）", async () => {
    const srv = await startJiraServer({ commentStatus: 500 });
    try {
      const exit = tool.bind({ ...baseConfig(srv.origin), issue_key: "HIM-1" });
      await expect(exit.deliver({ op: "comment", body: "x" })).rejects.toThrow(
        "HTTP 500",
      );
    } finally {
      await srv.close();
    }
  });

  it("非法 payload：非对象 / 缺 op / 未知 op → 抛错", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind({ ...baseConfig(srv.origin), issue_key: "HIM-1" });
      await expect(exit.deliver("plain")).rejects.toThrow("payload 非法");
      await expect(exit.deliver({ body: "x" })).rejects.toThrow("op");
      await expect(exit.deliver({ op: "delete" })).rejects.toThrow(
        "'comment' 或 'create'",
      );
    } finally {
      await srv.close();
    }
  });

  it("create 缺 summary → 抛错", async () => {
    const srv = await startJiraServer();
    try {
      const exit = tool.bind(baseConfig(srv.origin));
      await expect(exit.deliver({ op: "create", fields: {} })).rejects.toThrow(
        "summary",
      );
    } finally {
      await srv.close();
    }
  });
});
