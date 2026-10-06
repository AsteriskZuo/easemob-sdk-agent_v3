import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { newUlid } from "@easemob/agent-contracts";
import { migrate } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";
import { logger } from "@easemob/agent-logger";
import { ApiError } from "./errors.js";

/** 账号角色：admin = 平台管理；member = 业务/资产操作者 */
export type Role = "admin" | "member";

/** 用户读面（password_hash 永不出接口） */
export interface User {
  /** 'usr_' + ULID */
  user_id: string;
  /** 登录名，唯一，创建后不可改 */
  username: string;
  /** 展示名，可改 */
  display_name: string;
  /** 角色 */
  role: Role;
  /** 停用不删行（历史业务 creator_id 仍指向它） */
  disabled: boolean;
  /** 创建时间（ISO） */
  created_at: string;
}

export interface AccountService {
  /** 登录：成功返回会话（token + expires_at），失败返回 null
   * （不区分"用户不存在/密码错/已停用"，防枚举） */
  login(
    username: string,
    password: string,
  ): { token: string; expires_at: string } | null;

  /** 每个请求经此识别操作者；token 无效/过期/用户已停用返回 undefined */
  resolve(token: string): User | undefined;

  /** 登出：删除会话；不存在幂等 */
  logout(token: string): void;

  /** 仅 admin：创建账号。username 重复抛 conflict */
  createUser(
    actor: User,
    input: {
      username: string;
      display_name: string;
      password: string;
      role: Role;
    },
  ): User;

  /** 仅 admin：列出全部用户 */
  listUsers(actor: User): User[];

  /** 仅 admin：停用/启用。不能停用自己（防自锁），试图停用最后一个启用中的 admin 抛错 */
  setDisabled(actor: User, user_id: string, disabled: boolean): void;

  /** 本人改密码（验旧密码，失败抛 invalid_input）；成功后该用户全部会话失效 */
  changePassword(actor: User, old_password: string, new_password: string): void;

  /** 首启注入首个 admin：users 表为空且入参给了账号密码 → 创建并返回 'created'；
   *  表非空 → 'skipped'；表空但无入参 → 'missing'（调用方记 error 日志，不阻断启动） */
  ensureBootstrapAdmin(input?: {
    username: string;
    password: string;
  }): "created" | "skipped" | "missing";
}

/** 存储迁移（module 'console-api'）：下标即版本号，v1 建 users + console_sessions */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
     user_id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     display_name TEXT NOT NULL,
     role TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     disabled INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE TABLE console_sessions (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );`,
];

// scrypt 参数（存储格式自包含：scrypt$N$r$p$saltHex$hashHex，参数演进时按行解析）
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** 会话固定 7 天，不滑动续期 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** 校验：按存储串内的参数重算 + timingSafeEqual 比较；格式不认得 = 不通过 */
function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface UserRow {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  password_hash: string;
  disabled: number;
  created_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    user_id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role as Role,
    disabled: row.disabled === 1,
    created_at: row.created_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 创建账号服务（建表经 migrate，幂等）。密码/hash/token 值永不进日志 */
export function createAccountService(db: Database): AccountService {
  migrate(db, "console-api", MIGRATIONS);
  const log = logger.for({ module: "console-api" });

  function getUserByUsername(username: string): UserRow | undefined {
    return db.get<UserRow>("SELECT * FROM users WHERE username = ?", [
      username,
    ]);
  }

  function getUserById(userId: string): UserRow | undefined {
    return db.get<UserRow>("SELECT * FROM users WHERE user_id = ?", [userId]);
  }

  function assertAdmin(actor: User): void {
    if (actor.role !== "admin") {
      throw new ApiError("forbidden", "仅 admin 可操作用户管理");
    }
  }

  function insertUser(input: {
    username: string;
    display_name: string;
    password: string;
    role: Role;
  }): User {
    if (input.username.length === 0) {
      throw new ApiError("invalid_input", "username 不能为空");
    }
    if (input.display_name.length === 0) {
      throw new ApiError("invalid_input", "display_name 不能为空");
    }
    if (input.password.length === 0) {
      throw new ApiError("invalid_input", "password 不能为空");
    }
    const row: UserRow = {
      user_id: `usr_${newUlid()}`,
      username: input.username,
      display_name: input.display_name,
      role: input.role,
      password_hash: hashPassword(input.password),
      disabled: 0,
      created_at: nowIso(),
    };
    db.run(
      "INSERT INTO users (user_id, username, display_name, role, password_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        row.user_id,
        row.username,
        row.display_name,
        row.role,
        row.password_hash,
        row.disabled,
        row.created_at,
      ],
    );
    return rowToUser(row);
  }

  return {
    login(username, password) {
      const row = getUserByUsername(username);
      if (
        row === undefined ||
        row.disabled === 1 ||
        !verifyPassword(password, row.password_hash)
      ) {
        // 不区分"用户不存在/密码错/已停用"（防枚举）；密码/hash 永不进日志
        log.info("登录失败", { username });
        return null;
      }
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      db.run(
        "INSERT INTO console_sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        [token, row.user_id, expiresAt],
      );
      log.info("登录成功", { user_id: row.user_id, username });
      return { token, expires_at: expiresAt };
    },

    resolve(token) {
      const session = db.get<{ user_id: string; expires_at: string }>(
        "SELECT user_id, expires_at FROM console_sessions WHERE token = ?",
        [token],
      );
      if (session === undefined) return undefined;
      if (session.expires_at <= nowIso()) {
        // 过期会话顺手清掉（懒清理，不设后台任务）
        db.run("DELETE FROM console_sessions WHERE token = ?", [token]);
        return undefined;
      }
      const row = getUserById(session.user_id);
      if (row === undefined || row.disabled === 1) return undefined;
      return rowToUser(row);
    },

    logout(token) {
      db.run("DELETE FROM console_sessions WHERE token = ?", [token]);
    },

    createUser(actor, input) {
      assertAdmin(actor);
      if (input.role !== "admin" && input.role !== "member") {
        throw new ApiError("invalid_input", `role 非法: ${String(input.role)}`);
      }
      if (getUserByUsername(input.username) !== undefined) {
        throw new ApiError("conflict", `username 已存在: ${input.username}`);
      }
      const user = insertUser(input);
      log.info("创建用户", {
        operator_id: actor.user_id,
        user_id: user.user_id,
        username: user.username,
        role: user.role,
      });
      return user;
    },

    listUsers(actor) {
      assertAdmin(actor);
      return db
        .all<UserRow>("SELECT * FROM users ORDER BY created_at, user_id")
        .map(rowToUser);
    },

    setDisabled(actor, user_id, disabled) {
      assertAdmin(actor);
      if (disabled && user_id === actor.user_id) {
        throw new ApiError("invalid_input", "不能停用自己（防自锁）");
      }
      const row = getUserById(user_id);
      if (row === undefined) {
        throw new ApiError("not_found", `用户不存在: ${user_id}`);
      }
      if (disabled && row.disabled === 0 && row.role === "admin") {
        const enabledAdmins = db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0",
        );
        if ((enabledAdmins?.n ?? 0) <= 1) {
          throw new ApiError("invalid_input", "不能停用最后一个启用中的 admin");
        }
      }
      db.run("UPDATE users SET disabled = ? WHERE user_id = ?", [
        disabled ? 1 : 0,
        user_id,
      ]);
      log.info(disabled ? "停用用户" : "启用用户", {
        operator_id: actor.user_id,
        user_id,
      });
    },

    changePassword(actor, old_password, new_password) {
      const row = getUserById(actor.user_id);
      if (
        row === undefined ||
        !verifyPassword(old_password, row.password_hash)
      ) {
        throw new ApiError("invalid_input", "旧密码不正确");
      }
      if (typeof new_password !== "string" || new_password.length === 0) {
        throw new ApiError("invalid_input", "new_password 不能为空");
      }
      db.transaction(() => {
        db.run("UPDATE users SET password_hash = ? WHERE user_id = ?", [
          hashPassword(new_password),
          actor.user_id,
        ]);
        // 改密后全部会话失效（含当前会话），需重新登录
        db.run("DELETE FROM console_sessions WHERE user_id = ?", [
          actor.user_id,
        ]);
      });
      log.info("修改密码", { user_id: actor.user_id });
    },

    ensureBootstrapAdmin(input) {
      const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
      if ((count?.n ?? 0) > 0) return "skipped";
      if (input === undefined) return "missing";
      const user = insertUser({
        username: input.username,
        display_name: input.username,
        password: input.password,
        role: "admin",
      });
      log.info("首启 admin 已注入", {
        user_id: user.user_id,
        username: user.username,
      });
      return "created";
    },
  };
}
