import { useCallback, useEffect, useState } from "react";
import { App as AntdApp, Card, DatePicker, Select, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { BusinessProfile } from "@asteriskzuo/agent-console-api";
import dayjs, { type Dayjs } from "dayjs";
import { apiFetch, ApiError } from "../api/client";
import {
  collectErrorDetails,
  formatCost,
  formatDurationMs,
  formatThousands,
  pivotDaily,
  type DayStats,
  type ErrorDetail,
  type StatsDailyResponse,
} from "../stats";

/** 默认日期范围：近 14 天（与 API 缺省口径一致：to=今天，from=13 天前） */
function defaultRange(): [Dayjs, Dayjs] {
  return [dayjs().subtract(13, "day"), dayjs()];
}

/** 主表列：行=日期（倒序），列分组「运行」/「大模型」；列固定（0 值也出列，缺失值显示 -） */
const COLUMNS: ColumnsType<DayStats> = [
  { title: "日期", dataIndex: "date", fixed: "left", width: 110 },
  {
    title: "运行",
    children: [
      { title: "总数", dataIndex: "run_total", render: formatThousands },
      { title: "成功", dataIndex: "run_success", render: formatThousands },
      { title: "失败", dataIndex: "run_failed", render: formatThousands },
      { title: "超时", dataIndex: "run_timeout", render: formatThousands },
      {
        title: "失败-输入校验",
        render: (_, d) => formatThousands(d.run_failed_phase["check-input"]),
      },
      {
        title: "失败-主流程",
        render: (_, d) => formatThousands(d.run_failed_phase.main),
      },
      {
        title: "失败-输出校验",
        render: (_, d) => formatThousands(d.run_failed_phase["check-output"]),
      },
      {
        title: "失败-未知",
        render: (_, d) => formatThousands(d.run_failed_phase.unknown),
      },
      {
        title: "平均耗时",
        render: (_, d) => formatDurationMs(d.run_avg_duration_ms),
      },
    ],
  },
  {
    title: "大模型",
    children: [
      { title: "调用次", dataIndex: "llm_calls", render: formatThousands },
      {
        title: "输入 token",
        dataIndex: "llm_tokens_input",
        render: formatThousands,
      },
      {
        title: "输出 token",
        dataIndex: "llm_tokens_output",
        render: formatThousands,
      },
      {
        title: "缓存读 token",
        dataIndex: "llm_tokens_cache_read",
        render: formatThousands,
      },
      {
        title: "缓存写 token",
        dataIndex: "llm_tokens_cache_write",
        render: formatThousands,
      },
      { title: "成本", render: (_, d) => formatCost(d.llm_cost) },
      {
        title: "平均耗时",
        render: (_, d) => formatDurationMs(d.llm_avg_duration_ms),
      },
      {
        title: "无用量次",
        dataIndex: "llm_calls_without_usage",
        render: formatThousands,
      },
    ],
  },
];

const ERROR_COLUMNS: ColumnsType<ErrorDetail> = [
  { title: "日期", dataIndex: "date" },
  { title: "错误码", dataIndex: "error" },
  { title: "次数", dataIndex: "count", render: formatThousands },
];

/** 统计页：业务 + 日期范围查询按日长表，前端透视成二维表（含错误明细小节）。
 *  前端只做透视与格式化，不发明指标；biz.*（二期）与未知指标行忽略 */
export default function StatsPage() {
  const { message } = AntdApp.useApp();
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange);
  const [stats, setStats] = useState<StatsDailyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      message.error(err instanceof ApiError ? err.message : fallback);
    },
    [message],
  );

  // 业务下拉数据源（与监控仪表盘同一接口）
  useEffect(() => {
    apiFetch<BusinessProfile[]>("/api/businesses")
      .then(setBusinesses)
      .catch((err: unknown) => reportError(err, "加载业务列表失败"));
  }, [reportError]);

  const loadStats = useCallback(
    async (id: string, [from, to]: [Dayjs, Dayjs]) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          business_id: id,
          from: from.format("YYYY-MM-DD"),
          to: to.format("YYYY-MM-DD"),
        });
        setStats(await apiFetch<StatsDailyResponse>(`/api/stats/daily?${params}`));
      } catch (err) {
        reportError(err, "加载统计数据失败");
      } finally {
        setLoading(false);
      }
    },
    [reportError],
  );

  const days = stats === null ? [] : pivotDaily(stats.rows, stats.from, stats.to);
  const errors = stats === null ? [] : collectErrorDetails(stats.rows);

  return (
    <div>
      <Card title="运行统计" style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 16, display: "flex", gap: 16 }}>
          <Select
            aria-label="选择业务"
            style={{ width: 320 }}
            placeholder="选择业务查看统计"
            value={businessId}
            options={businesses.map((b) => ({
              value: b.business_id,
              label: b.business_name,
            }))}
            onChange={(id) => {
              setBusinessId(id);
              void loadStats(id, range);
            }}
          />
          <DatePicker.RangePicker
            aria-label="日期范围"
            allowClear={false}
            value={range}
            onChange={(next) => {
              if (next === null || next[0] === null || next[1] === null) return;
              const nextRange: [Dayjs, Dayjs] = [next[0], next[1]];
              setRange(nextRange);
              if (businessId !== null) void loadStats(businessId, nextRange);
            }}
          />
        </div>
        <Table
          rowKey="date"
          size="small"
          loading={loading}
          dataSource={days}
          columns={COLUMNS}
          scroll={{ x: "max-content" }}
          pagination={false}
          locale={{ emptyText: businessId === null ? "请先选择业务" : "暂无数据" }}
        />
      </Card>
      {stats !== null && (
        <Card title="错误明细" size="small">
          <Table
            rowKey={(r) => `${r.date}/${r.error}`}
            size="small"
            dataSource={errors}
            columns={ERROR_COLUMNS}
            pagination={false}
          />
        </Card>
      )}
    </div>
  );
}
