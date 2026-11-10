import type { Database } from "@asteriskzuo/agent-database";
import { logger } from "@asteriskzuo/agent-logger";
import { migrateRuntimeSchema } from "./env-provider.js";

/** LLM 调用统计用量（pi Usage 的一对一映射；调用方未提取到 usage 时整组缺省，落库为 NULL） */
export interface LlmCallUsage {
  input_tokens: number; // 输入 token 数
  output_tokens: number; // 输出 token 数
  cache_read_tokens: number; // 缓存命中 token 数
  cache_write_tokens: number; // 缓存写入 token 数
  total_tokens: number; // 总 token 数
  cost_total: number; // pi 调用时点上报的成本（USD；模型无价表时为 0，best-effort）
}

/** LLM 调用统计入参。结构对齐 agent-service 的 LlmCallSink.record 入参（契约 A）：
 *  本包不 import agent-service，靠结构兼容（与 AgentSessionMapping 同纪律） */
export interface LlmCallRecord {
  run_id: string; // 归属 run（= lifecycles.lifecycle_id）
  business_id: string; // 冗余落列，免 join 聚合
  ts: string; // 调用结束时刻（UTC ISO）
  op: "agent"; // v1 恒 'agent'（compact 不采集）
  model: string; // 请求生效模型（provider/id）
  skills: string[]; // 请求选中 skill 名（落库为 JSON 数组字符串；v1 只落库不出指标）
  mode: "channel" | "fresh"; // 会话模式
  ok: boolean; // true = 调用成功；false = 失败
  error?: string; // 失败错误码首段（如 agent_failed）；ok=true 时缺省
  duration_ms: number; // op 墙钟耗时
  usage?: LlmCallUsage; // 缺省 = usage 提取失败/模型未上报，token 字段整组 NULL
}

/** LLM 调用按日聚合行（统计 API 数据源；分日口径 = 服务器本地时区 date(ts,'localtime')） */
export interface DailyLlmAggregate {
  date: string; // 日历日 YYYY-MM-DD（本地时区）
  calls: number; // agent op 次数（含失败行）
  errors: Record<string, number>; // ok=0 行按 error 分桶计数；error 缺失归 "unknown" 桶
  input_tokens: number; // 以下 5 项 = 有 usage 行的求和；无 usage 行不计入（不视为 0）
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number; // 有 usage 行的 cost_total 求和（USD）
  calls_without_usage: number; // 成功但 usage 缺失（提取失败/模型未上报）的行计数——数据质量指标；失败行本来就不带 usage，不计
  avg_duration_ms: number | null; // 全部行（含失败）平均耗时；当日无行为 null
}

/** LLM 调用统计口：写（fail-open sink）+ 按日聚合读（console-api 经此不裸写 SQL） */
export interface LlmCallStore {
  /** 落一行调用统计。fail-open：内部消化一切异常（warn 日志），绝不抛回——agent op 不因统计失败 */
  record(call: LlmCallRecord): void;
  /** 按日聚合：from/to 为 YYYY-MM-DD 闭区间，按本地日历日过滤；返回按 date 升序；零数据日不出行 */
  dailyCalls(
    business_id: string,
    from: string,
    to: string,
  ): DailyLlmAggregate[];
}

interface DailyCallRow {
  date: string;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_total: number | null;
  calls_without_usage: number;
  avg_duration_ms: number | null;
}

interface DailyErrorRow {
  date: string;
  error: string;
  cnt: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** fail-open 告警：logger 未初始化（如单测/本地运行）时兜底 console.warn，告警自身也不抛错 */
function warnFailure(call: LlmCallRecord, err: unknown): void {
  const message = "llm_calls 落库失败，已忽略（fail-open）";
  const fields = {
    run_id: call.run_id,
    business_id: call.business_id,
    error: errorMessage(err),
  };
  try {
    logger.for({ module: "llm-call-store" }).warn(message, fields);
  } catch {
    console.warn(message, fields);
  }
}

/** 创建 llm_calls 表读写口（schema 迁移与 EnvProvider/LifecycleStore 共用 module 'runtime'，幂等） */
export function createLlmCallStore(db: Database): LlmCallStore {
  migrateRuntimeSchema(db);

  return {
    record(call): void {
      try {
        db.run(
          `INSERT INTO llm_calls (run_id, business_id, ts, op, model, skills, mode, ok, error, duration_ms,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            call.run_id,
            call.business_id,
            call.ts,
            call.op,
            call.model,
            JSON.stringify(call.skills),
            call.mode,
            call.ok ? 1 : 0,
            call.error ?? null,
            call.duration_ms,
            call.usage?.input_tokens ?? null,
            call.usage?.output_tokens ?? null,
            call.usage?.cache_read_tokens ?? null,
            call.usage?.cache_write_tokens ?? null,
            call.usage?.total_tokens ?? null,
            call.usage?.cost_total ?? null,
          ],
        );
      } catch (err) {
        warnFailure(call, err);
      }
    },

    dailyCalls(business_id, from, to): DailyLlmAggregate[] {
      const rows = db.all<DailyCallRow>(
        `SELECT date(ts, 'localtime') AS date,
           COUNT(*) AS calls,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(cost_total), 0) AS cost_total,
           SUM(CASE WHEN ok = 1 AND total_tokens IS NULL THEN 1 ELSE 0 END) AS calls_without_usage,
           AVG(duration_ms) AS avg_duration_ms
         FROM llm_calls
         WHERE business_id = ? AND date(ts, 'localtime') BETWEEN ? AND ?
         GROUP BY date(ts, 'localtime')
         ORDER BY date`,
        [business_id, from, to],
      );
      const errorRows = db.all<DailyErrorRow>(
        `SELECT date(ts, 'localtime') AS date, COALESCE(error, 'unknown') AS error, COUNT(*) AS cnt
         FROM llm_calls
         WHERE business_id = ? AND ok = 0 AND date(ts, 'localtime') BETWEEN ? AND ?
         GROUP BY date(ts, 'localtime'), error`,
        [business_id, from, to],
      );
      const errorsByDate = new Map<string, Record<string, number>>();
      for (const row of errorRows) {
        const buckets = errorsByDate.get(row.date) ?? {};
        buckets[row.error] = row.cnt;
        errorsByDate.set(row.date, buckets);
      }
      return rows.map((row) => ({
        date: row.date,
        calls: row.calls,
        errors: errorsByDate.get(row.date) ?? {},
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cache_read_tokens: row.cache_read_tokens ?? 0,
        cache_write_tokens: row.cache_write_tokens ?? 0,
        total_tokens: row.total_tokens ?? 0,
        cost_total: row.cost_total ?? 0,
        calls_without_usage: row.calls_without_usage,
        avg_duration_ms: row.avg_duration_ms,
      }));
    },
  };
}
