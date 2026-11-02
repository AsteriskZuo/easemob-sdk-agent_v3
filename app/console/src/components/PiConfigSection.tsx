import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Input,
  Popconfirm,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LoadingOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import type {
  BusinessPiConfigView,
  PiValidationStatus,
} from "@asteriskzuo/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import EffectivenessNote, { EFFECTIVENESS_NOTE } from "./EffectivenessNote";
import PiProviderHelpDrawer from "./PiProviderHelpDrawer";

/** 服务端脱敏占位值（= logger 包 PI_MASK_PLACEHOLDER；console 不依赖 logger，保持字面量同步）。
 *  回显 JSON 中出现该值 = 敏感字段被脱敏，修改配置前必须重新填写真实值 */
const MASK_PLACEHOLDER = "******";
/** 验证进度轮询间隔（与服务端约定；异步验证 = 提交 202 + 轮询，见 spec 2026-11-01 §10） */
const POLL_INTERVAL_MS = 2_000;

/** 业务大模型配置区（仅编辑页渲染；创建页由外层显示警告——业务不存在时 pi-config API 不可用）。
 *  业务自定义 models.json 是模型的唯一来源（无全局兜底）：
 *  - 未配置 = 无法使用大模型推理（sdk.agent 调用失败 model_not_configured），纯程序业务可忽略；
 *  - 默认模型由服务端派生 = 配置 JSON 第一个 provider 的第一个模型；
 *  - 改动只能经「在线验证（全部模型逐个真实探针，串行）→ 确认保存」生效，
 *    存在失败项不允许保存；任何编辑使验证失效；
 *  - 与主「保存」的 PATCH 无关（model 字段只读派生，PATCH 携带会被服务端 400）；
 *  - 页面不展示 pending / update_id 等队列状态，统一用生效说明文案 */
export default function PiConfigSection({
  businessId,
}: {
  /** 业务 id */
  businessId: string;
}) {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(true);
  /** 服务端事实：当前生效配置的脱敏视图 */
  const [view, setView] = useState<BusinessPiConfigView | null>(null);
  /** models.json 编辑文本（唯一事实源） */
  const [configText, setConfigText] = useState("");
  /** 本轮验证凭据（任何编辑 → 置 null 失效） */
  const [validationId, setValidationId] = useState<string | null>(null);
  /** 轮询得到的验证进度/结果 */
  const [validation, setValidation] = useState<PiValidationStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);
  // 卸载停止轮询
  useEffect(() => stopPolling, [stopPolling]);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      message.error(err instanceof ApiError ? err.message : fallback);
    },
    [message],
  );

  /** 拉取当前生效配置回填（脱敏视图；configured=false 时 config 省略） */
  const reload = useCallback(async () => {
    stopPolling();
    try {
      const next = await apiFetch<BusinessPiConfigView>(
        `/api/businesses/${businessId}/pi-config`,
      );
      setView(next);
      setConfigText(
        next.config !== undefined ? JSON.stringify(next.config, null, 2) : "",
      );
      setValidationId(null);
      setValidation(null);
    } catch (err) {
      reportError(err, "加载业务大模型配置失败");
    } finally {
      setLoading(false);
    }
  }, [businessId, reportError, stopPolling]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 编辑区的任何改动都使已通过的验证失效 */
  const invalidateValidation = useCallback(() => {
    stopPolling();
    setValidationId(null);
    setValidation(null);
  }, [stopPolling]);

  /** 轮询验证进度：done/failed 停止；404（过期/重启）提示重新验证 */
  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollTimer.current = setInterval(() => {
        void (async () => {
          try {
            const status = await apiFetch<PiValidationStatus>(
              `/api/businesses/${businessId}/pi-config/validate/${id}`,
            );
            setValidation(status);
            if (status.status !== "running") stopPolling();
          } catch (err) {
            stopPolling();
            setValidation(null);
            setValidationId(null);
            reportError(err, "验证已失效，请重新验证");
          }
        })();
      }, POLL_INTERVAL_MS);
    },
    [businessId, reportError, stopPolling],
  );

  /** 提交验证：解析 JSON → POST validate（202 立即返回）→ 开始轮询 */
  const validate = async () => {
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(configText);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        message.error("配置不是合法 JSON object");
        return;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      message.error("配置不是合法 JSON object");
      return;
    }
    setSubmitting(true);
    try {
      const submitted = await apiFetch<{
        validation_id: string;
        total: number;
      }>(`/api/businesses/${businessId}/pi-config/validate`, {
        method: "POST",
        body: { config },
      });
      setValidationId(submitted.validation_id);
      setValidation({
        status: "running",
        total: submitted.total,
        results: [],
      });
      startPolling(submitted.validation_id);
    } catch (err) {
      invalidateValidation();
      reportError(err, "验证提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  /** 确认保存：POST confirm（只能使用全部验证通过的 validation_id） */
  const confirm = async () => {
    if (validationId === null) return;
    setConfirming(true);
    try {
      await apiFetch<void>(`/api/businesses/${businessId}/pi-config/confirm`, {
        method: "POST",
        body: { validation_id: validationId },
      });
      message.success(`已保存。${EFFECTIVENESS_NOTE}`);
      await reload();
    } catch (err) {
      reportError(err, "确认保存失败");
    } finally {
      setConfirming(false);
    }
  };

  /** 删除自定义配置（无需替代模型；生效后业务回到未配置状态） */
  const removeCustom = async () => {
    setRemoving(true);
    try {
      await apiFetch<void>(`/api/businesses/${businessId}/pi-config`, {
        method: "DELETE",
      });
      message.success(`已删除自定义配置。${EFFECTIVENESS_NOTE}`);
      await reload();
    } catch (err) {
      reportError(err, "删除配置失败");
    } finally {
      setRemoving(false);
    }
  };

  const configured = view?.configured === true;
  const allPassed = validation?.status === "done" && validation.all_passed;
  const hasMaskedField = configText.includes(`"${MASK_PLACEHOLDER}"`);

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8, fontWeight: 500 }}>
        大模型配置
        <Tooltip title="是什么：本业务大模型调用的完整 models.json（可配多个 provider 与模型，业务代码可枚举并按次选用）。何时用：使用 sdk.agent 的业务必须配置。配错后果：未配置或配置失效 = agent 调用失败。默认模型 = 第一个 provider 的第一个模型（sdk.agent 不传 model 时使用）。">
          <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
        </Tooltip>
        <Button
          type="link"
          size="small"
          icon={<QuestionCircleOutlined />}
          onClick={() => setHelpOpen(true)}
        >
          厂商配置帮助
        </Button>
      </div>

      {!configured && !loading && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="未配置大模型：该业务无法使用大模型推理"
          description="sdk.agent 调用将失败（model_not_configured）。请在下方完成 models.json 配置并在线验证；不使用大模型的纯程序业务可忽略本警告。"
        />
      )}

      {configured && view !== null && (
        <div style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary">
            当前默认模型：{view.model}（取第一个 provider 的第一个模型）
          </Typography.Text>
        </div>
      )}

      <div
        style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 12 }}
      >
        <div style={{ marginBottom: 4 }}>
          models.json（Pi 原生配置，原样保留未知字段；每个 provider 必须显式列出
          models）
        </div>
        <Input.TextArea
          aria-label="自定义 models.json"
          rows={12}
          placeholder='{"providers": {...}}（点上方「厂商配置帮助」复制模板）'
          value={configText}
          disabled={loading}
          onChange={(e) => {
            setConfigText(e.target.value);
            invalidateValidation();
          }}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
        {hasMaskedField && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
            message={`回显中的 ${MASK_PLACEHOLDER} 是脱敏占位：修改配置前必须将掩码字段重新填写为真实值，否则验证会被拒绝。`}
          />
        )}

        {validation !== null && (
          <div style={{ marginTop: 12 }}>
            {validation.status === "failed" ? (
              <Alert
                type="error"
                showIcon
                message="验证进程失败"
                description={validation.error}
              />
            ) : (
              <>
                <div style={{ marginBottom: 4 }}>
                  {validation.status === "running" && (
                    <Typography.Text type="secondary">
                      <LoadingOutlined style={{ marginRight: 6 }} />
                      串行验证中（已完成 {validation.results.length}/
                      {validation.total}，每个模型最长约 30 秒）…
                    </Typography.Text>
                  )}
                  {validation.status === "done" &&
                    (validation.all_passed ? (
                      <Typography.Text type="success">
                        全部 {validation.results.length}{" "}
                        个模型验证通过，可确认保存（默认模型：
                        {validation.default_model}）
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="danger">
                        存在验证失败的模型：请修正或删除后重新验证，全部通过才能保存
                      </Typography.Text>
                    ))}
                </div>
                <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
                  {validation.results.map((item) => (
                    <li
                      key={item.model}
                      style={{ fontFamily: "monospace", fontSize: 12 }}
                    >
                      {item.ok ? (
                        <CheckCircleTwoTone twoToneColor="#52c41a" />
                      ) : (
                        <CloseCircleTwoTone twoToneColor="#ff4d4f" />
                      )}{" "}
                      {item.model}（{item.duration_ms}ms）
                      {item.error !== undefined && (
                        <div style={{ color: "#ff4d4f", paddingLeft: 20 }}>
                          {item.error}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <Button
            type="primary"
            loading={submitting || validation?.status === "running"}
            disabled={loading || confirming}
            onClick={() => void validate()}
          >
            在线验证全部模型
          </Button>
          <Button
            type="primary"
            style={{ marginLeft: 8 }}
            disabled={!allPassed}
            loading={confirming}
            onClick={() => void confirm()}
          >
            确认保存
          </Button>
          {configured && (
            <Popconfirm
              title="确认删除自定义配置？业务将回到未配置状态（无法使用大模型推理）。"
              okText="删除配置"
              cancelText="取消"
              onConfirm={() => void removeCustom()}
            >
              <Button danger loading={removing} style={{ marginLeft: 8 }}>
                删除配置
              </Button>
            </Popconfirm>
          )}
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
            全部模型验证通过后确认保存才生效；任何编辑会使验证失效
          </Typography.Text>
        </div>
        <EffectivenessNote />
      </div>

      <PiProviderHelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
    </div>
  );
}
