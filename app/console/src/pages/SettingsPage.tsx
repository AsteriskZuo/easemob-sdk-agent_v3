import { useEffect, useState } from "react";
import { App as AntdApp, Card, Descriptions, Tooltip } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { EffectiveConfigView } from "@easemob/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import EnvEditor from "../components/EnvEditor";

/** 生效配置字段的中文标签（全部字段原样展示） */
const CONFIG_LABELS: Record<keyof EffectiveConfigView, string> = {
  workspace: "工作目录",
  log_level: "日志级别",
  log_enabled: "日志开关",
  hop_limit: "派生事件 hop 上限",
  task_concurrency: "入口业务闸门",
  result_concurrency: "出口闸门",
  task_timeout_minutes: "run 超时全局默认（分钟）",
  max_agent_calls: "agent 调用配额全局默认",
  pi_cli_path: "pi 可执行文件路径",
  pi_agent_dir: "pi agent 目录",
  models: "可选大模型（models.json 驱动）",
  agents: "可选 agent 内核",
};

/** 通用配置页：生效配置只读回显 + 通用层两桶（member 只读，admin 可写） */
export default function SettingsPage() {
  const { user } = useAuth();
  const { message } = AntdApp.useApp();
  const [config, setConfig] = useState<EffectiveConfigView | null>(null);

  useEffect(() => {
    apiFetch<EffectiveConfigView>("/api/config")
      .then(setConfig)
      .catch((err: unknown) =>
        message.error(err instanceof ApiError ? err.message : "加载配置失败"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <Card
        title={
          <span>
            生效配置（只读）
            <Tooltip title="此处展示平台当前生效的运行参数。改配置 = 改环境变量或 {workspace}/config.json 后重启平台，此处不可改。">
              <QuestionCircleOutlined
                style={{ marginLeft: 8, color: "#999" }}
              />
            </Tooltip>
          </span>
        }
        style={{ marginBottom: 24 }}
      >
        {config !== null && (
          <Descriptions column={2} size="small" bordered>
            {(
              Object.entries(CONFIG_LABELS) as Array<
                [keyof EffectiveConfigView, string]
              >
            ).map(([key, label]) => (
              <Descriptions.Item key={key} label={label}>
                {typeof config[key] === "boolean"
                  ? config[key]
                    ? "开"
                    : "关"
                  : String(config[key])}
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
      </Card>

      <Card
        title={
          <span>
            通用层 key-value
            <Tooltip title="对所有业务生效的环境配置。普通桶明文回显；安全桶只写（凭据、令牌）。业务层同名键优先于通用层。">
              <QuestionCircleOutlined
                style={{ marginLeft: 8, color: "#999" }}
              />
            </Tooltip>
          </span>
        }
      >
        {/* member 只读（编辑按钮隐藏）；admin 可写 */}
        <EnvEditor scope="global" readOnly={user?.role !== "admin"} />
      </Card>
    </div>
  );
}
