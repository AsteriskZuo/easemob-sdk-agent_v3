import { migrate } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";

/** 两桶环境配置（与 scheduler-loop-contracts §4 EnvConfig 同形） */
export interface EnvConfig {
  vars: Record<string, string>; // 普通桶：明文键值
  secrets: Record<string, string>; // 安全桶：运行时注入内存，不明文回显、不进日志
}

export interface EnvProvider {
  /** 组装上下文时取：通用层（scope=''）+ 业务层合并（业务优先）；secrets 仅在此时出库进内存 */
  getFor(business_id: string): EnvConfig;

  /** 控制台写入：upsert；business_id = null 表示通用层。secrets 只写不读明文（本接口无读明文出口） */
  set(
    business_id: string | null,
    bucket: "vars" | "secrets",
    key: string,
    value: string,
  ): void;

  /** 删除一个 key；不存在幂等 */
  remove(
    business_id: string | null,
    bucket: "vars" | "secrets",
    key: string,
  ): void;

  /** 控制台展示：vars 给明文键值；secrets 只给键名（掩码回显归控制台渲染） */
  list(business_id: string | null): {
    vars: Record<string, string>;
    secret_keys: string[];
  };
}

// 迁移 module 'runtime'：env_entries（两桶）+ lifecycles（打标表，Lifecycle 侧用，§5.2）。
// secrets 第一版明文存 platform.db（部署层靠文件权限保护）；纪律：不明文回显、不进日志
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE env_entries (
     scope TEXT NOT NULL,
     bucket TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (scope, bucket, key)
   );
   CREATE TABLE lifecycles (
     lifecycle_id TEXT PRIMARY KEY,
     business_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     finished_at TEXT
   );`,
];

/** runtime 模块 schema 迁移入口（EnvProvider 与 LifecycleStore 共用，幂等） */
export function migrateRuntimeSchema(db: Database): void {
  migrate(db, "runtime", MIGRATIONS);
}

interface EnvRow {
  scope: string;
  bucket: string;
  key: string;
  value: string;
}

// key 校验：非空、trim 后与原名一致（拒绝空白键）
function assertValidKey(key: string): void {
  if (key.length === 0 || key.trim() !== key) {
    throw new Error(`invalid_env_key: ${JSON.stringify(key)}`);
  }
}

/** 创建两桶环境配置读写口。业务级优先于通用级（同超时优先级规则） */
export function createEnvProvider(db: Database): EnvProvider {
  migrateRuntimeSchema(db);

  const scopeOf = (business_id: string | null): string => business_id ?? "";

  return {
    getFor(business_id: string): EnvConfig {
      // scope='' 字典序先于任何业务 id：先应用通用层，业务层后应用即覆盖（业务优先）
      const rows = db.all<EnvRow>(
        "SELECT scope, bucket, key, value FROM env_entries WHERE scope IN ('', ?) ORDER BY scope",
        [business_id],
      );
      const vars: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const row of rows) {
        if (row.bucket === "vars") {
          vars[row.key] = row.value;
        } else {
          secrets[row.key] = row.value;
        }
      }
      return { vars, secrets };
    },

    set(business_id, bucket, key, value): void {
      assertValidKey(key);
      db.run(
        "INSERT INTO env_entries (scope, bucket, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, bucket, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [scopeOf(business_id), bucket, key, value, new Date().toISOString()],
      );
    },

    remove(business_id, bucket, key): void {
      db.run(
        "DELETE FROM env_entries WHERE scope = ? AND bucket = ? AND key = ?",
        [scopeOf(business_id), bucket, key],
      );
    },

    list(business_id) {
      const rows = db.all<EnvRow>(
        "SELECT bucket, key, value FROM env_entries WHERE scope = ? ORDER BY key",
        [scopeOf(business_id)],
      );
      const vars: Record<string, string> = {};
      const secretKeys: string[] = [];
      for (const row of rows) {
        if (row.bucket === "vars") {
          vars[row.key] = row.value;
        } else {
          secretKeys.push(row.key);
        }
      }
      return { vars, secret_keys: secretKeys };
    },
  };
}
