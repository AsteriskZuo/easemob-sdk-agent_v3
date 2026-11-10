/**
 * 统计页数据契约与纯函数（透视 / 补零 / 格式化）。
 * 契约 C：GET /api/stats/daily?business_id=&from=&to= → { business_id, from, to, rows }
 * （spec: docs/specs/2026-11-10-business-stats-spec.md §4.3/§4.4/§6；
 *  后端 T3 落地后 StatsRow 会进 console-api dto，届时可改为跨包引用）
 */

/** 统计长表行：控制台透视成二维表（行=date，列=metric/bucket） */
export interface StatsRow {
  /** 日历日 YYYY-MM-DD（服务器本地时区） */
  date: string;
  /** 指标名，族前缀 run.* / llm.* / biz.*（一期无 biz.*；出现即忽略） */
  metric: string;
  /** 维度桶；无维度指标恒 ""（如 run.failed_phase 的桶 = 阶段名） */
  bucket: string;
  /** 指标值（计数/求和/平均，由各指标定义） */
  value: number;
}

/** GET /api/stats/daily 响应（from/to 为生效区间回显） */
export interface StatsDailyResponse {
  business_id: string;
  from: string;
  to: string;
  rows: StatsRow[];
}

/** 失败阶段桶：契约固定四类（failed_at NULL 归 unknown），列稳定 */
export const FAILED_PHASES = [
  "check-input",
  "main",
  "check-output",
  "unknown",
] as const;
export type FailedPhase = (typeof FAILED_PHASES)[number];

/** 透视后的一日指标：计数/求和类缺省补 0（零数据日补零行）；
 *  平均类无数据为 null（不存在「0 天的平均」，展示为 -） */
export interface DayStats {
  date: string;
  run_total: number;
  run_success: number;
  run_failed: number;
  run_timeout: number;
  run_failed_phase: Record<FailedPhase, number>;
  run_avg_duration_ms: number | null;
  llm_calls: number;
  llm_tokens_input: number;
  llm_tokens_output: number;
  llm_tokens_cache_read: number;
  llm_tokens_cache_write: number;
  llm_cost: number;
  llm_avg_duration_ms: number | null;
  llm_calls_without_usage: number;
}

/** 零值日骨架（avg 类为 null） */
function emptyDay(date: string): DayStats {
  return {
    date,
    run_total: 0,
    run_success: 0,
    run_failed: 0,
    run_timeout: 0,
    run_failed_phase: { "check-input": 0, main: 0, "check-output": 0, unknown: 0 },
    run_avg_duration_ms: null,
    llm_calls: 0,
    llm_tokens_input: 0,
    llm_tokens_output: 0,
    llm_tokens_cache_read: 0,
    llm_tokens_cache_write: 0,
    llm_cost: 0,
    llm_avg_duration_ms: null,
    llm_calls_without_usage: 0,
  };
}

/** 逐日展开 [from, to] 闭区间（YYYY-MM-DD 升序；按 UTC 日推算，避开本地时区 DST 边界） */
export function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** 长表 → 二维表行集：[from, to] 逐日补齐（零数据日出零行），返回 date 倒序。
 *  未知指标与 biz.* 忽略（前端不发明指标，但兼容未来新增行）；llm.errors 不进主表（见 collectErrorDetails） */
export function pivotDaily(
  rows: StatsRow[],
  from: string,
  to: string,
): DayStats[] {
  const byDate = new Map<string, DayStats>();
  for (const row of rows) {
    if (row.metric.startsWith("biz.")) continue;
    let day = byDate.get(row.date);
    if (day === undefined) {
      day = emptyDay(row.date);
      byDate.set(row.date, day);
    }
    switch (row.metric) {
      case "run.total":
        day.run_total = row.value;
        break;
      case "run.success":
        day.run_success = row.value;
        break;
      case "run.failed":
        day.run_failed = row.value;
        break;
      case "run.timeout":
        day.run_timeout = row.value;
        break;
      case "run.failed_phase":
        if ((FAILED_PHASES as readonly string[]).includes(row.bucket)) {
          day.run_failed_phase[row.bucket as FailedPhase] = row.value;
        }
        break;
      case "run.avg_duration_ms":
        day.run_avg_duration_ms = row.value;
        break;
      case "llm.calls":
        day.llm_calls = row.value;
        break;
      case "llm.tokens.input":
        day.llm_tokens_input = row.value;
        break;
      case "llm.tokens.output":
        day.llm_tokens_output = row.value;
        break;
      case "llm.tokens.cache_read":
        day.llm_tokens_cache_read = row.value;
        break;
      case "llm.tokens.cache_write":
        day.llm_tokens_cache_write = row.value;
        break;
      case "llm.cost":
        day.llm_cost = row.value;
        break;
      case "llm.avg_duration_ms":
        day.llm_avg_duration_ms = row.value;
        break;
      case "llm.calls_without_usage":
        day.llm_calls_without_usage = row.value;
        break;
      default:
        break; // llm.errors / 未知指标：不进主表
    }
  }
  return eachDate(from, to)
    .map((date) => byDate.get(date) ?? emptyDay(date))
    .reverse();
}

/** 错误明细行：llm.errors 动态桶（date + 错误码 + 次数），主表之外单独展示 */
export interface ErrorDetail {
  date: string;
  error: string;
  count: number;
}

/** 提取 llm.errors 行，按 (date 倒序, 错误码字典序) 排序 */
export function collectErrorDetails(rows: StatsRow[]): ErrorDetail[] {
  return rows
    .filter((row) => row.metric === "llm.errors")
    .map((row) => ({ date: row.date, error: row.bucket, count: row.value }))
    .sort((a, b) =>
      a.date !== b.date ? b.date.localeCompare(a.date) : a.error.localeCompare(b.error),
    );
}

/** 千分位整数（token/计数）；手写分隔避免依赖运行环境 ICU */
export function formatThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 耗时 ms → s（保留 1 位小数）；null（当日无已完结样本）显示 - */
export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "-";
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 成本 USD（4 位小数，$ 前缀）；null 显示 - */
export function formatCost(usd: number | null): string {
  if (usd === null) return "-";
  return `$${usd.toFixed(4)}`;
}
