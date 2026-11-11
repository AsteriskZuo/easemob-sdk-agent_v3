/**
 * 统计主表 CSV 导出纯函数：导出当前透视结果（含动态 biz 列组），中文列头
 * （列组拼「父-子」，如 运行-总数 / 业务-severity-high），RFC4180 转义 +
 * \uFEFF BOM（Excel 中文兼容，转义书写避免源码不可见字符）。错误明细不导出。
 */
import {
  formatBizCell,
  formatCost,
  formatDurationMs,
  formatThousands,
  type BizColumn,
  type DayStats,
} from "./stats";

/** Excel 中文兼容 BOM */
export const CSV_BOM = "\uFEFF";

/** RFC4180 字段转义：含 " , \r \n 时整体加引号，内部引号双写 */
export function escapeCsvField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

interface CsvColumn {
  header: string;
  value: (day: DayStats) => string;
}

/** 固定列（与主表列定义一一对应，列头 = 列组-子列；日期列无列组） */
const FIXED_COLUMNS: CsvColumn[] = [
  { header: "日期", value: (d) => d.date },
  { header: "运行-总数", value: (d) => formatThousands(d.run_total) },
  { header: "运行-成功", value: (d) => formatThousands(d.run_success) },
  { header: "运行-失败", value: (d) => formatThousands(d.run_failed) },
  { header: "运行-超时", value: (d) => formatThousands(d.run_timeout) },
  {
    header: "运行-失败-输入校验",
    value: (d) => formatThousands(d.run_failed_phase["check-input"]),
  },
  {
    header: "运行-失败-主流程",
    value: (d) => formatThousands(d.run_failed_phase.main),
  },
  {
    header: "运行-失败-输出校验",
    value: (d) => formatThousands(d.run_failed_phase["check-output"]),
  },
  {
    header: "运行-失败-未知",
    value: (d) => formatThousands(d.run_failed_phase.unknown),
  },
  {
    header: "运行-平均耗时",
    value: (d) => formatDurationMs(d.run_avg_duration_ms),
  },
  { header: "大模型-调用次", value: (d) => formatThousands(d.llm_calls) },
  {
    header: "大模型-输入 token",
    value: (d) => formatThousands(d.llm_tokens_input),
  },
  {
    header: "大模型-输出 token",
    value: (d) => formatThousands(d.llm_tokens_output),
  },
  {
    header: "大模型-缓存读 token",
    value: (d) => formatThousands(d.llm_tokens_cache_read),
  },
  {
    header: "大模型-缓存写 token",
    value: (d) => formatThousands(d.llm_tokens_cache_write),
  },
  { header: "大模型-成本", value: (d) => formatCost(d.llm_cost) },
  {
    header: "大模型-平均耗时",
    value: (d) => formatDurationMs(d.llm_avg_duration_ms),
  },
  {
    header: "大模型-无用量次",
    value: (d) => formatThousands(d.llm_calls_without_usage),
  },
];

/** biz 列 → CSV 列（列头 业务-<id>；取值与主表单元格同格式化口径） */
function toBizCsvColumn(col: BizColumn): CsvColumn {
  return {
    header: `业务-${col.title}`,
    value: (d) => {
      if (col.bucket !== undefined) {
        return formatBizCell(d.biz_text[col.key]?.[col.bucket], "count");
      }
      const kind = col.numKind ?? "count";
      return formatBizCell(d.biz_num[col.key]?.[kind], kind);
    },
  };
}

/** 主表透视结果 → CSV 文本（BOM 开头，CRLF 行尾；行序 = days 原序） */
export function buildStatsCsv(
  days: DayStats[],
  bizColumns: BizColumn[],
): string {
  const columns = [...FIXED_COLUMNS, ...bizColumns.map(toBizCsvColumn)];
  const lines = [
    columns.map((c) => escapeCsvField(c.header)).join(","),
    ...days.map((day) =>
      columns.map((c) => escapeCsvField(c.value(day))).join(","),
    ),
  ];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** 导出文件名：stats-{business_id}-{from}-{to}.csv */
export function statsCsvFileName(
  businessId: string,
  from: string,
  to: string,
): string {
  return `stats-${businessId}-${from}-${to}.csv`;
}
