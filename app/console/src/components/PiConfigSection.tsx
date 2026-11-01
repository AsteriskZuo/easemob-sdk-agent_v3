import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  Popconfirm,
  Radio,
  Select,
  Tooltip,
  Typography,
} from "antd";
import type { FormInstance } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type {
  BusinessPiConfigView,
  PiValidateResult,
} from "@asteriskzuo/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import EffectivenessNote, { EFFECTIVENESS_NOTE } from "./EffectivenessNote";
import PiProviderHelpDrawer from "./PiProviderHelpDrawer";

/** 服务端脱敏占位值（= logger 包 PI_MASK_PLACEHOLDER；console 不依赖 logger，保持字面量同步）。
 *  回显 JSON 中出现该值 = 敏感字段被脱敏，修改配置前必须重新填写真实值 */
const MASK_PLACEHOLDER = "******";

/** 业务大模型配置区（仅编辑页渲染；创建页沿用外层全局 models 下拉 = 平台默认）。
 *  两种模式：
 *  - 平台默认：外层 Form 的 model 字段走全局 models 下拉，随主「保存」PATCH 生效；
 *  - 业务自定义：自由输入 provider/id（不受全局下拉限制）+ 完整 models.json 编辑，
 *    改动只能经「在线验证 → 确认保存」生效（真实探针验证通过才允许确认；任何编辑使验证失效），
 *    与主「保存」的 PATCH 无关（自定义配置业务的 model 由配置同一写操作维护，PATCH 单独改会被服务端 409）。
 *  已配置自定义的业务切回平台默认：选择全局模型后「恢复平台默认」移除自定义配置（经更新队列生效）。
 *  页面不展示 pending / update_id 等队列状态，统一用生效说明文案 */
export default function PiConfigSection<T extends { model: string }>({
  businessId,
  form,
  globalModels,
  onIncludeModelChange,
}: {
  /** 业务 id */
  businessId: string;
  /** 外层业务表单（平台默认模式的 model 字段仍由它承载） */
  form: FormInstance<T>;
  /** 全局可选模型列表（/api/config 的 models） */
  globalModels: string[];
  /** 主保存 PATCH 是否应携带 model 字段（默认模式且未配置自定义 = true，其余 = false） */
  onIncludeModelChange: (include: boolean) => void;
}) {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(true);
  /** 服务端事实：当前是否已配置业务自定义 */
  const [configured, setConfigured] = useState(false);
  /** UI 模式选择（初始跟随 configured） */
  const [mode, setMode] = useState<"default" | "custom">("default");
  /** 自定义模式：provider/id 输入 */
  const [customModel, setCustomModel] = useState("");
  /** 自定义模式：models.json 编辑文本（唯一事实源） */
  const [configText, setConfigText] = useState("");
  /** 最近一次验证通过的结果（任何编辑 → 置 null 失效） */
  const [validation, setValidation] = useState<PiValidateResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // 组件内只读写 model 字段；antd NamePath 条件类型在裸泛型 T 上无法把 "model" 收窄为合法键，
  // 这里具体化为 { model: string } 视图使用（prop 仍保持调用方的 FormInstance<T>，无协变问题）
  const modelForm = form as unknown as FormInstance<{ model: string }>;
  const watchedModel = Form.useWatch("model", modelForm);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      message.error(err instanceof ApiError ? err.message : fallback);
    },
    [message],
  );

  /** 拉取当前生效配置回填（脱敏视图；configured=false 时 config 省略） */
  const reload = useCallback(async () => {
    try {
      const view = await apiFetch<BusinessPiConfigView>(
        `/api/businesses/${businessId}/pi-config`,
      );
      setConfigured(view.configured);
      setMode(view.configured ? "custom" : "default");
      setCustomModel(view.configured ? view.model : "");
      setConfigText(
        view.config !== undefined ? JSON.stringify(view.config, null, 2) : "",
      );
      setValidation(null);
    } catch (err) {
      reportError(err, "加载业务大模型配置失败");
    } finally {
      setLoading(false);
    }
  }, [businessId, reportError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 主保存 PATCH 是否携带 model：仅「平台默认模式 + 无自定义配置」时携带
  const includeModel = mode === "default" && !configured;
  useEffect(() => {
    onIncludeModelChange(includeModel);
  }, [includeModel, onIncludeModelChange]);

  /** 自定义编辑区的任何改动都使已通过的验证失效 */
  const invalidateValidation = () => setValidation(null);

  /** 在线验证：解析 JSON → POST validate（真实探针；失败响应已脱敏，直接展示） */
  const validate = async () => {
    const model = customModel.trim();
    if (model === "") {
      message.warning("请输入模型（provider/id 形式）");
      return;
    }
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
    setValidating(true);
    try {
      const result = await apiFetch<PiValidateResult>(
        `/api/businesses/${businessId}/pi-config/validate`,
        { method: "POST", body: { model, config } },
      );
      setValidation(result);
      message.success(`验证通过（耗时 ${result.duration_ms}ms），请确认保存`);
    } catch (err) {
      setValidation(null);
      reportError(err, "验证失败");
    } finally {
      setValidating(false);
    }
  };

  /** 确认保存：POST confirm（只能使用最近一次验证通过的 validation_id） */
  const confirm = async () => {
    if (validation === null) return;
    setConfirming(true);
    try {
      await apiFetch<void>(`/api/businesses/${businessId}/pi-config/confirm`, {
        method: "POST",
        body: { validation_id: validation.validation_id },
      });
      message.success(`已保存。${EFFECTIVENESS_NOTE}`);
      // 回显刷新为脱敏后的生效值；同步外层表单 model，切回默认模式时显示一致
      modelForm.setFieldValue("model", customModel.trim());
      await reload();
    } catch (err) {
      reportError(err, "确认保存失败");
    } finally {
      setConfirming(false);
    }
  };

  /** 恢复平台默认：DELETE 携带选定的全局模型（经更新队列生效） */
  const removeCustom = async () => {
    const model =
      (modelForm.getFieldValue("model") as string | undefined) ?? "";
    if (model.trim() === "") {
      message.warning("请先在下方选择要恢复使用的平台模型");
      return;
    }
    setRemoving(true);
    try {
      await apiFetch<void>(`/api/businesses/${businessId}/pi-config`, {
        method: "DELETE",
        body: { model: model.trim() },
      });
      message.success(`已恢复平台默认。${EFFECTIVENESS_NOTE}`);
      await reload();
    } catch (err) {
      reportError(err, "恢复平台默认失败");
    } finally {
      setRemoving(false);
    }
  };

  const hasMaskedField = configText.includes(`"${MASK_PLACEHOLDER}"`);

  return (
    <Form.Item
      label={
        <span>
          大模型
          <Tooltip title="平台默认：从全局可选模型（服务端 AGENT_PI_MODELS）选择。业务自定义：本业务独立的 models.json 配置，可接入全局列表外的厂商与模型，需在线验证通过后确认保存。">
            <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
          </Tooltip>
        </span>
      }
      required={mode === "default"}
      style={{ marginBottom: 0 }}
    >
      <Radio.Group
        aria-label="大模型配置模式"
        value={mode}
        disabled={loading}
        onChange={(e) => setMode(e.target.value as "default" | "custom")}
        options={[
          { value: "default", label: "平台默认" },
          { value: "custom", label: "业务自定义" },
        ]}
        optionType="button"
        style={{ marginBottom: 12 }}
      />

      {mode === "default" && (
        <>
          {configured && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="该业务当前使用业务自定义配置"
              description={
                <>
                  在下方选择要恢复使用的平台模型，然后点击「恢复平台默认」移除自定义配置。
                  <Popconfirm
                    title="确认恢复平台默认？自定义配置将被移除（经更新队列生效）。"
                    okText="恢复平台默认"
                    cancelText="取消"
                    onConfirm={() => void removeCustom()}
                  >
                    <Button size="small" danger loading={removing}>
                      恢复平台默认
                    </Button>
                  </Popconfirm>
                </>
              }
            />
          )}
          {/* 平台默认模式的 model 仍走外层 Form 字段（required 校验；随主保存 PATCH） */}
          <Form.Item
            name="model"
            noStyle
            rules={[{ required: true, message: "请选择模型" }]}
          >
            <Select
              aria-label="大模型"
              placeholder="请选择模型"
              options={globalModels.map((m) => ({ value: m, label: m }))}
            />
          </Form.Item>
          {watchedModel !== undefined &&
            watchedModel !== "" &&
            globalModels.length > 0 &&
            !globalModels.includes(watchedModel) && (
              <div style={{ color: "#faad14", marginTop: 4 }}>
                该模型已不在全局可选列表
                {configured
                  ? "（来自业务自定义配置）"
                  : "（AGENT_PI_MODELS 已变更并重启）"}
              </div>
            )}
        </>
      )}

      {mode === "custom" && (
        <div
          style={{
            border: "1px solid #f0f0f0",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div style={{ marginBottom: 8 }}>
            模型（provider/id，可输入全局列表外的值）
            <Button
              type="link"
              size="small"
              icon={<QuestionCircleOutlined />}
              onClick={() => setHelpOpen(true)}
            >
              厂商配置帮助
            </Button>
          </div>
          <Input
            aria-label="自定义模型"
            placeholder="如 dashscope/qwen-plus、deepseek/deepseek-flash"
            value={customModel}
            disabled={loading}
            onChange={(e) => {
              setCustomModel(e.target.value);
              invalidateValidation();
            }}
            style={{ marginBottom: 8 }}
          />
          <div style={{ marginBottom: 4 }}>
            models.json（Pi 原生配置，原样保留未知字段）
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
          <div style={{ marginTop: 8 }}>
            <Button
              type="primary"
              loading={validating}
              disabled={loading || confirming}
              onClick={() => void validate()}
            >
              在线验证
            </Button>
            <Button
              type="primary"
              style={{ marginLeft: 8 }}
              disabled={validation === null}
              loading={confirming}
              onClick={() => void confirm()}
            >
              确认保存
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              验证通过后确认保存才生效；任何编辑会使验证失效
            </Typography.Text>
          </div>
          <EffectivenessNote />
        </div>
      )}

      <PiProviderHelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
    </Form.Item>
  );
}
