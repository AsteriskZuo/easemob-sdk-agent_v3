import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

/** 全平台唯一数据访问口：SQLite 薄封装（同步 API，刻意不做 ORM / 连接池） */
export interface Database {
  /** 写（INSERT/UPDATE/DELETE/DDL 单语句） */
  run(sql: string, params?: unknown[]): void;
  /** 多语句执行（无参数），供迁移与建表用 */
  exec(sql: string): void;
  /** 读一行；无行返回 undefined */
  get<T>(sql: string, params?: unknown[]): T | undefined;
  /** 读多行 */
  all<T>(sql: string, params?: unknown[]): T[];
  /** 事务：BEGIN IMMEDIATE 包裹 fn；fn 抛错则 ROLLBACK 并把错误原样抛出 */
  transaction<T>(fn: () => T): T;
  /** 关闭连接（幂等） */
  close(): void;
}

class SqliteDatabase implements Database {
  private readonly db: DatabaseSync;
  private closed = false; // close 幂等标记
  private inTransaction = false; // 嵌套事务防护标记（嵌套直接抛错，fail-fast 暴露误用）

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL"); // WAL：读写不互堵
    this.db.exec("PRAGMA busy_timeout = 5000"); // 锁等待兜底 5 秒
  }

  run(sql: string, params: unknown[] = []): void {
    // 接口上保持 unknown[]，内部适配 node:sqlite 的 SQLInputValue[]
    this.db.prepare(sql).run(...(params as SQLInputValue[]));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as
      T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      throw new Error("transaction: 不支持嵌套事务");
    }
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}

/** 打开（不存在则创建）一个 SQLite 数据库文件；父目录自动创建 */
export function openDatabase(path: string): Database {
  return new SqliteDatabase(path);
}

/** 最小迁移原语：按模块名管理版本化 schema 演进。
 *  migrations 是有序 SQL 列表，下标即版本号（migrations[0] = v1 以此类推）；
 *  已应用的版本跳过，未应用的按序在各自事务内执行并登记 */
export function migrate(
  db: Database,
  module: string,
  migrations: readonly string[],
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  module TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (module, version)
)`);
  const row = db.get<{ max_version: number | null }>(
    "SELECT MAX(version) AS max_version FROM schema_migrations WHERE module = ?",
    [module],
  );
  const appliedVersion = row?.max_version ?? 0;
  for (
    let version = appliedVersion + 1;
    version <= migrations.length;
    version++
  ) {
    const sql = migrations[version - 1];
    db.transaction(() => {
      db.exec(sql);
      db.run(
        "INSERT INTO schema_migrations (module, version, applied_at) VALUES (?, ?, ?)",
        [module, version, new Date().toISOString()],
      );
    });
  }
}
