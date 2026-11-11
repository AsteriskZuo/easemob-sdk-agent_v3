import { openDatabase, migrate } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { createLifecycleStore } from "../src/index.js";
import type { LifecycleStore, LifecycleWriter } from "../src/index.js";

function newStore(): { store: LifecycleStore & LifecycleWriter; db: Database } {
  const db = openDatabase(":memory:");
  return { store: createLifecycleStore(db), db };
}

/** 本地时刻 → Date（验证 date(created_at,'localtime') 分日口径与时区无关的正确性） */
function localDate(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
): Date {
  return new Date(y, m - 1, d, h, mi);
}

function insertLifecycle(
  db: Database,
  row: {
    id: string;
    business_id?: string;
    status: string;
    created: Date;
    duration_ms?: number; // 缺省 = running（finished_at NULL）
    failed_at?: string | null;
  },
): void {
  db.run(
    "INSERT INTO lifecycles (lifecycle_id, business_id, event_id, channel_id, status, created_at, finished_at, failed_at) VALUES (?, ?, 'evt', 'ch', ?, ?, ?, ?)",
    [
      row.id,
      row.business_id ?? "b1",
      row.status,
      row.created.toISOString(),
      row.duration_ms === undefined
        ? null
        : new Date(row.created.getTime() + row.duration_ms).toISOString(),
      row.failed_at ?? null,
    ],
  );
}

describe("markRunning / markTerminal 往返", () => {
  it("running → 终态：状态、finished_at、failed_at 落库正确", () => {
    const { store, db } = newStore();
    store.markRunning({
      lifecycle_id: "run_1",
      business_id: "b1",
      event_id: "evt_1",
      channel_id: "ch",
      created_at: new Date().toISOString(),
    });
    expect(store.get("run_1")?.status).toBe("running");

    store.markTerminal("run_1", "failed", "main");
    const record = store.get("run_1");
    expect(record?.status).toBe("failed");
    expect(record?.finished_at).toBeDefined();
    expect(record?.failed_at).toBe("main");
    expect(store.listByBusiness("b1")).toHaveLength(1);
    db.close();
  });

  it("reason 落库：failed 带原因；不传 reason → NULL 映射缺省", () => {
    const { store, db } = newStore();
    store.markRunning({
      lifecycle_id: "run_1",
      business_id: "b1",
      event_id: "evt_1",
      channel_id: "ch",
      created_at: new Date().toISOString(),
    });
    store.markRunning({
      lifecycle_id: "run_2",
      business_id: "b1",
      event_id: "evt_2",
      channel_id: "ch",
      created_at: new Date().toISOString(),
    });
    store.markTerminal("run_1", "timeout", "main", "timeout (duration_ms=720000)");
    store.markTerminal("run_2", "success");

    const failed = store.get("run_1");
    expect(failed?.status).toBe("timeout");
    expect(failed?.reason).toBe("timeout (duration_ms=720000)");
    const ok = store.get("run_2");
    expect(ok?.status).toBe("success");
    expect(ok?.reason).toBeUndefined();
    db.close();
  });

  it("reason 超过 500 字符截断（防超长错误文本撑大行）", () => {
    const { store, db } = newStore();
    store.markRunning({
      lifecycle_id: "run_1",
      business_id: "b1",
      event_id: "evt_1",
      channel_id: "ch",
      created_at: new Date().toISOString(),
    });
    const longReason = "x".repeat(600);
    store.markTerminal("run_1", "failed", "main", longReason);
    const record = store.get("run_1");
    expect(record?.reason).toHaveLength(500);
    expect(record?.reason).toBe(longReason.slice(0, 500));
    db.close();
  });
});

describe("迁移 v5", () => {
  it("v4 老库升级：旧行 reason 为 NULL（读口映射缺省），数据保留", () => {
    const db = openDatabase(":memory:");
    // 模拟 v4 老库：应用前四版迁移（SQL 与 env-provider v1–v4 同形）
    migrate(db, "runtime", [
      `CREATE TABLE env_entries (
         scope TEXT NOT NULL, bucket TEXT NOT NULL, key TEXT NOT NULL,
         value TEXT NOT NULL, updated_at TEXT NOT NULL,
         PRIMARY KEY (scope, bucket, key)
       );
       CREATE TABLE lifecycles (
         lifecycle_id TEXT PRIMARY KEY, business_id TEXT NOT NULL,
         event_id TEXT NOT NULL, channel_id TEXT NOT NULL, status TEXT NOT NULL,
         created_at TEXT NOT NULL, finished_at TEXT
       );`,
      `ALTER TABLE lifecycles ADD COLUMN failed_at TEXT;`,
      `CREATE TABLE llm_calls (
         id            INTEGER PRIMARY KEY,
         run_id        TEXT NOT NULL,
         business_id   TEXT NOT NULL,
         ts            TEXT NOT NULL,
         op            TEXT NOT NULL,
         model         TEXT NOT NULL,
         skills        TEXT NOT NULL,
         mode          TEXT NOT NULL,
         ok            INTEGER NOT NULL,
         error         TEXT,
         duration_ms   INTEGER NOT NULL,
         input_tokens  INTEGER,
         output_tokens INTEGER,
         cache_read_tokens  INTEGER,
         cache_write_tokens INTEGER,
         total_tokens  INTEGER,
         cost_total    REAL
       );
       CREATE INDEX idx_llm_calls_biz_ts ON llm_calls (business_id, ts);
       CREATE INDEX idx_llm_calls_run ON llm_calls (run_id);`,
      `CREATE TABLE run_metrics (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id      TEXT NOT NULL,
         business_id TEXT NOT NULL,
         ts          TEXT NOT NULL,
         key         TEXT NOT NULL,
         value_text  TEXT,
         value_num   REAL
       );
       CREATE INDEX idx_run_metrics_biz_ts ON run_metrics (business_id, ts);`,
    ]);
    db.run(
      "INSERT INTO lifecycles (lifecycle_id, business_id, event_id, channel_id, status, created_at) VALUES ('run_old', 'b1', 'evt', 'ch', 'success', '2026-01-01T00:00:00.000Z')",
    );

    const store = createLifecycleStore(db);
    // 旧行保留且 reason 缺省（NULL）
    const old = store.get("run_old");
    expect(old).toBeDefined();
    expect(old?.status).toBe("success");
    expect(old?.reason).toBeUndefined();
    const raw = db.get<{ reason: string | null }>(
      "SELECT reason FROM lifecycles WHERE lifecycle_id = 'run_old'",
    );
    expect(raw?.reason).toBeNull();
    const version = db.get<{ max_version: number }>(
      "SELECT MAX(version) AS max_version FROM schema_migrations WHERE module = 'runtime'",
    );
    expect(version?.max_version).toBe(5);
    db.close();
  });
});

describe("listByBusinessOnDate", () => {
  it("本地日历日口径过滤 + created_at 倒序；其他业务/其他日不混入", () => {
    const { store, db } = newStore();
    insertLifecycle(db, {
      id: "run_1",
      status: "success",
      created: localDate(2026, 1, 15, 10, 0),
      duration_ms: 1000,
    });
    insertLifecycle(db, {
      id: "run_2",
      status: "failed",
      created: localDate(2026, 1, 15, 23, 30), // 跨时区边界：本地日仍归 01-15
      duration_ms: 2000,
      failed_at: "main",
    });
    insertLifecycle(db, {
      id: "run_3",
      status: "success",
      created: localDate(2026, 1, 16, 0, 30), // 次日：不应命中 01-15
      duration_ms: 1000,
    });
    insertLifecycle(db, {
      id: "run_other",
      business_id: "b2",
      status: "success",
      created: localDate(2026, 1, 15, 12, 0),
      duration_ms: 1000,
    });

    const rows = store.listByBusinessOnDate("b1", "2026-01-15");
    expect(rows.map((r) => r.lifecycle_id)).toEqual(["run_2", "run_1"]); // 倒序
    expect(store.listByBusinessOnDate("b1", "2026-01-16")).toHaveLength(1);
    expect(store.listByBusinessOnDate("b1", "2026-02-01")).toEqual([]);
    db.close();
  });

  it("防御上限 500 行", () => {
    const { store, db } = newStore();
    const base = localDate(2026, 1, 15, 0, 0).getTime();
    for (let i = 0; i < 501; i++) {
      db.run(
        "INSERT INTO lifecycles (lifecycle_id, business_id, event_id, channel_id, status, created_at) VALUES (?, 'b1', 'evt', 'ch', 'success', ?)",
        [`run_${i}`, new Date(base + i * 1000).toISOString()],
      );
    }
    const rows = store.listByBusinessOnDate("b1", "2026-01-15");
    expect(rows).toHaveLength(500);
    // 倒序取前 500：最新一条在最前
    expect(rows[0]!.lifecycle_id).toBe("run_500");
    db.close();
  });
});

describe("dailyRuns 聚合", () => {
  function seed(db: Database): void {
    // d1 = 2026-01-15（本地日）：success / failed(main) / timeout / running 各一
    insertLifecycle(db, {
      id: "run_s",
      status: "success",
      created: localDate(2026, 1, 15, 10, 0),
      duration_ms: 60000,
    });
    insertLifecycle(db, {
      id: "run_f",
      status: "failed",
      created: localDate(2026, 1, 15, 23, 30), // 跨时区边界：本地日仍归 01-15
      duration_ms: 120000,
      failed_at: "main",
    });
    insertLifecycle(db, {
      id: "run_t",
      status: "timeout",
      created: localDate(2026, 1, 15, 12, 0),
      duration_ms: 180000,
    });
    insertLifecycle(db, {
      id: "run_r",
      status: "running",
      created: localDate(2026, 1, 15, 13, 0),
    });
    // d2 = 2026-01-16（本地日）：三个 failed，failed_at 分别命中 check-input / check-output / NULL(unknown)
    insertLifecycle(db, {
      id: "run_f2",
      status: "failed",
      created: localDate(2026, 1, 16, 9, 0),
      duration_ms: 30000,
      failed_at: "check-input",
    });
    insertLifecycle(db, {
      id: "run_f3",
      status: "failed",
      created: localDate(2026, 1, 16, 10, 0),
      duration_ms: 30000,
      failed_at: "check-output",
    });
    insertLifecycle(db, {
      id: "run_f4",
      status: "failed",
      created: localDate(2026, 1, 16, 11, 0),
      duration_ms: 30000,
      failed_at: null, // 历史行/平台自身错误 → unknown 桶
    });
    // 其他业务：不应混入
    insertLifecycle(db, {
      id: "run_other",
      business_id: "b2",
      status: "success",
      created: localDate(2026, 1, 15, 10, 0),
      duration_ms: 1000,
    });
  }

  it("状态计数、failed_phase 分桶（含 unknown）、avg 含 timeout 且排除 running", () => {
    const { store, db } = newStore();
    seed(db);
    const rows = store.dailyRuns("b1", "2026-01-15", "2026-01-16");
    expect(rows).toHaveLength(2);

    const d1 = rows[0]!;
    expect(d1.date).toBe("2026-01-15");
    expect(d1.total).toBe(4);
    expect(d1.success).toBe(1);
    expect(d1.failed).toBe(1);
    expect(d1.timeout).toBe(1);
    expect(d1.running).toBe(1);
    expect(d1.failed_phase).toEqual({
      "check-input": 0,
      main: 1,
      "check-output": 0,
      unknown: 0,
    });
    // avg 含 success/failed/timeout 三个已完结 run，不含 running
    // （julianday 浮点换算有亚毫秒级误差，精度放到毫秒位）
    expect(d1.avg_duration_ms).toBeCloseTo((60000 + 120000 + 180000) / 3, 0);

    const d2 = rows[1]!;
    expect(d2.date).toBe("2026-01-16");
    expect(d2.total).toBe(3);
    expect(d2.failed).toBe(3);
    expect(d2.failed_phase).toEqual({
      "check-input": 1,
      main: 0,
      "check-output": 1,
      unknown: 1,
    });
    expect(d2.avg_duration_ms).toBeCloseTo(30000, 0);
    db.close();
  });

  it("区间过滤与本地日口径：边界行落在本地日历日", () => {
    const { store, db } = newStore();
    seed(db);
    const d1Only = store.dailyRuns("b1", "2026-01-15", "2026-01-15");
    expect(d1Only).toHaveLength(1);
    expect(d1Only[0]!.total).toBe(4);
    const d2Only = store.dailyRuns("b1", "2026-01-16", "2026-01-16");
    expect(d2Only).toHaveLength(1);
    expect(d2Only[0]!.total).toBe(3);
    db.close();
  });

  it("零数据日不出行；无已完结 run 的日子 avg 为 null", () => {
    const { store, db } = newStore();
    insertLifecycle(db, {
      id: "run_r1",
      status: "running",
      created: localDate(2026, 1, 17, 8, 0),
    });
    const rows = store.dailyRuns("b1", "2026-01-15", "2026-01-20");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-01-17");
    expect(rows[0]!.total).toBe(1);
    expect(rows[0]!.running).toBe(1);
    expect(rows[0]!.avg_duration_ms).toBeNull();
    expect(store.dailyRuns("b1", "2026-02-01", "2026-02-14")).toEqual([]);
    db.close();
  });
});
