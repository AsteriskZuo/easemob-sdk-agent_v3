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
  /** 指标名，族前缀 run.* / llm.* / biz.*（biz.* 为二期业务指标族，透视进「业务」列组） */
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
  /** 业务字符串指标（biz.<key>）：key → 桶值 → 出现次数；缺键 = 当日无该指标 */
  biz_text: Record<string, Record<string, number>>;
  /** 业务数值指标（biz.<key>.sum/.avg/.count）：key → 三值；缺键 = 当日无该指标 */
  biz_num: Record<string, { sum: number; avg: number; count: number }>;
}

/** 零值日骨架（avg 类为 null；biz 族数据驱动不补零，空表即可） */
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
    biz_text: {},
    biz_num: {},
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

/** 业务数值指标的数值子行后缀（契约 F：bucket 恒 ""） */
const BIZ_NUM_SUFFIXES = [".sum", ".avg", ".count"] as const;

/** biz.* 行写入当日业务指标：字符串指标 biz.<key>（bucket=值原样）→ biz_text；
 *  数值指标 biz.<key>.sum|.avg|.count（bucket=""）→ biz_num。
 *  key 契约形 [a-z][a-z0-9_]* 不含点，后缀判定无歧义 */
function fillBizMetric(day: DayStats, row: StatsRow): void {
  const rest = row.metric.slice("biz.".length);
  if (row.bucket === "") {
    const suffix = BIZ_NUM_SUFFIXES.find((s) => rest.endsWith(s));
    if (suffix !== undefined) {
      const key = rest.slice(0, -suffix.length);
      const num = (day.biz_num[key] ??= { sum: 0, avg: 0, count: 0 });
      if (suffix === ".sum") num.sum = row.value;
      else if (suffix === ".avg") num.avg = row.value;
      else num.count = row.value;
      return;
    }
  }
  (day.biz_text[rest] ??= {})[row.bucket] = row.value;
}

/** 长表 → 二维表行集：[from, to] 逐日补齐（零数据日出零行），返回 date 倒序。
 *  未知指标忽略（前端不发明指标，但兼容未来新增行）；biz.* 进 biz_text/biz_num
 *  供「业务」列组（见 collectBizColumns）；llm.errors 不进主表（见 collectErrorDetails） */
export function pivotDaily(
  rows: StatsRow[],
  from: string,
  to: string,
): DayStats[] {
  const byDate = new Map<string, DayStats>();
  for (const row of rows) {
    let day = byDate.get(row.date);
    if (day === undefined) {
      day = emptyDay(row.date);
      byDate.set(row.date, day);
    }
    if (row.metric.startsWith("biz.")) {
      fillBizMetric(day, row);
      continue;
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

/** 「业务」列组的一列（数据驱动：biz.* 行决定列集，列序见 collectBizColumns） */
export interface BizColumn {
  /** 列标识：字符串指标 `<key>=<bucket>`；数值指标 `<key>.sum|.avg|.count` */
  id: string;
  /** 列标题（同 id） */
  title: string;
  /** 指标键（biz. 前缀之后） */
  key: string;
  /** 字符串桶（有值 = 字符串指标列，单元格为出现次数） */
  bucket?: string;
  /** 数值子列类别（有值 = 数值指标列） */
  numKind?: "sum" | "avg" | "count";
}

/** 收集 biz.* 列（数据驱动：无 biz 行返回空数组 → 列组整体不出现）。
 *  列序 = 指标 key 字典序；同 key 内字符串桶按字典序、数值列固定 sum→avg→count。
 *  字符串与数值混排（契约上同 key 不会混型，防御性共存）时字符串桶列在前 */
export function collectBizColumns(rows: StatsRow[]): BizColumn[] {
  const textKeys = new Map<string, Set<string>>();
  const numKeys = new Set<string>();
  for (const row of rows) {
    if (!row.metric.startsWith("biz.")) continue;
    const rest = row.metric.slice("biz.".length);
    if (row.bucket === "") {
      const suffix = BIZ_NUM_SUFFIXES.find((s) => rest.endsWith(s));
      if (suffix !== undefined) {
        numKeys.add(rest.slice(0, -suffix.length));
        continue;
      }
    }
    const buckets = textKeys.get(rest) ?? new Set<string>();
    buckets.add(row.bucket);
    textKeys.set(rest, buckets);
  }
  const keys = [...new Set([...textKeys.keys(), ...numKeys])].sort((a, b) =>
    a.localeCompare(b),
  );
  const columns: BizColumn[] = [];
  for (const key of keys) {
    const buckets = textKeys.get(key);
    if (buckets !== undefined) {
      for (const bucket of [...buckets].sort((a, b) => a.localeCompare(b))) {
        const id = `${key}=${bucket}`;
        columns.push({ id, title: id, key, bucket });
      }
    }
    if (numKeys.has(key)) {
      for (const numKind of ["sum", "avg", "count"] as const) {
        const id = `${key}.${numKind}`;
        columns.push({ id, title: id, key, numKind });
      }
    }
  }
  return columns;
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

/** 业务列组单元格：count 千分位整数；sum 整数千分位/小数 2 位；avg 恒 2 位小数；
 *  undefined（当日无该指标数据）显示 -（不补零，数据驱动） */
export function formatBizCell(
  n: number | undefined,
  kind: "count" | "sum" | "avg",
): string {
  if (n === undefined) return "-";
  if (kind === "count") return formatThousands(n);
  if (kind === "sum") return Number.isInteger(n) ? formatThousands(n) : n.toFixed(2);
  return n.toFixed(2);
}
