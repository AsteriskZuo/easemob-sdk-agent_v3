import { useEffect, useState } from "react";
import { App as AntdApp, Button, Card, Descriptions, Tooltip } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type {
  EffectiveConfigView,
  EntryAdapterView,
} from "@asteriskzuo/agent-console-api";
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
  entry_adapters: "入口适配器",
};

/** 入口适配器列值渲染：名称（id，开/关） */
function renderAdapters(adapters: EntryAdapterView[] | undefined): string {
  if (adapters === undefined || adapters.length === 0) return "无";
  return adapters
    .map((a) => `${a.name}（${a.id}，${a.enabled ? "开" : "关"}）`)
    .join("、");
}

/** 通用配置页：生效配置只读回显 + 资产缓存清理（仅 admin）+ 通用层两桶（member 只读，admin 可写） */
export default function SettingsPage() {
  const { user } = useAuth();
  const { message, modal } = AntdApp.useApp();
  const [config, setConfig] = useState<EffectiveConfigView | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    apiFetch<EffectiveConfigView>("/api/config")
      .then(setConfig)
      .catch((err: unknown) =>
        message.error(err instanceof ApiError ? err.message : "加载配置失败"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 清理资产缓存：确认弹窗写明后果（下次 run 重新物化构建、可能耗时数分钟）后调 API */
  const confirmClearCache = () => {
    modal.confirm({
      title: "清理资产缓存",
      content:
        "将清空资产缓存目录（{workspace}/cache/assets/）下全部物化产物。资产登记记录保留；已创建业务下次 run 时会触发重新物化构建（clone + 依赖安装 + 初始化脚本），可能耗时数分钟。",
      okText: "清理",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setClearing(true);
        try {
          await apiFetch<{ cleared: boolean }>("/api/cache/clear", {
            method: "POST",
          });
          message.success("资产缓存已清理");
        } catch (err) {
          message.error(
            err instanceof ApiError ? err.message : "清理资产缓存失败",
          );
        } finally {
          setClearing(false);
        }
      },
    });
  };

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
                {key === "entry_adapters"
                  ? renderAdapters(config.entry_adapters)
                  : typeof config[key] === "boolean"
                    ? config[key]
                      ? "开"
                      : "关"
                    : String(config[key])}
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
      </Card>

      {user?.role === "admin" && (
        <Card
          title={
            <span>
              资产缓存
              <Tooltip title="物化产物缓存（git clone + 依赖安装 + 构建结果）。清理后下次 run 懒重建。">
                <QuestionCircleOutlined
                  style={{ marginLeft: 8, color: "#999" }}
                />
              </Tooltip>
            </span>
          }
          style={{ marginBottom: 24 }}
        >
          <Button danger loading={clearing} onClick={confirmClearCache}>
            清理资产缓存
          </Button>
        </Card>
      )}

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
