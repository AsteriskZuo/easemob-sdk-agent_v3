import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type {
  DailyBizAggregate,
  DailyLlmAggregate,
  DailyRunAggregate,
  LifecycleStore,
  LlmCallStore,
  RunMetricsStore,
} from "@asteriskzuo/agent-runtime";
import type { DailyStatsResponse, StatsRow } from "./dto.js";
import { ApiError } from "./errors.js";
import { sendJson } from "./http.js";
import type { HttpRequest } from "./http.js";
import type { Route } from "./router.js";

/** 查询区间上限（含端点的日历日数；防全表扫，spec §6） */
const MAX_RANGE_DAYS = 92;

/** 缺省区间：to = 今天、from = 13 天前（共 14 天，spec §6） */
const DEFAULT_FROM_OFFSET_DAYS = -13;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 字符串桶基数护栏（决策 4）：单日单指标 distinct 桶上限，超出部分合并进 __other__ */
const MAX_TEXT_BUCKETS = 20;

/** 护栏合并桶名（决策 4） */
const OTHER_BUCKET = "__other__";

/** UTC 零点时刻回写成 YYYY-MM-DD（用于回绕校验：2026-02-30 会被 Date 吞成 03-02，必须拦下） */
function utcDateString(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 校验 YYYY-MM-DD 日历日（形状 + 真实存在性）；非法 → 400 invalid_input */
function parseDateParam(raw: string, field: string): string {
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (
    !DATE_PATTERN.test(raw) ||
    Number.isNaN(ms) ||
    utcDateString(ms) !== raw
  ) {
    throw new ApiError(
      "invalid_input",
      `${field} 必须是合法的 YYYY-MM-DD: ${raw}`,
    );
  }
  return raw;
}

/** 本地日历日（offsetDays 相对今天）；与聚合读口 date(...,'localtime') 的分日口径一致 */
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 解析生效区间：from/to 可缺省；from > to 或超上限 → 400 */
function parseRange(req: HttpRequest): { from: string; to: string } {
  const rawTo = req.query.get("to");
  const rawFrom = req.query.get("from");
  const to = rawTo === null ? localDate(0) : parseDateParam(rawTo, "to");
  const from =
    rawFrom === null
      ? localDate(DEFAULT_FROM_OFFSET_DAYS)
      : parseDateParam(rawFrom, "from");
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  if (spanDays < 0) {
    throw new ApiError("invalid_input", `from 不能晚于 to: ${from} > ${to}`);
  }
  if (spanDays + 1 > MAX_RANGE_DAYS) {
    throw new ApiError(
      "invalid_input",
      `查询区间上限 ${MAX_RANGE_DAYS} 天: ${from} ~ ${to}`,
    );
  }
  return { from, to };
}

/** DailyRunAggregate → 长表行（契约 C）：
 *  failed_phase 四桶 0 也出行（保证二维表列稳定）；avg_duration_ms 为 null 不出行 */
function runRows(agg: DailyRunAggregate): StatsRow[] {
  const rows: StatsRow[] = [
    { date: agg.date, metric: "run.total", bucket: "", value: agg.total },
    { date: agg.date, metric: "run.success", bucket: "", value: agg.success },
    { date: agg.date, metric: "run.failed", bucket: "", value: agg.failed },
    { date: agg.date, metric: "run.timeout", bucket: "", value: agg.timeout },
    { date: agg.date, metric: "run.running", bucket: "", value: agg.running },
  ];
  for (const phase of [
    "check-input",
    "main",
    "check-output",
    "unknown",
  ] as const) {
    rows.push({
      date: agg.date,
      metric: "run.failed_phase",
      bucket: phase,
      value: agg.failed_phase[phase],
    });
  }
  if (agg.avg_duration_ms !== null) {
    rows.push({
      date: agg.date,
      metric: "run.avg_duration_ms",
      bucket: "",
      value: agg.avg_duration_ms,
    });
  }
  return rows;
}

/** DailyLlmAggregate → 长表行（契约 C）：
 *  avg_duration_ms 为 null 不出行；errors 按错误码逐桶出行（无错误不出行） */
function llmRows(agg: DailyLlmAggregate): StatsRow[] {
  const rows: StatsRow[] = [
    { date: agg.date, metric: "llm.calls", bucket: "", value: agg.calls },
    { date: agg.date, metric: "llm.cost", bucket: "", value: agg.cost_total },
    {
      date: agg.date,
      metric: "llm.calls_without_usage",
      bucket: "",
      value: agg.calls_without_usage,
    },
    {
      date: agg.date,
      metric: "llm.tokens.input",
      bucket: "",
      value: agg.input_tokens,
    },
    {
      date: agg.date,
      metric: "llm.tokens.output",
      bucket: "",
      value: agg.output_tokens,
    },
    {
      date: agg.date,
      metric: "llm.tokens.cache_read",
      bucket: "",
      value: agg.cache_read_tokens,
    },
    {
      date: agg.date,
      metric: "llm.tokens.cache_write",
      bucket: "",
      value: agg.cache_write_tokens,
    },
    {
      date: agg.date,
      metric: "llm.tokens.total",
      bucket: "",
      value: agg.total_tokens,
    },
  ];
  if (agg.avg_duration_ms !== null) {
    rows.push({
      date: agg.date,
      metric: "llm.avg_duration_ms",
      bucket: "",
      value: agg.avg_duration_ms,
    });
  }
  for (const [code, count] of Object.entries(agg.errors)) {
    rows.push({
      date: agg.date,
      metric: "llm.errors",
      bucket: code,
      value: count,
    });
  }
  return rows;
}

/** DailyBizAggregate → 长表行（契约 F）：
 *  字符串桶逐值出行（metric = biz.<key>，bucket = 值原样）；distinct 桶 > 20 时按计数降序
 *  （计数相同按 bucket 值字典序）取前 20，其余合并为一行 __other__（计数求和）——基数护栏在映射层（决策 4）；
 *  数值 num_count > 0 出 sum/avg/count 三行（bucket 均为 ""，avg = sum/count），num_count = 0 一行都不出 */
function bizRows(agg: DailyBizAggregate): StatsRow[] {
  const rows: StatsRow[] = [];
  const metric = `biz.${agg.key}`;
  const entries = Object.entries(agg.text_buckets);
  let kept = entries;
  let otherCount = 0;
  if (entries.length > MAX_TEXT_BUCKETS) {
    const sorted = [...entries].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    );
    kept = sorted.slice(0, MAX_TEXT_BUCKETS);
    for (const [, count] of sorted.slice(MAX_TEXT_BUCKETS)) {
      otherCount += count;
    }
  }
  for (const [bucket, count] of kept) {
    rows.push({ date: agg.date, metric, bucket, value: count });
  }
  if (otherCount > 0) {
    rows.push({ date: agg.date, metric, bucket: OTHER_BUCKET, value: otherCount });
  }
  if (agg.num_count > 0) {
    rows.push(
      { date: agg.date, metric: `${metric}.sum`, bucket: "", value: agg.num_sum },
      {
        date: agg.date,
        metric: `${metric}.avg`,
        bucket: "",
        value: agg.num_sum / agg.num_count,
      },
      {
        date: agg.date,
        metric: `${metric}.count`,
        bucket: "",
        value: agg.num_count,
      },
    );
  }
  return rows;
}

/** 统计路由（只读，登录即可）。
 *  llmCalls 缺省 = 降级：校验照常，rows 恒空（options.llm_calls 未装配时的过渡形态）；
 *  runMetrics 缺省 = 降级：不出 biz.* 行（run.* 与 llm.* 照常） */
export function statsRoutes(deps: {
  lifecycle: LifecycleStore;
  llmCalls?: LlmCallStore;
  runMetrics?: RunMetricsStore;
  registry: BusinessRegistry;
}): Route[] {
  const { lifecycle, llmCalls, runMetrics, registry } = deps;
  return [
    {
      method: "GET",
      pattern: "/api/stats/daily",
      handler: (req, res) => {
        const businessId = req.query.get("business_id");
        if (businessId === null || businessId === "") {
          throw new ApiError("invalid_input", "business_id 必填");
        }
        if (registry.getProfile(businessId) === undefined) {
          throw new ApiError("not_found", `业务不存在: ${businessId}`);
        }
        const { from, to } = parseRange(req);
        const rows: StatsRow[] =
          llmCalls === undefined
            ? []
            : [
                ...lifecycle.dailyRuns(businessId, from, to).flatMap(runRows),
                ...llmCalls.dailyCalls(businessId, from, to).flatMap(llmRows),
                ...(runMetrics === undefined
                  ? []
                  : runMetrics
                      .dailyMetrics(businessId, from, to)
                      .flatMap(bizRows)),
              ];
        // 行序契约（契约 C）：(date, metric, bucket) 字典序
        rows.sort((a, b) => {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
          if (a.bucket !== b.bucket) return a.bucket < b.bucket ? -1 : 1;
          return 0;
        });
        const body: DailyStatsResponse = {
          business_id: businessId,
          from,
          to,
          rows,
        };
        sendJson(res, 200, body);
      },
    },
  ];
}
