import { jest } from "@jest/globals";
import { api, resetTestLogger, startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("请求体解析", () => {
  it("非法 JSON → 400 invalid_input", async () => {
    const res = await api(server, "POST", "/api/auth/login", {
      rawBody: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: "invalid_input", message: "请求体不是合法 JSON" },
    });
  });

  it("body 超 1MB → 413 payload_too_large", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await api(server, "POST", "/api/auth/login", {
      rawBody: big,
    });
    expect(res.status).toBe(413);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );
  });

  it("未知路由 → 404 not_found（错误体格式统一）", async () => {
    const res = await api(server, "GET", "/api/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "not_found" } });
  });

  it("受保护路由未登录 → 401（错误体格式统一）", async () => {
    const res = await api(server, "GET", "/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: "unauthenticated", message: "未登录或会话已失效" },
    });
  });
});

describe("未捕获异常", () => {
  it("下游抛出未识别异常 → 500 internal，message 统一「内部错误」不外泄细节", async () => {
    const isolated = await startTestServer({
      bootstrap_admin: { username: "admin", password: "admin-pass" },
    });
    try {
      // 关掉 db：会话解析抛 node:sqlite 原生错误（未识别 → internal）
      isolated.db.close();
      const res = await api(isolated, "GET", "/api/auth/me", {
        token: "a".repeat(64),
      });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: "internal", message: "内部错误" },
      });
    } finally {
      // db 已关，stop 里 close 幂等
      await isolated.stop();
    }
  });
});
