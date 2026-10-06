import { jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";
import { initLogger, resetForTests } from "@easemob/agent-logger";
import { createAccountService } from "../src/accounts.js";
import type { AccountService, User } from "../src/accounts.js";

jest.setTimeout(30000);

/** 断言抛 ApiError 且 code 匹配（message 不含 code 串，不能靠 toThrow 正则） */
function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但未抛错`);
}

let db: Database;
let accounts: AccountService;
let admin: User;
let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), "console-api-accounts-logs-"));
  initLogger({ logsDir, enabled: false });
  db = openDatabase(":memory:");
  accounts = createAccountService(db);
  const result = accounts.ensureBootstrapAdmin({
    username: "admin",
    password: "admin-pass",
  });
  expect(result).toBe("created");
  const session = accounts.login("admin", "admin-pass") as { token: string };
  admin = accounts.resolve(session.token) as User;
});

afterEach(() => {
  db.close();
  resetForTests();
  rmSync(logsDir, { recursive: true, force: true });
});

function loginAs(username: string, password: string): User {
  const session = accounts.login(username, password) as { token: string };
  return accounts.resolve(session.token) as User;
}

describe("scrypt 存取往返", () => {
  it("建号后密码可登录；存储串自包含格式 scrypt$N$r$p$salt$hash，无明文", () => {
    expect(accounts.login("admin", "admin-pass")).not.toBeNull();
    const row = db.get<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE username = 'admin'",
    );
    expect(row?.password_hash).toMatch(
      /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/,
    );
    expect(row?.password_hash).not.toContain("admin-pass");
  });
});

describe("login 失败口径（防枚举）", () => {
  it("密码错 / 用户不存在 / 已停用 三者同返回 null", () => {
    expect(accounts.login("admin", "wrong-pass")).toBeNull();
    expect(accounts.login("no-such-user", "whatever")).toBeNull();

    const member = accounts.createUser(admin, {
      username: "m1",
      display_name: "M1",
      password: "m1-pass",
      role: "member",
    });
    accounts.setDisabled(admin, member.user_id, true);
    expect(accounts.login("m1", "m1-pass")).toBeNull();
  });
});

describe("resolve / logout", () => {
  it("有效 token → User；未知 token → undefined；过期 token → undefined 且会话被清", () => {
    const session = accounts.login("admin", "admin-pass") as {
      token: string;
    };
    expect(accounts.resolve(session.token)?.username).toBe("admin");
    expect(accounts.resolve("f".repeat(64))).toBeUndefined();

    // 手工落一条过期会话
    db.run(
      "INSERT INTO console_sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
      ["e".repeat(64), admin.user_id, new Date(0).toISOString()],
    );
    expect(accounts.resolve("e".repeat(64))).toBeUndefined();
    expect(
      db.get("SELECT token FROM console_sessions WHERE token = ?", [
        "e".repeat(64),
      ]),
    ).toBeUndefined();
  });

  it("logout → resolve 失效；重复 logout 幂等不报错", () => {
    const session = accounts.login("admin", "admin-pass") as {
      token: string;
    };
    accounts.logout(session.token);
    expect(accounts.resolve(session.token)).toBeUndefined();
    expect(() => accounts.logout(session.token)).not.toThrow();
  });

  it("停用后已有会话立即失效", () => {
    const member = accounts.createUser(admin, {
      username: "m2",
      display_name: "M2",
      password: "m2-pass",
      role: "member",
    });
    const session = accounts.login("m2", "m2-pass") as { token: string };
    accounts.setDisabled(admin, member.user_id, true);
    expect(accounts.resolve(session.token)).toBeUndefined();
  });
});

describe("createUser / listUsers 权限", () => {
  it("member 建号/列表 → forbidden；username 重复 → conflict；admin 列表按创建序", () => {
    const member = accounts.createUser(admin, {
      username: "m3",
      display_name: "M3",
      password: "m3-pass",
      role: "member",
    });
    expectCode(
      () =>
        accounts.createUser(member, {
          username: "x",
          display_name: "X",
          password: "x-pass",
          role: "member",
        }),
      "forbidden",
    );
    expectCode(() => accounts.listUsers(member), "forbidden");
    expectCode(
      () =>
        accounts.createUser(admin, {
          username: "m3",
          display_name: "M3b",
          password: "other-pass",
          role: "member",
        }),
      "conflict",
    );
    expect(accounts.listUsers(admin).map((u) => u.username)).toEqual([
      "admin",
      "m3",
    ]);
  });
});

describe("setDisabled 防自锁", () => {
  it("停用自己 → invalid_input；停用不存在用户 → not_found", () => {
    expectCode(
      () => accounts.setDisabled(admin, admin.user_id, true),
      "invalid_input",
    );
    expectCode(
      () => accounts.setDisabled(admin, "usr_nonexistent", true),
      "not_found",
    );
  });

  it("两个启用中的 admin 时可停其中一个；停用最后一个启用中的 admin → invalid_input", () => {
    accounts.createUser(admin, {
      username: "adminB",
      display_name: "AB",
      password: "ab-pass",
      role: "admin",
    });
    const adminB = loginAs("adminB", "ab-pass");
    // 两个启用中的 admin：adminB 停 admin 合法
    accounts.setDisabled(adminB, admin.user_id, true);
    expect(
      accounts.listUsers(adminB).find((u) => u.user_id === admin.user_id)
        ?.disabled,
    ).toBe(true);
    // adminB 是唯一启用中的 admin：再停用它（无论谁发起）→ invalid_input
    expectCode(
      () => accounts.setDisabled(adminB, adminB.user_id, true),
      "invalid_input",
    );
    expectCode(
      () => accounts.setDisabled(admin, adminB.user_id, true),
      "invalid_input",
    );
  });
});

describe("changePassword", () => {
  it("旧密码错 → invalid_input；成功后旧密码登录失败、全部会话失效、新密码可登录", () => {
    accounts.createUser(admin, {
      username: "m4",
      display_name: "M4",
      password: "old-pass",
      role: "member",
    });
    const s1 = accounts.login("m4", "old-pass") as { token: string };
    const s2 = accounts.login("m4", "old-pass") as { token: string };
    const m4 = accounts.resolve(s1.token) as User;

    expectCode(
      () => accounts.changePassword(m4, "wrong-old", "new-pass"),
      "invalid_input",
    );
    accounts.changePassword(m4, "old-pass", "new-pass");
    expect(accounts.resolve(s1.token)).toBeUndefined();
    expect(accounts.resolve(s2.token)).toBeUndefined();
    expect(accounts.login("m4", "old-pass")).toBeNull();
    expect(accounts.login("m4", "new-pass")).not.toBeNull();
  });
});

describe("ensureBootstrapAdmin 三分支", () => {
  it("表空无入参 → missing；表空有入参 → created；表非空 → skipped", () => {
    const db2 = openDatabase(":memory:");
    const a2 = createAccountService(db2);
    expect(a2.ensureBootstrapAdmin()).toBe("missing");
    expect(
      a2.ensureBootstrapAdmin({ username: "root", password: "root-pass" }),
    ).toBe("created");
    expect(
      a2.ensureBootstrapAdmin({ username: "root2", password: "root2-pass" }),
    ).toBe("skipped");
    expect(a2.login("root", "root-pass")).not.toBeNull();
    const root = a2.login("root", "root-pass") as { token: string };
    const rootUser = a2.resolve(root.token) as User;
    expect(a2.listUsers(rootUser)).toHaveLength(1);
    db2.close();
  });
});
