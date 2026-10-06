import { jest } from "@jest/globals";
import type { User } from "../src/index.js";
import {
  api,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
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

describe("POST /api/auth/login", () => {
  it("成功 → 201 {user, expires_at} + Set-Cookie（HttpOnly/Path/Max-Age/SameSite）", async () => {
    const res = await api(server, "POST", "/api/auth/login", {
      body: { username: "admin", password: "admin-pass" },
    });
    expect(res.status).toBe(201);
    const body = res.body as { user: User; expires_at: string };
    expect(body.user.username).toBe("admin");
    expect(body.user.role).toBe("admin");
    expect(body.user.user_id).toMatch(/^usr_/);
    expect(typeof body.expires_at).toBe("string");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("agent_console_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=604800");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("密码错 → 401「用户名或密码错误」（统一口径）", async () => {
    const res = await api(server, "POST", "/api/auth/login", {
      body: { username: "admin", password: "wrong" },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: "unauthenticated", message: "用户名或密码错误" },
    });
  });

  it("缺字段 → 400", async () => {
    const res = await api(server, "POST", "/api/auth/login", {
      body: { username: "admin" },
    });
    expect(res.status).toBe(400);
  });
});

describe("cookie 认证全链路", () => {
  it("登录 → cookie 访问 /api/auth/me → 200 当前用户", async () => {
    const token = await loginToken(server, "admin", "admin-pass");
    const res = await api(server, "GET", "/api/auth/me", { token });
    expect(res.status).toBe(200);
    expect((res.body as User).username).toBe("admin");
  });

  it("未登录访问受保护路由 → 401；伪造 token → 401", async () => {
    for (const path of [
      "/api/users",
      "/api/businesses",
      "/api/assets",
      "/api/env/global",
      "/api/config",
      "/api/exit-tools",
      "/api/monitor/queues",
    ]) {
      const res = await api(server, "GET", path);
      expect(res.status).toBe(401);
    }
    const forged = await api(server, "GET", "/api/auth/me", {
      token: "b".repeat(64),
    });
    expect(forged.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("登出 → 204 + 清 cookie；旧 token 随之 401", async () => {
    const token = await loginToken(server, "admin", "admin-pass");
    const res = await api(server, "POST", "/api/auth/logout", { token });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    const after = await api(server, "GET", "/api/auth/me", { token });
    expect(after.status).toBe(401);
  });
});

describe("POST /api/auth/change-password", () => {
  it("改密 → 204；旧 token 失效；旧密码登录 401；新密码可登录", async () => {
    // 专用服务隔离（改密会影响 admin 会话）
    const isolated = await startTestServer({
      bootstrap_admin: { username: "root", password: "root-pass" },
    });
    try {
      const token = await loginToken(isolated, "root", "root-pass");
      const res = await api(isolated, "POST", "/api/auth/change-password", {
        token,
        body: { old_password: "root-pass", new_password: "new-pass" },
      });
      expect(res.status).toBe(204);
      const me = await api(isolated, "GET", "/api/auth/me", { token });
      expect(me.status).toBe(401);
      const oldLogin = await api(isolated, "POST", "/api/auth/login", {
        body: { username: "root", password: "root-pass" },
      });
      expect(oldLogin.status).toBe(401);
      const newToken = await loginToken(isolated, "root", "new-pass");
      expect(newToken).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await isolated.stop();
    }
  });

  it("旧密码错 → 400", async () => {
    const token = await loginToken(server, "admin", "admin-pass");
    const res = await api(server, "POST", "/api/auth/change-password", {
      token,
      body: { old_password: "wrong", new_password: "x" },
    });
    expect(res.status).toBe(400);
  });
});
