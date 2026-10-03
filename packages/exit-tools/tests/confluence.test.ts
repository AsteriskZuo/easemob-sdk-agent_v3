import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  ConfluenceClient,
  createConfluenceExitTool,
} from "../src/confluence.js";

interface CapturedRequest {
  method: string;
  path: string;
  body: string;
  authorization?: string;
  cookie?: string;
}

interface FakeState {
  pages: Map<string, { id: string; version: number }>;
  captured: CapturedRequest[];
  loginCount: number;
  failLogin: boolean;
  get401Once: boolean;
  putStatus: number;
  postStatus: number;
  nextId: number;
  password: string;
  lastCreate?: Record<string, unknown>;
  lastPut?: Record<string, unknown>;
}

interface FakeConfluence {
  url: string;
  state: FakeState;
  close(): Promise<void>;
}

function startConfluence(): Promise<FakeConfluence> {
  const state: FakeState = {
    pages: new Map(),
    captured: [],
    loginCount: 0,
    failLogin: false,
    get401Once: false,
    putStatus: 200,
    postStatus: 200,
    nextId: 100,
    password: "p",
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handle(req, res, body));
  });

  function handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): void {
    state.captured.push({
      method: req.method ?? "",
      path: req.url ?? "",
      body,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    const url = new URL(req.url ?? "/", "http://x");

    if (url.pathname === "/login.action" && req.method === "GET") {
      state.loginCount += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>
        <form name="loginform" action="/dologin.action" method="post">
          <input type="hidden" name="os_cookie" value="true"/>
          <input type="hidden" name="os_destination" value="/index.action"/>
          <input type="hidden" name="atl_token" value="tok-1"/>
          <input name="os_username" type="text"/>
          <input name="os_password" type="password"/>
        </form>
      </body></html>`);
      return;
    }

    if (url.pathname === "/dologin.action" && req.method === "POST") {
      const params = new URLSearchParams(body);
      if (state.failLogin || params.get("os_password") !== state.password) {
        res.writeHead(200);
        res.end("login failed");
        return;
      }
      res.writeHead(302, {
        "set-cookie": "seraph.confluence=sess-abc; Path=/; HttpOnly",
        location: "/index.action",
      });
      res.end();
      return;
    }

    if (url.pathname === "/rest/api/content") {
      if (req.method === "GET") {
        if (state.get401Once) {
          state.get401Once = false;
          res.writeHead(401);
          res.end();
          return;
        }
        const title = url.searchParams.get("title") ?? "";
        const page = state.pages.get(title);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: page
              ? [{ id: page.id, version: { number: page.version } }]
              : [],
            size: page ? 1 : 0,
          }),
        );
        return;
      }
      if (req.method === "POST") {
        if (state.postStatus !== 200) {
          res.writeHead(state.postStatus);
          res.end("boom");
          return;
        }
        const data = JSON.parse(body) as {
          title: string;
          type: string;
          space: { key: string };
          body: { storage: { value: string; representation: string } };
        };
        const id = String(state.nextId++);
        state.pages.set(data.title, { id, version: 1 });
        state.lastCreate = data as unknown as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, version: { number: 1 } }));
        return;
      }
    }

    const putMatch = /^\/rest\/api\/content\/(\d+)$/.exec(url.pathname);
    if (putMatch && req.method === "PUT") {
      const data = JSON.parse(body) as {
        version: { number: number };
        title: string;
      };
      state.lastPut = data as unknown as Record<string, unknown>;
      const page = state.pages.get(data.title);
      if (page) page.version = data.version.number;
      res.writeHead(state.putStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: putMatch[1] }));
      return;
    }

    res.writeHead(500);
    res.end(`unexpected ${req.method} ${req.url}`);
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise<void>((res2) => server.close(() => res2())),
      });
    });
  });
}

function bindDeliver(
  srv: FakeConfluence,
  extraConfig: Record<string, string> = {},
) {
  const tool = createConfluenceExitTool();
  return tool.bind({
    base_url: srv.url,
    space_key: "AIR",
    page_title: "测试页",
    username: "u",
    password: "p",
    ...extraConfig,
  });
}

describe("confluence destinationOf", () => {
  const tool = createConfluenceExitTool();

  it("组合：host + '__' + space_key + '__' + page_title，'/' → '_'", () => {
    expect(
      tool.destinationOf({
        base_url: "https://c1.private.easemob.com",
        space_key: "AIR",
        page_title: "周报 10/03",
      }),
    ).toBe("c1.private.easemob.com__AIR__周报 10_03");
  });

  it("反斜杠、冒号与控制字符替换为 '_'", () => {
    expect(
      tool.destinationOf({
        base_url: "http://[::1]:8090",
        space_key: "A\\B",
        page_title: "a:bc",
      }),
    ).toBe("[__1]_8090__A_B__a_b_c");
  });

  it("缺 base_url → 抛错", () => {
    expect(() =>
      tool.destinationOf({ space_key: "AIR", page_title: "t" }),
    ).toThrow("'base_url'");
  });

  it("缺 space_key → 抛错", () => {
    expect(() =>
      tool.destinationOf({ base_url: "https://a.b", page_title: "t" }),
    ).toThrow("'space_key'");
  });

  it("缺 page_title → 抛错", () => {
    expect(() =>
      tool.destinationOf({ base_url: "https://a.b", space_key: "AIR" }),
    ).toThrow("'page_title'");
  });

  it("非法 base_url → 抛错", () => {
    expect(() =>
      tool.destinationOf({
        base_url: "not a url",
        space_key: "AIR",
        page_title: "t",
      }),
    ).toThrow("不是合法地址");
  });
});

describe("confluence bind", () => {
  it("缺 required 项（username）→ 抛错", () => {
    expect(() =>
      createConfluenceExitTool().bind({
        base_url: "https://a.b",
        space_key: "AIR",
        page_title: "t",
        password: "p",
      }),
    ).toThrow("'username'");
  });

  it("注入假 createClient：bind 透传 config，deliver 走 get-or-create 建页", async () => {
    let capturedConfig: Record<string, string> | undefined;
    const calls: string[] = [];
    const fakeClient = {
      async findPage() {
        calls.push("findPage");
        return undefined;
      },
      async createPage() {
        calls.push("createPage");
        return "1";
      },
      async updatePage() {
        calls.push("updatePage");
      },
    };
    const tool = createConfluenceExitTool({
      createClient: (config) => {
        capturedConfig = config;
        return fakeClient as unknown as ConfluenceClient;
      },
    });
    const config = {
      base_url: "https://c1.example.com",
      space_key: "AIR",
      page_title: "标题",
      username: "u",
      password: "p",
      gateway_username: "gw",
      gateway_password: "gp",
    };
    const exit = tool.bind(config);
    expect(capturedConfig).toBe(config);
    await exit.deliver({ content: "hello" });
    expect(calls).toEqual(["findPage", "createPage"]);
  });
});

describe("confluence deliver（本地服务器）", () => {
  it("页不存在 → POST 创建，请求体与 XML 转义正确", async () => {
    const srv = await startConfluence();
    try {
      const exit = bindDeliver(srv);
      await exit.deliver({ content: "a & b <x>\nline2" });
      const created = srv.state.lastCreate as {
        type: string;
        title: string;
        space: { key: string };
        body: { storage: { value: string; representation: string } };
      };
      expect(created.type).toBe("page");
      expect(created.space.key).toBe("AIR");
      expect(created.title).toBe("测试页");
      expect(created.body.storage.representation).toBe("storage");
      expect(created.body.storage.value).toBe(
        "<p>a &amp; b &lt;x&gt;<br/>line2</p>",
      );
    } finally {
      await srv.close();
    }
  });

  it("字符串 content 原样转换投递", async () => {
    const srv = await startConfluence();
    try {
      const exit = bindDeliver(srv);
      await exit.deliver("plain <text>");
      const created = srv.state.lastCreate as {
        body: { storage: { value: string } };
      };
      expect(created.body.storage.value).toBe("<p>plain &lt;text&gt;</p>");
    } finally {
      await srv.close();
    }
  });

  it("对象 content → JSON.stringify(_, null, 2) 后转义包裹", async () => {
    const srv = await startConfluence();
    try {
      const exit = bindDeliver(srv);
      await exit.deliver({ content: { n: 1, s: "a<b" } });
      const created = srv.state.lastCreate as {
        body: { storage: { value: string } };
      };
      expect(created.body.storage.value).toBe(
        '<p>{<br/>  "n": 1,<br/>  "s": "a&lt;b"<br/>}</p>',
      );
    } finally {
      await srv.close();
    }
  });

  it("页已存在 → PUT 且 version 取查页返回值 +1", async () => {
    const srv = await startConfluence();
    srv.state.pages.set("测试页", { id: "42", version: 3 });
    try {
      const exit = bindDeliver(srv);
      await exit.deliver("v2");
      const put = srv.state.lastPut as {
        id: string;
        version: { number: number };
        title: string;
      };
      expect(put.id).toBe("42");
      expect(put.version.number).toBe(4);
      expect(put.title).toBe("测试页");
      const putReq = srv.state.captured.find((c) => c.method === "PUT");
      expect(putReq?.path).toBe("/rest/api/content/42");
    } finally {
      await srv.close();
    }
  });

  it("payload 缺 content → 抛错", async () => {
    const srv = await startConfluence();
    try {
      const exit = bindDeliver(srv);
      await expect(exit.deliver({ other: 1 })).rejects.toThrow("'content'");
    } finally {
      await srv.close();
    }
  });

  it("payload 非对象/字符串 → 抛错", async () => {
    const srv = await startConfluence();
    try {
      const exit = bindDeliver(srv);
      await expect(exit.deliver(42)).rejects.toThrow("payload");
    } finally {
      await srv.close();
    }
  });

  it("登录失败 → 抛错", async () => {
    const srv = await startConfluence();
    srv.state.failLogin = true;
    try {
      const exit = bindDeliver(srv);
      await expect(exit.deliver("x")).rejects.toThrow("登录失败");
    } finally {
      await srv.close();
    }
  });

  it("REST 401 一次后自愈：清会话重登并重试成功", async () => {
    const srv = await startConfluence();
    srv.state.get401Once = true;
    try {
      const exit = bindDeliver(srv);
      await exit.deliver("x");
      expect(srv.state.loginCount).toBe(2);
      expect(srv.state.lastCreate).toBeDefined();
    } finally {
      await srv.close();
    }
  });

  it("更新 409 → 抛带版本冲突消息的错误，不重试", async () => {
    const srv = await startConfluence();
    srv.state.pages.set("测试页", { id: "42", version: 3 });
    srv.state.putStatus = 409;
    try {
      const exit = bindDeliver(srv);
      await expect(exit.deliver("x")).rejects.toThrow("409");
      expect(srv.state.captured.filter((c) => c.method === "PUT").length).toBe(
        1,
      );
    } finally {
      await srv.close();
    }
  });

  it("服务器 500 → 抛错", async () => {
    const srv = await startConfluence();
    srv.state.postStatus = 500;
    try {
      const exit = bindDeliver(srv);
      await expect(exit.deliver("x")).rejects.toThrow("HTTP 500");
    } finally {
      await srv.close();
    }
  });
});

describe("ConfluenceClient 认证细节", () => {
  it("登录 POST 携带全量 hidden 字段 + os_username/os_password", async () => {
    const srv = await startConfluence();
    try {
      const client = new ConfluenceClient({
        baseUrl: srv.url,
        username: "u",
        password: "p",
      });
      await client.createPage("AIR", "t", "<p>x</p>");
      const loginReq = srv.state.captured.find(
        (c) => c.path === "/dologin.action",
      );
      expect(loginReq).toBeDefined();
      const params = new URLSearchParams(loginReq?.body ?? "");
      expect(params.get("os_cookie")).toBe("true");
      expect(params.get("os_destination")).toBe("/index.action");
      expect(params.get("atl_token")).toBe("tok-1");
      expect(params.get("os_username")).toBe("u");
      expect(params.get("os_password")).toBe("p");
    } finally {
      await srv.close();
    }
  });

  it("网关凭证存在时每个请求都带网关 Basic 头", async () => {
    const srv = await startConfluence();
    try {
      const client = new ConfluenceClient({
        baseUrl: srv.url,
        username: "u",
        password: "p",
        gatewayUsername: "gw",
        gatewayPassword: "gp",
      });
      await client.findPage("AIR", "t");
      const expected = `Basic ${Buffer.from("gw:gp").toString("base64")}`;
      expect(srv.state.captured.length).toBeGreaterThan(0);
      for (const req of srv.state.captured) {
        expect(req.authorization).toBe(expected);
      }
    } finally {
      await srv.close();
    }
  });

  it("findPage：按标题查页返回 id/version 映射，未找到返回 undefined", async () => {
    const srv = await startConfluence();
    srv.state.pages.set("存在页", { id: "77", version: 5 });
    try {
      const client = new ConfluenceClient({
        baseUrl: srv.url,
        username: "u",
        password: "p",
      });
      expect(await client.findPage("AIR", "存在页")).toEqual({
        id: "77",
        version: 5,
      });
      expect(await client.findPage("AIR", "不存在")).toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});
