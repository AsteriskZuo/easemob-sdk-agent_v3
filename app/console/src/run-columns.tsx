import { Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import type {
  LifecycleRecord,
  LifecycleStatus,
} from "@asteriskzuo/agent-console-api";
import { formatDurationMs } from "./stats";

/** 运行状态徽标颜色：running 蓝 / success 绿 / failed 红 / timeout 橙 */
export const RUN_STATUS_COLOR: Record<LifecycleStatus, string> = {
  created: "default",
  running: "blue",
  success: "green",
  failed: "red",
  timeout: "orange",
};

/** 耗时（完结 - 创建，ms）；未完结返回 null（展示 —） */
function runDurationMs(record: LifecycleRecord): number | null {
  if (record.finished_at === undefined) return null;
  return Date.parse(record.finished_at) - Date.parse(record.created_at);
}

/** 业务运行记录列定义（监控仪表盘与统计页日期详情共用）：
 *  运行 ID/事件 ID/状态/创建时间（默认倒序）/完结时间/耗时/失败阶段/失败原因。
 *  排序全部前端客户端排序；finished_at 缺省按空串参与比较（descend 下自然排最后） */
export const RUN_COLUMNS: ColumnsType<LifecycleRecord> = [
  { title: "运行 ID", dataIndex: "lifecycle_id" },
  { title: "事件 ID", dataIndex: "event_id" },
  {
    title: "状态",
    dataIndex: "status",
    render: (status: LifecycleStatus) => (
      <Tag color={RUN_STATUS_COLOR[status]}>{status}</Tag>
    ),
  },
  {
    title: "创建时间",
    dataIndex: "created_at",
    sorter: (a, b) => a.created_at.localeCompare(b.created_at),
    defaultSortOrder: "descend",
  },
  {
    title: "完结时间",
    dataIndex: "finished_at",
    render: (v?: string) => v ?? "—",
    sorter: (a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""),
  },
  {
    title: "耗时",
    render: (_, record) => {
      const ms = runDurationMs(record);
      return ms === null ? "—" : formatDurationMs(ms);
    },
  },
  {
    title: "失败阶段",
    dataIndex: "failed_at",
    render: (v?: string) => v ?? "—",
  },
  {
    title: "失败原因",
    dataIndex: "reason",
    ellipsis: true,
    render: (v?: string) =>
      v === undefined ? "—" : <Tooltip title={v}>{v}</Tooltip>,
  },
];
