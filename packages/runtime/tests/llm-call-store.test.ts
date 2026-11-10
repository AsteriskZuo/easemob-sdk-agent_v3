import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createLlmCallStore } from "../src/index.js";
import type { LlmCallRecord, LlmCallStore } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runtime-llm-call-test-"));
  initLogger({ logsDir: join(tmpDir, "logs"), enabled: false });
});

afterEach(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

function newStore(): { store: LlmCallStore; db: Database } {
  const db = openDatabase(":memory:");
  return { store: createLlmCallStore(db), db };
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

function baseCall(overrides: Partial<LlmCallRecord>): LlmCallRecord {
  return {
    run_id: "run_1",
    business_id: "b1",
    ts: isoAtLocal(2026, 1, 15, 10, 0),
    op: "agent",
    model: "openai/gpt-5",
    skills: ["jira-ticket-review"],
    mode: "channel",
    ok: true,
    duration_ms: 1000,
    ...overrides,
  };
}

describe("建表与迁移", () => {
  it("重复 createLlmCallStore 幂等（迁移只应用一次）", () => {
    const db = openDatabase(":memory:");
    createLlmCallStore(db);
    createLlmCallStore(db);
    const row = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM schema_migrations WHERE module = 'runtime'",
    );
    expect(row?.cnt).toBe(3);
    db.close();
  });

  it("v2 老库升级：旧数据保留，v3 追加 llm_calls", () => {
    const db = openDatabase(":memory:");
    // 模拟 v2 老库：只应用前两版迁移（SQL 与 env-provider v1/v2 同形）
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
    ]);
    db.run(
      "INSERT INTO lifecycles (lifecycle_id, business_id, event_id, channel_id, status, created_at) VALUES ('run_old', 'b1', 'evt', 'ch', 'success', '2026-01-01T00:00:00.000Z')",
    );

    const store = createLlmCallStore(db);
    store.record(baseCall({}));
    expect(store.dailyCalls("b1", "2026-01-15", "2026-01-15")).toHaveLength(1);
    // 老库数据保留
    const old = db.get<{ lifecycle_id: string }>(
      "SELECT lifecycle_id FROM lifecycles WHERE lifecycle_id = 'run_old'",
    );
    expect(old?.lifecycle_id).toBe("run_old");
    const version = db.get<{ max_version: number }>(
      "SELECT MAX(version) AS max_version FROM schema_migrations WHERE module = 'runtime'",
    );
    expect(version?.max_version).toBe(3);
    db.close();
  });
});

describe("record", () => {
  it("带 usage 成功行：字段齐全落库", () => {
    const { store, db } = newStore();
    store.record(
      baseCall({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 10,
          cache_write_tokens: 5,
          total_tokens: 165,
          cost_total: 0.0123,
        },
      }),
    );
    const row = db.get<Record<string, unknown>>("SELECT * FROM llm_calls");
    expect(row).toMatchObject({
      run_id: "run_1",
      business_id: "b1",
      op: "agent",
      model: "openai/gpt-5",
      skills: '["jira-ticket-review"]',
      mode: "channel",
      ok: 1,
      error: null,
      duration_ms: 1000,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      total_tokens: 165,
    });
    expect(row?.cost_total).toBeCloseTo(0.0123);
    db.close();
  });

  it("失败行：ok=0 + error 首段，usage 缺省整组 NULL", () => {
    const { store, db } = newStore();
    store.record(
      baseCall({ ok: false, error: "agent_failed", duration_ms: 500 }),
    );
    const row = db.get<Record<string, unknown>>("SELECT * FROM llm_calls");
    expect(row).toMatchObject({
      ok: 0,
      error: "agent_failed",
      duration_ms: 500,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
      cost_total: null,
    });
    db.close();
  });

  it("写库异常被消化（fail-open）：db 已关闭也不抛错", () => {
    const { store, db } = newStore();
    db.close();
    expect(() => store.record(baseCall({}))).not.toThrow();
  });
});

describe("dailyCalls 聚合", () => {
  function seed(store: LlmCallStore): void {
    // d1 = 2026-01-15（本地日）：2 成功带 usage + 2 失败无 usage（不同错误码）
    store.record(
      baseCall({
        run_id: "run_a",
        ts: isoAtLocal(2026, 1, 15, 10, 0),
        duration_ms: 1000,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 10,
          cache_write_tokens: 5,
          total_tokens: 165,
          cost_total: 0.01,
        },
      }),
    );
    store.record(
      baseCall({
        run_id: "run_b",
        ts: isoAtLocal(2026, 1, 15, 23, 30), // 跨时区边界：本地日仍归 01-15
        duration_ms: 3000,
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_tokens: 20,
          cache_write_tokens: 10,
          total_tokens: 330,
          cost_total: 0.02,
        },
      }),
    );
    store.record(
      baseCall({
        run_id: "run_c",
        ts: isoAtLocal(2026, 1, 15, 12, 0),
        ok: false,
        error: "agent_failed",
        duration_ms: 500,
      }),
    );
    store.record(
      baseCall({
        run_id: "run_d",
        ts: isoAtLocal(2026, 1, 15, 13, 0),
        ok: false,
        error: "input_too_large",
        duration_ms: 100,
      }),
    );
    // d2 = 2026-01-16（本地日）：1 成功 + 1 失败；00:30 行验证本地日归属（UTC 日可能是 01-15）
    store.record(
      baseCall({
        run_id: "run_e",
        ts: isoAtLocal(2026, 1, 16, 0, 30),
        duration_ms: 2000,
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 60,
          cost_total: 0.005,
        },
      }),
    );
    store.record(
      baseCall({
        run_id: "run_f",
        ts: isoAtLocal(2026, 1, 16, 9, 0),
        ok: false,
        error: "model_not_allowed",
        duration_ms: 200,
      }),
    );
    // 其他业务：不应混入
    store.record(
      baseCall({
        run_id: "run_g",
        business_id: "b2",
        ts: isoAtLocal(2026, 1, 15, 10, 0),
        usage: {
          input_tokens: 999,
          output_tokens: 999,
          cache_read_tokens: 999,
          cache_write_tokens: 999,
          total_tokens: 999,
          cost_total: 9.99,
        },
      }),
    );
  }

  it("各字段聚合：token 只求和有 usage 行、错误分桶、avg 含失败行", () => {
    const { store, db } = newStore();
    seed(store);
    const rows = store.dailyCalls("b1", "2026-01-15", "2026-01-16");
    expect(rows).toHaveLength(2);

    const d1 = rows[0]!;
    expect(d1.date).toBe("2026-01-15");
    expect(d1.calls).toBe(4);
    expect(d1.errors).toEqual({ agent_failed: 1, input_too_large: 1 });
    expect(d1.input_tokens).toBe(300);
    expect(d1.output_tokens).toBe(150);
    expect(d1.cache_read_tokens).toBe(30);
    expect(d1.cache_write_tokens).toBe(15);
    expect(d1.total_tokens).toBe(495);
    expect(d1.cost_total).toBeCloseTo(0.03);
    expect(d1.calls_without_usage).toBe(0); // 失败行不带 usage 是设计使然，不计数据质量
    expect(d1.avg_duration_ms).toBeCloseTo((1000 + 3000 + 500 + 100) / 4);

    const d2 = rows[1]!;
    expect(d2.date).toBe("2026-01-16");
    expect(d2.calls).toBe(2);
    expect(d2.errors).toEqual({ model_not_allowed: 1 });
    expect(d2.total_tokens).toBe(60);
    expect(d2.calls_without_usage).toBe(0);
    expect(d2.avg_duration_ms).toBeCloseTo(1100);
    db.close();
  });

  it("成功但 usage 缺失的行计入 calls_without_usage（数据质量信号）", () => {
    const { store, db } = newStore();
    store.record(
      baseCall({ run_id: "run_h", ts: isoAtLocal(2026, 1, 15, 10, 0) }),
    );
    const rows = store.dailyCalls("b1", "2026-01-15", "2026-01-15");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls).toBe(1);
    expect(rows[0]!.calls_without_usage).toBe(1);
    db.close();
  });

  it("区间过滤与本地日口径：边界行落在本地日历日", () => {
    const { store, db } = newStore();
    seed(store);
    const d1Only = store.dailyCalls("b1", "2026-01-15", "2026-01-15");
    expect(d1Only).toHaveLength(1);
    expect(d1Only[0]!.calls).toBe(4);
    // 23:30（d1 本地）不串到 d2；00:30（d2 本地）不串到 d1
    const d2Only = store.dailyCalls("b1", "2026-01-16", "2026-01-16");
    expect(d2Only).toHaveLength(1);
    expect(d2Only[0]!.calls).toBe(2);
    db.close();
  });

  it("零数据区间返回空数组（零数据日不出行）", () => {
    const { store, db } = newStore();
    seed(store);
    expect(store.dailyCalls("b1", "2026-02-01", "2026-02-14")).toEqual([]);
    db.close();
  });
});
