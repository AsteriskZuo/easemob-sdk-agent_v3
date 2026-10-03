import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createWecomWebhookExitTool } from "../src/index.js";

type Responder = (body: string, res: ServerResponse) => void;

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function startServer(responder: Responder): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => responder(body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/cgi-bin/webhook/send?key=test-key-123`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const okResponder: Responder = (_body, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
};

describe("wecom-webhook destinationOf", () => {
  const tool = createWecomWebhookExitTool();

  it("从合法 url 提取 key 段", () => {
    expect(
      tool.destinationOf({
        url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123",
      }),
    ).toBe("abc123");
  });

  it("url 无 key → 抛错", () => {
    expect(() =>
      tool.destinationOf({
        url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send",
      }),
    ).toThrow("缺少 key");
  });

  it("非法 url → 抛错", () => {
    expect(() => tool.destinationOf({ url: "not-a-url" })).toThrow(
      "不是合法地址",
    );
  });

  it("缺 url → 抛错", () => {
    expect(() => tool.destinationOf({})).toThrow("'url'");
  });
});

describe("wecom-webhook bind", () => {
  it("缺 url → 抛错", () => {
    expect(() => createWecomWebhookExitTool().bind({})).toThrow("'url'");
  });
});

describe("wecom-webhook deliver", () => {
  const tool = createWecomWebhookExitTool();

  it("字符串 payload → msgtype=markdown、content 原样", async () => {
    let captured = "";
    const srv = await startServer((body, res) => {
      captured = body;
      okResponder(body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver("hello 世界");
      const parsed = JSON.parse(captured);
      expect(parsed.msgtype).toBe("markdown");
      expect(parsed.markdown.content).toBe("hello 世界");
    } finally {
      await srv.close();
    }
  });

  it("对象 payload → json 围栏", async () => {
    let captured = "";
    const srv = await startServer((body, res) => {
      captured = body;
      okResponder(body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      const payload = { ok: 1, list: ["a"] };
      await exit.deliver(payload);
      const parsed = JSON.parse(captured);
      expect(parsed.markdown.content).toBe(
        "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
      );
    } finally {
      await srv.close();
    }
  });

  it("超长 payload（>4000 字节）→ content 截断且含「已截断」", async () => {
    let captured = "";
    const srv = await startServer((body, res) => {
      captured = body;
      okResponder(body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver("汉".repeat(2000)); // 6000 字节
      const parsed = JSON.parse(captured);
      const content: string = parsed.markdown.content;
      expect(content.endsWith("\n…(已截断)")).toBe(true);
      const suffixBytes = Buffer.byteLength("\n…(已截断)", "utf8");
      const contentBytes = Buffer.byteLength(content, "utf8");
      expect(contentBytes).toBeLessThanOrEqual(4000 + suffixBytes);
      expect(contentBytes).toBeGreaterThan(4000);
      // 截断点不切断多字节字符（无 U+FFFD）
      expect(content).not.toContain("\uFFFD");
    } finally {
      await srv.close();
    }
  });

  it("企微返回 errcode !== 0 → 抛错（含 errmsg）", async () => {
    const srv = await startServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook" }));
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await expect(exit.deliver("x")).rejects.toThrow("93000");
      await expect(exit.deliver("x")).rejects.toThrow("invalid webhook");
    } finally {
      await srv.close();
    }
  });

  it("网络层非 2xx → 抛错", async () => {
    const srv = await startServer((_body, res) => {
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

  it("mentions → content 末尾追加 <@userid>", async () => {
    let captured = "";
    const srv = await startServer((body, res) => {
      captured = body;
      okResponder(body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver({ content: "构建失败", mentions: ["zhangsan"] });
      const parsed = JSON.parse(captured);
      expect(parsed.markdown.content).toBe("构建失败\n<@zhangsan>");
    } finally {
      await srv.close();
    }
  });

  it("mentions 多人 → 空格分隔；content 为对象时先渲染再追加", async () => {
    let captured = "";
    const srv = await startServer((body, res) => {
      captured = body;
      okResponder(body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver({
        content: { status: "fail" },
        mentions: ["zhangsan", "lisi"],
      });
      const parsed = JSON.parse(captured);
      const content: string = parsed.markdown.content;
      expect(content.startsWith("```json\n")).toBe(true);
      expect(content.endsWith("\n<@zhangsan> <@lisi>")).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("mentions 忽略非字符串与空串；无 content 字段的对象不触发结构化分支", async () => {
    let captured = "";
    const srv = await startServer((body, res) => {
      captured = body;
      okResponder(body, res);
    });
    try {
      const exit = tool.bind({ url: srv.url });
      await exit.deliver({
        text: "hi",
        mentions: ["zhangsan", "", 42, null],
      });
      const parsed = JSON.parse(captured);
      expect(parsed.markdown.content).toBe(
        "```json\n" +
          JSON.stringify(
            { text: "hi", mentions: ["zhangsan", "", 42, null] },
            null,
            2,
          ) +
          "\n```",
      );
    } finally {
      await srv.close();
    }
  });
});
