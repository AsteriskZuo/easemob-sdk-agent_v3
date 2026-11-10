import type { Database } from "@asteriskzuo/agent-database";
import { migrateRuntimeSchema } from "./env-provider.js";

/** 生命周期业务标记状态（created 是瞬时态：插入即 running，不落中间行） */
export type LifecycleStatus =
  "created" | "running" | "success" | "failed" | "timeout";

/** 生命周期打标记录：lifecycle_id = run_id（一次执行 = 一个 run 目录 = 一条打标） */
export interface LifecycleRecord {
  lifecycle_id: string; // = run_id
  business_id: string; // 归属业务
  event_id: string; // 触发事件（关联键，回溯用）
  channel_id: string; // 业务通道（关联键）
  status: LifecycleStatus; // 业务标记
  created_at: string; // 执行开始（ISO）
  finished_at?: string; // 执行完结（ISO；running 时无）
  /** 失败阶段分类（check-input/main/check-output，契约设计 §5 三段编排）；
   *  仅失败的 run 有值；契约机制前的历史 run / 平台自身错误（runner 抛错）无此字段 */
  failed_at?: string;
}

/** run 按日聚合行（统计 API 数据源；分日口径 = 服务器本地时区 date(created_at,'localtime')） */
export interface DailyRunAggregate {
  date: string; // 日历日 YYYY-MM-DD（本地时区）
  total: number; // 当日 run 总数（含 running）
  success: number;
  failed: number;
  timeout: number;
  running: number; // 查询时点仍 running 的计数（正常应为 0，非 0 = crash 残留信号）
  /** 失败阶段分布：failed_at NULL 归 unknown（历史行与平台自身错误） */
  failed_phase: {
    "check-input": number;
    main: number;
    "check-output": number;
    unknown: number;
  };
  avg_duration_ms: number | null; // 当日已完结 run（success/failed/timeout 全含）平均耗时；无已完结 run 为 null
}

/** 打标读口（控制台任务监控用；最小集） */
export interface LifecycleStore {
  /** 按业务查执行记录，按 created_at 倒序；limit 缺省 50 */
  listByBusiness(business_id: string, limit?: number): LifecycleRecord[];
  get(lifecycle_id: string): LifecycleRecord | undefined;
  /** 按日聚合（统计 API 用）：from/to 为 YYYY-MM-DD 闭区间，按本地日历日过滤；
   *  返回按 date 升序；零数据日不出行 */
  dailyRuns(
    business_id: string,
    from: string,
    to: string,
  ): DailyRunAggregate[];
}

/** 打标写口：Lifecycle 内部用（读口之上的写面） */
export interface LifecycleWriter {
  /** 执行开始打标：一行插入即 running（created 是瞬时态，不落中间行） */
  markRunning(record: {
    lifecycle_id: string;
    business_id: string;
    event_id: string;
    channel_id: string;
    created_at: string;
  }): void;
  /** 终态打标：status + finished_at（+ 失败阶段分类 failed_at，成功/平台错误无） */
  markTerminal(
    lifecycle_id: string,
    status: "success" | "failed" | "timeout",
    failed_at?: string,
  ): void;
}

interface LifecycleRow {
  lifecycle_id: string;
  business_id: string;
  event_id: string;
  channel_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  failed_at: string | null;
}

function rowToRecord(row: LifecycleRow): LifecycleRecord {
  const record: LifecycleRecord = {
    lifecycle_id: row.lifecycle_id,
    business_id: row.business_id,
    event_id: row.event_id,
    channel_id: row.channel_id,
    status: row.status as LifecycleStatus,
    created_at: row.created_at,
  };
  if (row.finished_at !== null) record.finished_at = row.finished_at;
  if (row.failed_at !== null) record.failed_at = row.failed_at;
  return record;
}

interface DailyRunRow {
  date: string;
  total: number;
  success: number;
  failed: number;
  timeout: number;
  running: number;
  avg_duration_ms: number | null;
}

interface DailyFailedPhaseRow {
  date: string;
  phase: string;
  cnt: number;
}

/** 创建 lifecycles 表读写口（schema 迁移与 EnvProvider 共用 module 'runtime'，幂等） */
export function createLifecycleStore(
  db: Database,
): LifecycleStore & LifecycleWriter {
  migrateRuntimeSchema(db);

  return {
    markRunning(record): void {
      db.run(
        "INSERT INTO lifecycles (lifecycle_id, business_id, event_id, channel_id, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)",
        [
          record.lifecycle_id,
          record.business_id,
          record.event_id,
          record.channel_id,
          record.created_at,
        ],
      );
    },

    markTerminal(lifecycle_id, status, failed_at): void {
      db.run(
        "UPDATE lifecycles SET status = ?, finished_at = ?, failed_at = ? WHERE lifecycle_id = ?",
        [status, new Date().toISOString(), failed_at ?? null, lifecycle_id],
      );
    },

    listByBusiness(business_id: string, limit = 50): LifecycleRecord[] {
      const rows = db.all<LifecycleRow>(
        "SELECT lifecycle_id, business_id, event_id, channel_id, status, created_at, finished_at, failed_at FROM lifecycles WHERE business_id = ? ORDER BY created_at DESC LIMIT ?",
        [business_id, limit],
      );
      return rows.map(rowToRecord);
    },

    get(lifecycle_id: string): LifecycleRecord | undefined {
      const row = db.get<LifecycleRow>(
        "SELECT lifecycle_id, business_id, event_id, channel_id, status, created_at, finished_at, failed_at FROM lifecycles WHERE lifecycle_id = ?",
        [lifecycle_id],
      );
      return row ? rowToRecord(row) : undefined;
    },

    dailyRuns(business_id, from, to): DailyRunAggregate[] {
      const rows = db.all<DailyRunRow>(
        `SELECT date(created_at, 'localtime') AS date,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeout,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           AVG(CASE WHEN finished_at IS NOT NULL
               THEN (julianday(finished_at) - julianday(created_at)) * 86400000 END) AS avg_duration_ms
         FROM lifecycles
         WHERE business_id = ? AND date(created_at, 'localtime') BETWEEN ? AND ?
         GROUP BY date(created_at, 'localtime')
         ORDER BY date`,
        [business_id, from, to],
      );
      const phaseRows = db.all<DailyFailedPhaseRow>(
        `SELECT date(created_at, 'localtime') AS date, COALESCE(failed_at, 'unknown') AS phase, COUNT(*) AS cnt
         FROM lifecycles
         WHERE business_id = ? AND status = 'failed' AND date(created_at, 'localtime') BETWEEN ? AND ?
         GROUP BY date(created_at, 'localtime'), phase`,
        [business_id, from, to],
      );
      const phasesByDate = new Map<
        string,
        { "check-input": number; main: number; "check-output": number; unknown: number }
      >();
      for (const row of phaseRows) {
        const buckets = phasesByDate.get(row.date) ?? {
          "check-input": 0,
          main: 0,
          "check-output": 0,
          unknown: 0,
        };
        // 防御：三段之外的意外值归 unknown（正常只有 check-input/main/check-output）
        if (row.phase === "check-input" || row.phase === "main" || row.phase === "check-output") {
          buckets[row.phase] += row.cnt;
        } else {
          buckets.unknown += row.cnt;
        }
        phasesByDate.set(row.date, buckets);
      }
      return rows.map((row) => ({
        date: row.date,
        total: row.total,
        success: row.success,
        failed: row.failed,
        timeout: row.timeout,
        running: row.running,
        failed_phase: phasesByDate.get(row.date) ?? {
          "check-input": 0,
          main: 0,
          "check-output": 0,
          unknown: 0,
        },
        avg_duration_ms: row.avg_duration_ms,
      }));
    },
  };
}
