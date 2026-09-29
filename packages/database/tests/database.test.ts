import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/index.js";
import type { Database } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-database-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("database 基础读写", () => {
  it("run + get 往返：建表、插入、读回一致", () => {
    const db = openDatabase(":memory:");
    db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO items (id, name) VALUES (?, ?)", [1, "alpha"]);
    const row = db.get<{ id: number; name: string }>(
      "SELECT id, name FROM items WHERE id = ?",
      [1],
    );
    expect(row).toEqual({ id: 1, name: "alpha" });
    db.close();
  });

  it("all 读多行", () => {
    const db = openDatabase(":memory:");
    db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO items (id, name) VALUES (?, ?)", [1, "a"]);
    db.run("INSERT INTO items (id, name) VALUES (?, ?)", [2, "b"]);
    const rows = db.all<{ id: number; name: string }>(
      "SELECT id, name FROM items ORDER BY id",
    );
    expect(rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    db.close();
  });

  it("get 无行返回 undefined", () => {
    const db = openDatabase(":memory:");
    db.run("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    expect(db.get("SELECT id FROM items WHERE id = ?", [999])).toBeUndefined();
    db.close();
  });

  it("exec 多语句一次执行成功", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TABLE b (id INTEGER PRIMARY KEY);
      INSERT INTO a (id) VALUES (1);
      INSERT INTO b (id) VALUES (2);
    `);
    expect(db.get<{ id: number }>("SELECT id FROM a")).toEqual({ id: 1 });
    expect(db.get<{ id: number }>("SELECT id FROM b")).toEqual({ id: 2 });
    db.close();
  });

  it("openDatabase 父目录不存在时自动创建", () => {
    const dbPath = join(tmpDir, "nested", "deep", "test.db");
    const db = openDatabase(dbPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();
  });
});

describe("transaction", () => {
  it("提交：fn 内多步写入提交后可见，并返回 fn 的返回值", () => {
    const db = openDatabase(":memory:");
    db.run("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    const result = db.transaction(() => {
      db.run("INSERT INTO items (id) VALUES (?)", [1]);
      db.run("INSERT INTO items (id) VALUES (?)", [2]);
      return "done";
    });
    expect(result).toBe("done");
    expect(db.all("SELECT id FROM items ORDER BY id")).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    db.close();
  });

  it("回滚：fn 抛错则数据不落库，错误原样抛出", () => {
    const db = openDatabase(":memory:");
    db.run("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    const boom = new Error("boom");
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO items (id) VALUES (?)", [1]);
        throw boom;
      }),
    ).toThrow(boom);
    expect(db.all("SELECT id FROM items")).toEqual([]);
    db.close();
  });

  it("嵌套 transaction 抛错", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db.transaction(() => {
        db.transaction(() => {});
      }),
    ).toThrow();
    db.close();
  });
});

describe("持久化与关闭", () => {
  it("写入 → close → 重新打开同路径 → 数据仍在", () => {
    const dbPath = join(tmpDir, "persist.db");
    const db1 = openDatabase(dbPath);
    db1.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db1.run("INSERT INTO items (id, name) VALUES (?, ?)", [1, "persisted"]);
    db1.close();

    const db2 = openDatabase(dbPath);
    expect(
      db2.get<{ id: number; name: string }>(
        "SELECT id, name FROM items WHERE id = ?",
        [1],
      ),
    ).toEqual({ id: 1, name: "persisted" });
    db2.close();
  });

  it("close 幂等：连调两次不抛错", () => {
    const db = openDatabase(":memory:");
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe("migrate", () => {
  const MIGRATIONS_V1 = [
    "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)",
  ];
  const MIGRATIONS_V2 = [
    ...MIGRATIONS_V1,
    "ALTER TABLE things ADD COLUMN note TEXT",
  ];

  function appliedVersions(db: Database, module: string): number[] {
    return db
      .all<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE module = ? ORDER BY version",
        [module],
      )
      .map((row) => row.version);
  }

  it("首次调用：全部迁移按序应用，schema_migrations 登记完整", () => {
    const db = openDatabase(":memory:");
    migrate(db, "things", MIGRATIONS_V2);
    expect(appliedVersions(db, "things")).toEqual([1, 2]);
    expect(
      db.get<{ name: string }>(
        "SELECT name FROM pragma_table_info('things') WHERE name = 'note'",
      ),
    ).toEqual({ name: "note" });
    db.close();
  });

  it("重复调用：幂等，已应用版本不重复执行", () => {
    const db = openDatabase(":memory:");
    migrate(db, "things", MIGRATIONS_V2);
    migrate(db, "things", MIGRATIONS_V2);
    expect(appliedVersions(db, "things")).toEqual([1, 2]);
    db.close();
  });

  it("增量：先在 v1 状态下 migrate，追加 v2 后再 migrate 只应用 v2", () => {
    const db = openDatabase(":memory:");
    migrate(db, "things", MIGRATIONS_V1);
    db.run("INSERT INTO things (id, name) VALUES (?, ?)", [1, "old"]);
    migrate(db, "things", MIGRATIONS_V2);
    expect(appliedVersions(db, "things")).toEqual([1, 2]);
    expect(
      db.get<{ id: number; name: string; note: string | null }>(
        "SELECT id, name, note FROM things WHERE id = 1",
      ),
    ).toEqual({ id: 1, name: "old", note: null });
    db.close();
  });

  it("失败回滚：非法 SQL 抛错、该版本不登记、之前版本保持已登记", () => {
    const db = openDatabase(":memory:");
    migrate(db, "things", MIGRATIONS_V1);
    expect(() =>
      migrate(db, "things", [...MIGRATIONS_V1, "THIS IS NOT SQL"]),
    ).toThrow();
    expect(appliedVersions(db, "things")).toEqual([1]);
    db.close();
  });

  it("多模块隔离：模块 A、B 各自的迁移列表互不影响", () => {
    const db = openDatabase(":memory:");
    migrate(db, "a", ["CREATE TABLE ta (id INTEGER PRIMARY KEY)"]);
    migrate(db, "b", [
      "CREATE TABLE tb (id INTEGER PRIMARY KEY)",
      "ALTER TABLE tb ADD COLUMN extra TEXT",
    ]);
    expect(appliedVersions(db, "a")).toEqual([1]);
    expect(appliedVersions(db, "b")).toEqual([1, 2]);
    expect(
      db.get<{ name: string }>(
        "SELECT name FROM pragma_table_info('tb') WHERE name = 'extra'",
      ),
    ).toEqual({ name: "extra" });
    db.close();
  });
});
