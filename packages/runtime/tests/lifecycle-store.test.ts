import { openDatabase } from "@asteriskzuo/agent-database";
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
