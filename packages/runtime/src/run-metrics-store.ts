import type { Database } from "@asteriskzuo/agent-database";
import { logger } from "@asteriskzuo/agent-logger";
import { migrateRuntimeSchema } from "./env-provider.js";

/** 业务 metrics 按日聚合行（统计 API biz.* 族数据源；分日口径 = 服务器本地时区 date(ts,'localtime')） */
export interface DailyBizAggregate {
  date: string; // 日历日 YYYY-MM-DD（本地时区）
  key: string; // 指标名（run_metrics.key 原样）
  text_buckets: Record<string, number>; // 字符串值 → 出现次数（无字符串值为 {}）
  num_count: number; // 数值值行数（无数值值为 0）
  num_sum: number; // 数值值求和
}

/** 业务指标明细行：value_text / value_num 二选一折叠回单一 value */
export interface RunMetricEntry {
  key: string; // 指标名（run_metrics.key 原样）
  value: string | number; // value_text 非 NULL 取字符串，否则取 value_num
}

/** run_metrics 写口 + 按日聚合读口。record fail-open：内部 try/catch 消化 + warn，绝不抛回 */
export interface RunMetricsStore {
  /** 落一次 run 的全部 metrics（逐键一行）；metrics 为空对象时不写。
   *  ts = run 终态时刻（UTC ISO，由调用方取 markTerminal 同一时刻） */
  record(
    run_id: string,
    business_id: string,
    ts: string,
    metrics: Record<string, string | number>,
  ): void;

  /** 按日聚合（date(ts,'localtime') 分日，与 llm/runs 同口径）；from/to 为 YYYY-MM-DD 闭区间；
   *  返回按 (date, key) 升序。text 与 num 互斥分组：同一 key 混型时各自成组（防御，契约上不会发生） */
  dailyMetrics(
    business_id: string,
    from: string,
    to: string,
  ): DailyBizAggregate[];

  /** 单次 run 的业务指标明细（run 详情 API 数据源）；按 key 字典序升序 */
  listByRun(run_id: string): RunMetricEntry[];
}

interface RunMetricRow {
  key: string;
  value_text: string | null;
  value_num: number | null;
}

interface DailyTextRow {
  date: string;
  key: string;
  value_text: string;
  cnt: number;
}

interface DailyNumRow {
  date: string;
  key: string;
  num_count: number;
  num_sum: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** fail-open 告警：logger 未初始化（如单测/本地运行）时兜底 console.warn，告警自身也不抛错 */
function warnFailure(run_id: string, business_id: string, err: unknown): void {
  const message = "run_metrics 落库失败，已忽略（fail-open）";
  const fields = { run_id, business_id, error: errorMessage(err) };
  try {
    logger.for({ module: "run-metrics-store" }).warn(message, fields);
  } catch {
    console.warn(message, fields);
  }
}

/** 创建 run_metrics 表读写口（schema 迁移与 EnvProvider/LifecycleStore/LlmCallStore 共用 module 'runtime'，幂等） */
export function createRunMetricsStore(db: Database): RunMetricsStore {
  migrateRuntimeSchema(db);

  return {
    record(run_id, business_id, ts, metrics): void {
      const entries = Object.entries(metrics);
      if (entries.length === 0) return;
      try {
        for (const [key, value] of entries) {
          if (typeof value === "number") {
            db.run(
              "INSERT INTO run_metrics (run_id, business_id, ts, key, value_num) VALUES (?, ?, ?, ?, ?)",
              [run_id, business_id, ts, key, value],
            );
          } else {
            db.run(
              "INSERT INTO run_metrics (run_id, business_id, ts, key, value_text) VALUES (?, ?, ?, ?, ?)",
              [run_id, business_id, ts, key, value],
            );
          }
        }
      } catch (err) {
        warnFailure(run_id, business_id, err);
      }
    },

    dailyMetrics(business_id, from, to): DailyBizAggregate[] {
      // 字符串值与数值值分别聚合（同一 key 混型时各自成组，防御；契约上不会发生）
      const textRows = db.all<DailyTextRow>(
        `SELECT date(ts, 'localtime') AS date, key, value_text, COUNT(*) AS cnt
         FROM run_metrics
         WHERE business_id = ? AND value_text IS NOT NULL AND date(ts, 'localtime') BETWEEN ? AND ?
         GROUP BY date, key, value_text`,
        [business_id, from, to],
      );
      const numRows = db.all<DailyNumRow>(
        `SELECT date(ts, 'localtime') AS date, key, COUNT(*) AS num_count, SUM(value_num) AS num_sum
         FROM run_metrics
         WHERE business_id = ? AND value_num IS NOT NULL AND date(ts, 'localtime') BETWEEN ? AND ?
         GROUP BY date, key`,
        [business_id, from, to],
      );
      const byDateKey = new Map<string, DailyBizAggregate>();
      const ensure = (date: string, key: string): DailyBizAggregate => {
        const id = `${date}\x00${key}`;
        let agg = byDateKey.get(id);
        if (agg === undefined) {
          agg = { date, key, text_buckets: {}, num_count: 0, num_sum: 0 };
          byDateKey.set(id, agg);
        }
        return agg;
      };
      for (const row of textRows) {
        ensure(row.date, row.key).text_buckets[row.value_text] = row.cnt;
      }
      for (const row of numRows) {
        const agg = ensure(row.date, row.key);
        agg.num_count = row.num_count;
        agg.num_sum = row.num_sum;
      }
      return [...byDateKey.values()].sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.key.localeCompare(b.key),
      );
    },

    listByRun(run_id): RunMetricEntry[] {
      const rows = db.all<RunMetricRow>(
        "SELECT key, value_text, value_num FROM run_metrics WHERE run_id = ? ORDER BY key",
        [run_id],
      );
      return rows.map((row) => ({
        key: row.key,
        value: row.value_text !== null ? row.value_text : (row.value_num as number),
      }));
    },
  };
}
