import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Modal,
  Select,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType, ColumnType } from "antd/es/table";
import type {
  BusinessProfile,
  LifecycleRecord,
  LlmCallEntry,
  RunDetailResponse,
  RunLogResponse,
  RunMetricEntry,
} from "@asteriskzuo/agent-console-api";
import dayjs, { type Dayjs } from "dayjs";
import { apiFetch, ApiError } from "../api/client";
import { buildStatsCsv, statsCsvFileName } from "../csv";
import { RUN_COLUMNS } from "../run-columns";
import {
  collectBizColumns,
  collectErrorDetails,
  formatBizCell,
  formatCost,
  formatDurationMs,
  formatThousands,
  pivotDaily,
  type BizColumn,
  type DayStats,
  type ErrorDetail,
  type StatsDailyResponse,
} from "../stats";

/** 默认日期范围：近 14 天（与 API 缺省口径一致：to=今天，from=13 天前） */
function defaultRange(): [Dayjs, Dayjs] {
  return [dayjs().subtract(13, "day"), dayjs()];
}

/** 主表固定列：行=日期（倒序），列分组「运行」/「大模型」；列固定（0 值也出列，缺失值显示 -）。
 *  「业务」列组（biz.*）数据驱动，渲染时由 collectBizColumns 动态追加；
 *  日期列渲染为可点击链接，点击下钻当日 run 明细（再点收起） */
function baseColumns(onDateClick: (date: string) => void): ColumnsType<DayStats> {
  return [
    {
      title: "日期",
      dataIndex: "date",
      fixed: "left",
      width: 110,
      render: (date: string) => (
        <Typography.Link onClick={() => onDateClick(date)}>
          {date}
        </Typography.Link>
      ),
    },
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
}

const ERROR_COLUMNS: ColumnsType<ErrorDetail> = [
  { title: "日期", dataIndex: "date" },
  { title: "错误码", dataIndex: "error" },
  { title: "次数", dataIndex: "count", render: formatThousands },
];

/** 「业务」列组子列：数据驱动（biz.* 行决定列），单元格缺失显示 -（不补零） */
function toBizChild(col: BizColumn): ColumnType<DayStats> {
  return {
    title: col.title,
    render: (_: unknown, d: DayStats) => {
      if (col.bucket !== undefined) {
        return formatBizCell(d.biz_text[col.key]?.[col.bucket], "count");
      }
      const kind = col.numKind ?? "count";
      return formatBizCell(d.biz_num[col.key]?.[kind], kind);
    },
  };
}

/** token 类可选值：缺省显示 - */
function formatOptionalThousands(n?: number): string {
  return n === undefined ? "-" : formatThousands(n);
}

/** LLM 调用明细列：时间（本地时区）/模型/状态/耗时/token/成本/错误码 */
const LLM_CALL_COLUMNS: ColumnsType<LlmCallEntry> = [
  {
    title: "时间",
    dataIndex: "ts",
    render: (ts: string) => dayjs(ts).format("HH:mm:ss.SSS"),
  },
  { title: "模型", dataIndex: "model" },
  {
    title: "状态",
    dataIndex: "ok",
    render: (ok: boolean) =>
      ok ? <Tag color="green">✓</Tag> : <Tag color="red">✗</Tag>,
  },
  {
    title: "耗时",
    dataIndex: "duration_ms",
    render: (ms: number) => formatDurationMs(ms),
  },
  {
    title: "输入 token",
    dataIndex: "input_tokens",
    render: formatOptionalThousands,
  },
  {
    title: "输出 token",
    dataIndex: "output_tokens",
    render: formatOptionalThousands,
  },
  {
    title: "缓存读",
    dataIndex: "cache_read_tokens",
    render: formatOptionalThousands,
  },
  {
    title: "缓存写",
    dataIndex: "cache_write_tokens",
    render: formatOptionalThousands,
  },
  {
    title: "成本",
    dataIndex: "cost_total",
    render: (v?: number) => (v === undefined ? "-" : formatCost(v)),
  },
  { title: "错误码", dataIndex: "error", render: (v?: string) => v ?? "-" },
];

const METRIC_COLUMNS: ColumnsType<RunMetricEntry> = [
  { title: "指标", dataIndex: "key" },
  { title: "值", dataIndex: "value" },
];

/** run 行展开面板：懒调 /detail 展示失败原因 + LLM 调用 + 业务指标；「日志」按钮调 /log 弹 Modal */
function RunDetailPanel({ runId }: { runId: string }) {
  const { message } = AntdApp.useApp();
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [log, setLog] = useState<RunLogResponse | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<RunDetailResponse>(`/api/runs/${runId}/detail`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        message.error(
          err instanceof ApiError ? err.message : "加载 run 详情失败",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [runId, message]);

  const openLog = async () => {
    setLogLoading(true);
    try {
      const data = await apiFetch<RunLogResponse>(`/api/runs/${runId}/log`);
      setLog(data);
      setLogOpen(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        message.warning("日志不存在或已轮转");
      } else {
        message.error(
          err instanceof ApiError ? err.message : "加载日志失败",
        );
      }
    } finally {
      setLogLoading(false);
    }
  };

  if (detail === null) return <Spin size="small" />;
  return (
    <div>
      {detail.record.reason !== undefined && (
        <Typography.Paragraph type="danger">
          失败原因：{detail.record.reason}
        </Typography.Paragraph>
      )}
      <Typography.Title level={5}>LLM 调用</Typography.Title>
      <Table
        rowKey={(r) => `${r.ts}/${r.model}`}
        size="small"
        dataSource={detail.llm_calls}
        columns={LLM_CALL_COLUMNS}
        pagination={false}
        locale={{ emptyText: "无 LLM 调用记录" }}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        业务指标
      </Typography.Title>
      <Table
        rowKey="key"
        size="small"
        dataSource={detail.metrics}
        columns={METRIC_COLUMNS}
        pagination={false}
        locale={{ emptyText: "无业务指标" }}
      />
      <Button
        size="small"
        style={{ marginTop: 16 }}
        loading={logLoading}
        onClick={() => void openLog()}
      >
        日志
      </Button>
      <Modal
        title={`日志 ${runId}`}
        open={logOpen}
        footer={null}
        width={800}
        onCancel={() => setLogOpen(false)}
      >
        {log !== null && (
          <div>
            {log.truncated && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                message={`仅显示末尾部分（共 ${log.size} 字节）`}
              />
            )}
            <Typography.Paragraph type="secondary">
              {log.path}
            </Typography.Paragraph>
            <pre
              style={{
                margin: 0,
                fontSize: 12,
                maxHeight: 480,
                overflow: "auto",
              }}
            >
              {log.content}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** 统计页：业务 + 日期范围查询按日长表，前端透视成二维表（含错误明细小节）。
 *  前端只做透视与格式化，不发明指标；biz.* 透视进「业务」列组（无 biz 行时整组不出现），
 *  未知指标行忽略；日期列可点击下钻当日 run 明细；主表可导出 CSV */
export default function StatsPage() {
  const { message } = AntdApp.useApp();
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange);
  const [stats, setStats] = useState<StatsDailyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [detailRuns, setDetailRuns] = useState<LifecycleRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

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

  // 日期详情：选中日期后拉当日 run（后端按本地日历日过滤，倒序 ≤500 行）
  useEffect(() => {
    if (detailDate === null || businessId === null) {
      setDetailRuns([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiFetch<LifecycleRecord[]>(
      `/api/businesses/${businessId}/runs?date=${detailDate}`,
    )
      .then((runs) => {
        if (!cancelled) setDetailRuns(runs);
      })
      .catch((err: unknown) => {
        if (!cancelled) reportError(err, "加载日期详情失败");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailDate, businessId, reportError]);

  const days = stats === null ? [] : pivotDaily(stats.rows, stats.from, stats.to);
  const errors = stats === null ? [] : collectErrorDetails(stats.rows);
  // 业务列组：数据驱动，无 biz 行时整组不出现
  const bizColumns = useMemo(
    () => (stats === null ? [] : collectBizColumns(stats.rows)),
    [stats],
  );
  const columns = useMemo<ColumnsType<DayStats>>(() => {
    const base = baseColumns((date) =>
      setDetailDate((cur) => (cur === date ? null : date)),
    );
    return bizColumns.length === 0
      ? base
      : [...base, { title: "业务", children: bizColumns.map(toBizChild) }];
  }, [bizColumns]);

  // 导出当前主表透视结果为 CSV（纯前端，文件名 stats-{business_id}-{from}-{to}.csv）
  const exportCsv = () => {
    if (stats === null) return;
    const blob = new Blob([buildStatsCsv(days, bizColumns)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = statsCsvFileName(stats.business_id, stats.from, stats.to);
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <Card
        title="运行统计"
        style={{ marginBottom: 24 }}
        extra={
          <Button
            disabled={stats === null || days.length === 0}
            onClick={exportCsv}
          >
            导出 CSV
          </Button>
        }
      >
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
              setDetailDate(null);
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
              setDetailDate(null);
              if (businessId !== null) void loadStats(businessId, nextRange);
            }}
          />
        </div>
        <Table
          rowKey="date"
          size="small"
          loading={loading}
          dataSource={days}
          columns={columns}
          scroll={{ x: "max-content" }}
          pagination={false}
          locale={{ emptyText: businessId === null ? "请先选择业务" : "暂无数据" }}
        />
      </Card>
      {detailDate !== null && (
        <Card
          title={`日期详情 ${detailDate}`}
          size="small"
          style={{ marginBottom: 24 }}
          extra={
            <Button size="small" onClick={() => setDetailDate(null)}>
              关闭
            </Button>
          }
        >
          <Table
            rowKey="lifecycle_id"
            size="small"
            loading={detailLoading}
            dataSource={detailRuns}
            columns={RUN_COLUMNS}
            pagination={false}
            expandable={{
              expandedRowRender: (run) => (
                <RunDetailPanel runId={run.lifecycle_id} />
              ),
            }}
          />
        </Card>
      )}
      {stats !== null && (
        <Card title="错误明细" size="small">
          <Table
            rowKey={(r) => `${r.date}/${r.error}`}
            size="small"
            dataSource={errors}
            columns={ERROR_COLUMNS}
            pagination={false}
            locale={{
              emptyText:
                "暂无 LLM 调用错误（长期为空 = 平台健康；有内容 = LLM 调用级失败按错误码分桶计数）",
            }}
          />
        </Card>
      )}
    </div>
  );
}
