import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createRunMetricsStore } from "../src/index.js";
import type { RunMetricsStore } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runtime-run-metrics-test-"));
  initLogger({ logsDir: join(tmpDir, "logs"), enabled: false });
});

afterEach(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

function newStore(): { store: RunMetricsStore; db: Database } {
  const db = openDatabase(":memory:");
  return { store: createRunMetricsStore(db), db };
}

/** 本地时刻 → UTC ISO（验证 date(ts,'localtime') 分日口径与时区无关的正确性） */
function isoAtLocal(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
): string {
  return new Date(y, m - 1, d, h, mi).toISOString();
}

describe("建表与迁移", () => {
  it("重复 createRunMetricsStore 幂等（迁移只应用一次）", () => {
    const db = openDatabase(":memory:");
    createRunMetricsStore(db);
    createRunMetricsStore(db);
    const row = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM schema_migrations WHERE module = 'runtime'",
    );
    expect(row?.cnt).toBe(4);
    db.close();
  });

  it("v3 老库升级：旧数据保留，v4 追加 run_metrics", () => {
    const db = openDatabase(":memory:");
    // 模拟 v3 老库：只应用前三版迁移（SQL 与 env-provider v1/v2/v3 同形）
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
    ]);
    db.run(
      "INSERT INTO lifecycles (lifecycle_id, business_id, event_id, channel_id, status, created_at) VALUES ('run_old', 'b1', 'evt', 'ch', 'success', '2026-01-01T00:00:00.000Z')",
    );

    const store = createRunMetricsStore(db);
    store.record("run_1", "b1", isoAtLocal(2026, 1, 15, 10, 0), {
      decision: "approved",
      latency_ms: 1200,
    });
    expect(store.dailyMetrics("b1", "2026-01-15", "2026-01-15")).toHaveLength(2);
    // 老库数据保留
    const old = db.get<{ lifecycle_id: string }>(
      "SELECT lifecycle_id FROM lifecycles WHERE lifecycle_id = 'run_old'",
    );
    expect(old?.lifecycle_id).toBe("run_old");
    const version = db.get<{ max_version: number }>(
      "SELECT MAX(version) AS max_version FROM schema_migrations WHERE module = 'runtime'",
    );
    expect(version?.max_version).toBe(4);
    // 索引存在
    const idx = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_run_metrics_biz_ts'",
    );
    expect(idx?.name).toBe("idx_run_metrics_biz_ts");
    db.close();
  });
});

describe("record", () => {
  it("逐键一行：string → value_text，number → value_num", () => {
    const { store, db } = newStore();
    store.record("run_1", "b1", "2026-01-15T02:00:00.000Z", {
      decision: "approved",
      latency_ms: 1200,
    });
    const rows = db.all<Record<string, unknown>>(
      "SELECT run_id, business_id, ts, key, value_text, value_num FROM run_metrics ORDER BY key",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      run_id: "run_1",
      business_id: "b1",
      ts: "2026-01-15T02:00:00.000Z",
      key: "decision",
      value_text: "approved",
      value_num: null,
    });
    expect(rows[1]).toMatchObject({
      run_id: "run_1",
      business_id: "b1",
      ts: "2026-01-15T02:00:00.000Z",
      key: "latency_ms",
      value_text: null,
      value_num: 1200,
    });
    db.close();
  });

  it("metrics 为空对象时不写任何行", () => {
    const { store, db } = newStore();
    store.record("run_1", "b1", "2026-01-15T02:00:00.000Z", {});
    const row = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM run_metrics",
    );
    expect(row?.cnt).toBe(0);
    db.close();
  });

  it("写库异常被消化（fail-open）：db 已关闭也不抛错", () => {
    const { store, db } = newStore();
    db.close();
    expect(() =>
      store.record("run_1", "b1", "2026-01-15T02:00:00.000Z", {
        decision: "approved",
      }),
    ).not.toThrow();
  });
});

describe("dailyMetrics 聚合", () => {
  function seed(store: RunMetricsStore): void {
    // d1 = 2026-01-15（本地日）：decision 两次 approved 一次 rejected；latency_ms 两次
    store.record("run_a", "b1", isoAtLocal(2026, 1, 15, 10, 0), {
      decision: "approved",
      latency_ms: 1000,
    });
    store.record("run_b", "b1", isoAtLocal(2026, 1, 15, 23, 30), {
      decision: "approved",
      latency_ms: 2000,
    });
    store.record("run_c", "b1", isoAtLocal(2026, 1, 15, 12, 0), {
      decision: "rejected",
    });
    // d2 = 2026-01-16（本地日）：00:30 行验证本地日归属（UTC 日可能是 01-15）
    store.record("run_d", "b1", isoAtLocal(2026, 1, 16, 0, 30), {
      decision: "rejected",
      latency_ms: 500,
    });
    // 其他业务：不应混入
    store.record("run_e", "b2", isoAtLocal(2026, 1, 15, 10, 0), {
      decision: "approved",
      latency_ms: 9999,
    });
  }

  it("字符串分桶计数 + 数值 count/sum；返回按 (date, key) 升序", () => {
    const { store, db } = newStore();
    seed(store);
    const rows = store.dailyMetrics("b1", "2026-01-15", "2026-01-16");
    expect(rows.map((r) => [r.date, r.key])).toEqual([
      ["2026-01-15", "decision"],
      ["2026-01-15", "latency_ms"],
      ["2026-01-16", "decision"],
      ["2026-01-16", "latency_ms"],
    ]);

    const d1Decision = rows[0]!;
    expect(d1Decision.text_buckets).toEqual({ approved: 2, rejected: 1 });
    expect(d1Decision.num_count).toBe(0);
    expect(d1Decision.num_sum).toBe(0);

    const d1Latency = rows[1]!;
    expect(d1Latency.text_buckets).toEqual({});
    expect(d1Latency.num_count).toBe(2);
    expect(d1Latency.num_sum).toBe(3000);

    const d2Decision = rows[2]!;
    expect(d2Decision.text_buckets).toEqual({ rejected: 1 });

    const d2Latency = rows[3]!;
    expect(d2Latency.num_count).toBe(1);
    expect(d2Latency.num_sum).toBe(500);
    db.close();
  });

  it("同一 key 混型：字符串值与数值值各自成组（防御）", () => {
    const { store, db } = newStore();
    // 绕过 record 类型契约直接落混型行（契约上不会发生，store 读口须防御）
    db.run(
      "INSERT INTO run_metrics (run_id, business_id, ts, key, value_text) VALUES ('run_x', 'b1', ?, 'mixed', 'foo')",
      [isoAtLocal(2026, 1, 15, 10, 0)],
    );
    db.run(
      "INSERT INTO run_metrics (run_id, business_id, ts, key, value_num) VALUES ('run_y', 'b1', ?, 'mixed', 42)",
      [isoAtLocal(2026, 1, 15, 11, 0)],
    );
    const rows = store.dailyMetrics("b1", "2026-01-15", "2026-01-15");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text_buckets).toEqual({ foo: 1 });
    expect(rows[0]!.num_count).toBe(1);
    expect(rows[0]!.num_sum).toBe(42);
    db.close();
  });

  it("跨日边界：23:30 不串到次日、00:30 不串到前日（本地日历日口径）", () => {
    const { store, db } = newStore();
    seed(store);
    const d1Only = store.dailyMetrics("b1", "2026-01-15", "2026-01-15");
    expect(d1Only).toHaveLength(2);
    expect(d1Only[0]!.text_buckets).toEqual({ approved: 2, rejected: 1 });
    const d2Only = store.dailyMetrics("b1", "2026-01-16", "2026-01-16");
    expect(d2Only).toHaveLength(2);
    expect(d2Only[0]!.text_buckets).toEqual({ rejected: 1 });
    db.close();
  });

  it("零数据区间返回空数组（零数据日不出行）", () => {
    const { store, db } = newStore();
    seed(store);
    expect(store.dailyMetrics("b1", "2026-02-01", "2026-02-14")).toEqual([]);
    db.close();
  });
});
