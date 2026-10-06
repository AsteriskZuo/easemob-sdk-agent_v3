import { jest } from "@jest/globals";
import type { User } from "../src/index.js";
import {
  api,
  createMemberAndLogin,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

let server: TestServer;
let adminToken: string;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("POST /api/users + GET /api/users", () => {
  it("admin 建号 → 201 User（不含 password_hash）；列表含新用户", async () => {
    const res = await api(server, "POST", "/api/users", {
      token: adminToken,
      body: {
        username: "alice",
        display_name: "Alice",
        password: "alice-pass",
        role: "member",
      },
    });
    expect(res.status).toBe(201);
    const user = res.body as User & { password_hash?: string };
    expect(user.user_id).toMatch(/^usr_/);
    expect(user.username).toBe("alice");
    expect(user.role).toBe("member");
    expect(user.disabled).toBe(false);
    expect(user.password_hash).toBeUndefined();

    const list = await api(server, "GET", "/api/users", { token: adminToken });
    expect(list.status).toBe(200);
    const usernames = (list.body as User[]).map((u) => u.username);
    expect(usernames).toContain("admin");
    expect(usernames).toContain("alice");
  });

  it("username 重复 → 409 conflict；role 非法 → 400", async () => {
    const dup = await api(server, "POST", "/api/users", {
      token: adminToken,
      body: {
        username: "alice",
        display_name: "Alice2",
        password: "x-pass",
        role: "member",
      },
    });
    expect(dup.status).toBe(409);
    expect((dup.body as { error: { code: string } }).error.code).toBe(
      "conflict",
    );
    const badRole = await api(server, "POST", "/api/users", {
      token: adminToken,
      body: {
        username: "bob",
        display_name: "Bob",
        password: "b-pass",
        role: "superuser",
      },
    });
    expect(badRole.status).toBe(400);
  });

  it("member 访问用户管理 → 403", async () => {
    const member = await createMemberAndLogin(server, adminToken, "carol");
    const list = await api(server, "GET", "/api/users", {
      token: member.token,
    });
    expect(list.status).toBe(403);
    const create = await api(server, "POST", "/api/users", {
      token: member.token,
      body: {
        username: "dave",
        display_name: "Dave",
        password: "d-pass",
        role: "member",
      },
    });
    expect(create.status).toBe(403);
  });
});

describe("POST /api/users/:id/disabled", () => {
  it("admin 停用 member → 204；该用户登录 401；再启用 → 登录恢复", async () => {
    const member = await createMemberAndLogin(server, adminToken, "erin");
    const disable = await api(
      server,
      "POST",
      `/api/users/${member.user_id}/disabled`,
      { token: adminToken, body: { disabled: true } },
    );
    expect(disable.status).toBe(204);

    const login = await api(server, "POST", "/api/auth/login", {
      body: { username: "erin", password: "member-pass" },
    });
    expect(login.status).toBe(401);

    const enable = await api(
      server,
      "POST",
      `/api/users/${member.user_id}/disabled`,
      { token: adminToken, body: { disabled: false } },
    );
    expect(enable.status).toBe(204);
    const relogin = await api(server, "POST", "/api/auth/login", {
      body: { username: "erin", password: "member-pass" },
    });
    expect(relogin.status).toBe(201);
  });

  it("member 停用他人 → 403；停用自己（admin 自锁）→ 400；停用不存在用户 → 404", async () => {
    const member = await createMemberAndLogin(server, adminToken, "frank");
    const res = await api(
      server,
      "POST",
      `/api/users/${member.user_id}/disabled`,
      { token: member.token, body: { disabled: true } },
    );
    expect(res.status).toBe(403);

    const me = await api(server, "GET", "/api/auth/me", { token: adminToken });
    const adminId = (me.body as User).user_id;
    const selfLock = await api(
      server,
      "POST",
      `/api/users/${adminId}/disabled`,
      { token: adminToken, body: { disabled: true } },
    );
    expect(selfLock.status).toBe(400);

    const notFound = await api(
      server,
      "POST",
      "/api/users/usr_nonexistent/disabled",
      { token: adminToken, body: { disabled: true } },
    );
    expect(notFound.status).toBe(404);
  });

  it("disabled 字段类型错 → 400", async () => {
    const member = await createMemberAndLogin(server, adminToken, "grace");
    const res = await api(
      server,
      "POST",
      `/api/users/${member.user_id}/disabled`,
      { token: adminToken, body: { disabled: "yes" } },
    );
    expect(res.status).toBe(400);
  });
});
