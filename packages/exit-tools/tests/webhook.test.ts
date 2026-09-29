import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createWebhookExitTool } from "../src/index.js";

type Responder = (
  req: IncomingMessage,
  body: string,
  res: ServerResponse,
) => void;

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function startServer(responder: Responder): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => responder(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/a`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ok: Responder = (_req, _body, res) => {
  res.writeHead(200);
  res.end("ok");
};

describe("webhook destinationOf", () => {
  const tool = createWebhookExitTool();

  it("规范化：去协议头、':'/'/' → '_'", () => {
    expect(tool.destinationOf({ url: "http://a.b/c/d" })).toBe("a.b_c_d");
  });

  it("规范化：含端口", () => {
    expect(
      tool.destinationOf({ url: "https://example.com:8443/hooks/a" }),
    ).toBe("example.com_8443_hooks_a");
  });

  it("非法 url → 抛错", () => {
    expect(() => tool.destinationOf({ url: "not a url" })).toThrow(
      "不是合法地址",
    );
  });

  it("缺 url → 抛错", () => {
    expect(() => tool.destinationOf({})).toThrow("'url'");
  });
});

describe("webhook bind", () => {
  it("缺 url → 抛错", () => {
    expect(() => createWebhookExitTool().bind({})).toThrow("'url'");
  });
});

describe("webhook deliver", () => {
  const tool = createWebhookExitTool();

  it("body 为 payload 原样 JSON、Content-Type 正确", async () => {
    let capturedBody = "";
    let capturedContentType: string | undefined;
    const srv = await startServer((req, body, res) => {
      capturedBody = body;
      capturedContentType = req.headers["content-type"];
      ok(req, body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      const payload = { text: "hi", n: 1 };
      await exit.deliver(payload);
      expect(capturedBody).toBe(JSON.stringify(payload));
      expect(capturedContentType).toContain("application/json");
    } finally {
      await srv.close();
    }
  });

  it("payload 为 undefined → body 为 null", async () => {
    let capturedBody = "";
    const srv = await startServer((req, body, res) => {
      capturedBody = body;
      ok(req, body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver(undefined);
      expect(capturedBody).toBe("null");
    } finally {
      await srv.close();
    }
  });

  it("带 token → Authorization 头正确", async () => {
    let capturedAuth: string | undefined;
    const srv = await startServer((req, body, res) => {
      capturedAuth = req.headers.authorization;
      ok(req, body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url, token: "tkn-123" });
      await exit.deliver("x");
      expect(capturedAuth).toBe("Bearer tkn-123");
    } finally {
      await srv.close();
    }
  });

  it("无 token → 无 Authorization 头", async () => {
    let capturedAuth: string | undefined = "sentinel";
    const srv = await startServer((req, body, res) => {
      capturedAuth = req.headers.authorization;
      ok(req, body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver("x");
      expect(capturedAuth).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("服务器返回 500 → 抛错", async () => {
    const srv = await startServer((_req, _body, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await expect(exit.deliver("x")).rejects.toThrow("HTTP 500");
    } finally {
      await srv.close();
    }
  });
});
