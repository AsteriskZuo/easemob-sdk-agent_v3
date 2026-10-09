import { Alert, Button, Collapse, Input, Select, Tooltip } from "antd";
import { DeleteOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import type {
  BusinessProfile,
  EntryAdapterView,
  EventSource,
  MatchBody,
} from "@asteriskzuo/agent-console-api";

/** contracts 的 EventSource 七值（匹配行来源下拉） */
export const EVENT_SOURCES: EventSource[] = [
  "wecom",
  "jira",
  "github",
  "webhook",
  "cron",
  "internal",
  "manual",
];

/** 匹配行编辑状态：entry_config 以 JSON 文本承载（提交时解析，空 = 不传） */
export interface MatchRow {
  source: EventSource;
  event_type: string;
  /** entry_config 的 JSON 文本；空串 = 不传 */
  entry_config_text: string;
}

/** 解析 entry_config 文本：空 → undefined；非法 JSON → null（调用方表单内报错） */
export function parseEntryConfig(
  text: string,
): { ok: true; value?: Record<string, unknown> } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** 行 → API body（非法 JSON 返回 null） */
export function toMatchBody(row: MatchRow): MatchBody | null {
  const parsed = parseEntryConfig(row.entry_config_text);
  if (!parsed.ok) return null;
  return {
    source: row.source,
    event_type: row.event_type,
    ...(parsed.value !== undefined ? { entry_config: parsed.value } : {}),
  };
}

/** internal 引导：event_type 形如 `{业务id}.completed|failed` 时拆出上游业务与结果类型 */
function parseInternalEventType(
  eventType: string,
): { businessId: string; result: "completed" | "failed" } | undefined {
  const match = /^(.+)\.(completed|failed)$/.exec(eventType);
  if (match === null) return undefined;
  return {
    businessId: match[1] as string,
    result: match[2] as "completed" | "failed",
  };
}

/** 适配器配置项值更新进 entry_config JSON 文本（entry_config_text 是唯一事实源）：
 *  空串 = 删键；全部键删光 = 回到空文本（提交时不传 entry_config） */
function withEntryConfigValue(
  text: string,
  key: string,
  value: string,
): string {
  const parsed = parseEntryConfig(text);
  const base: Record<string, unknown> =
    parsed.ok && parsed.value !== undefined ? { ...parsed.value } : {};
  if (value.trim() === "") {
    delete base[key];
  } else {
    base[key] = value;
  }
  return Object.keys(base).length > 0 ? JSON.stringify(base) : "";
}

/** 取配置项当前值（字符串原样；其他 JSON 值字符串化展示） */
function entryConfigValue(row: MatchRow, key: string): string {
  const parsed = parseEntryConfig(row.entry_config_text);
  if (!parsed.ok || parsed.value === undefined) return "";
  const value = parsed.value[key];
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** markdown 原文展示块（不引渲染器依赖：<pre> 原样展示，换行/围栏可读） */
function DocPre({ label, doc }: { label: string; doc: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: "#666", marginBottom: 4 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 12,
          maxHeight: 320,
          overflow: "auto",
        }}
      >
        {doc}
      </pre>
    </div>
  );
}

export interface MatchEditorProps {
  /** 匹配行列表（受控） */
  value: MatchRow[];
  onChange(rows: MatchRow[]): void;
  /** 入口适配器清单（GET /api/config 的 entry_adapters）：kind 命中 source 时渲染
   *  eventDoc + 按 configSchema 生成 entry_config 表单 */
  entryAdapters: EntryAdapterView[];
  /** 现有业务列表（source=internal 时「上游业务」下拉数据源） */
  businesses: BusinessProfile[];
}

/** 匹配行编辑器：source 下拉 + event_type + entry_config。
 *  source 命中某适配器（kind===source）→ 下方渲染该适配器 eventDoc，entry_config 升级为
 *  按 configSchema 生成的表单项（裸 JSON 保留为折叠高级模式）；source=internal → 上游业务 +
 *  结果类型引导，自动生成 event_type={业务id}.completed|failed；其余 source 维持裸 JSON 文本域 */
export default function MatchEditor({
  value,
  onChange,
  entryAdapters,
  businesses,
}: MatchEditorProps) {
  const updateRow = (index: number, patch: Partial<MatchRow>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const rawJsonEditor = (row: MatchRow, index: number) => {
    const parsed = parseEntryConfig(row.entry_config_text);
    return (
      <>
        <Input.TextArea
          aria-label={`匹配行 ${index + 1} 入口配置`}
          rows={2}
          placeholder='入口配置（JSON object，可空），如 {"repo": "org/name"}'
          value={row.entry_config_text}
          status={parsed.ok ? "" : "error"}
          onChange={(e) =>
            updateRow(index, { entry_config_text: e.target.value })
          }
        />
        {!parsed.ok && (
          <div style={{ color: "#ff4d4f", marginTop: 4 }}>
            入口配置不是合法 JSON object
          </div>
        )}
      </>
    );
  };

  return (
    <div>
      <div style={{ marginBottom: 8, color: "#666" }}>
        关注上游业务产出 = source 选
        internal，再选上游业务与结果类型自动生成事件类型
        <Tooltip title="匹配行决定什么事件触发本业务。source 是入口来源（manual=手动、internal=平台内派生）；event_type 与事件精确匹配。配错会导致业务不触发或误触发。">
          <QuestionCircleOutlined style={{ marginLeft: 6, color: "#999" }} />
        </Tooltip>
      </div>
      {value.map((row, index) => {
        const parsed = parseEntryConfig(row.entry_config_text);
        // source 命中的适配器（kind===source；webhook/jira 有，manual/internal/cron 等没有）
        const adapter = entryAdapters.find((a) => a.kind === row.source);
        const hasSchema =
          adapter !== undefined && adapter.configSchema.length > 0;
        const internalGuide = parseInternalEventType(row.event_type);
        return (
          <div
            key={index}
            style={{
              border: "1px solid #f0f0f0",
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <Select
                aria-label={`匹配行 ${index + 1} 来源`}
                style={{ width: 160 }}
                value={row.source}
                options={EVENT_SOURCES.map((s) => ({ value: s, label: s }))}
                onChange={(source) => updateRow(index, { source })}
              />
              <Input
                aria-label={`匹配行 ${index + 1} 事件类型`}
                style={{ flex: 1 }}
                placeholder="事件类型，如 review.request"
                value={row.event_type}
                onChange={(e) =>
                  updateRow(index, { event_type: e.target.value })
                }
              />
              <Button
                aria-label={`删除匹配行 ${index + 1}`}
                icon={<DeleteOutlined />}
                danger
                disabled={value.length <= 1}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              />
            </div>

            {/* 内部入口引导：上游业务 + 结果类型 → 自动生成 event_type（可再手改） */}
            {row.source === "internal" && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 8,
                  flexWrap: "wrap",
                }}
              >
                <Select
                  aria-label={`匹配行 ${index + 1} 上游业务`}
                  style={{ minWidth: 240 }}
                  placeholder="上游业务（其产出触发本业务）"
                  value={
                    businesses.some(
                      (b) => b.business_id === internalGuide?.businessId,
                    )
                      ? internalGuide?.businessId
                      : undefined
                  }
                  options={businesses.map((b) => ({
                    value: b.business_id,
                    label: `${b.business_name}（${b.business_id}）`,
                  }))}
                  onChange={(businessId: string) => {
                    const result = internalGuide?.result ?? "completed";
                    updateRow(index, {
                      event_type: `${businessId}.${result}`,
                    });
                  }}
                />
                <Select
                  aria-label={`匹配行 ${index + 1} 结果类型`}
                  style={{ width: 200 }}
                  placeholder="结果类型"
                  disabled={internalGuide === undefined}
                  value={internalGuide?.result}
                  options={[
                    { value: "completed", label: "completed（成功产出）" },
                    { value: "failed", label: "failed（失败产出）" },
                  ]}
                  onChange={(result: string) => {
                    if (internalGuide === undefined) return;
                    updateRow(index, {
                      event_type: `${internalGuide.businessId}.${result}`,
                    });
                  }}
                />
                <span style={{ color: "#999", fontSize: 12 }}>
                  payload 为上游业务 sdk.return 的 output 原样
                </span>
              </div>
            )}

            {/* 适配器命中的 source：eventDoc + configSchema 表单（裸 JSON 收进折叠高级模式） */}
            {hasSchema ? (
              <>
                {!parsed.ok && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 8 }}
                    message="入口配置不是合法 JSON object（高级模式内容非法，请先修正）"
                  />
                )}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  {adapter.configSchema.map((field) => {
                    // secret 引用性质的字段（token_key/username_key/password_key 等键名引用，
                    // 区别于 session_id_key/event_id_key 这类 payload 字段路径）
                    const secretRef =
                      field.secret === true ||
                      /^(token|username|password|credential|secret|api_key)_key$/.test(
                        field.key,
                      );
                    return (
                      <div key={field.key}>
                        <div style={{ marginBottom: 4 }}>
                          {field.required === true && (
                            <span style={{ color: "#ff4d4f" }}>* </span>
                          )}
                          {field.label}
                          <span style={{ color: "#999", fontSize: 12 }}>
                            （{field.key}）
                          </span>
                        </div>
                        <Input
                          aria-label={`匹配行 ${index + 1} ${field.key}`}
                          placeholder={field.placeholder}
                          disabled={!parsed.ok}
                          value={entryConfigValue(row, field.key)}
                          onChange={(e) =>
                            updateRow(index, {
                              entry_config_text: withEntryConfigValue(
                                row.entry_config_text,
                                field.key,
                                e.target.value,
                              ),
                            })
                          }
                        />
                        {secretRef && (
                          <div style={{ color: "#999", fontSize: 12 }}>
                            填 secrets
                            键名（凭据值存业务安全桶，此处只存键名引用）
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Collapse
                  items={[
                    {
                      key: "raw",
                      label: "高级模式（裸 JSON）",
                      children: rawJsonEditor(row, index),
                    },
                  ]}
                />
              </>
            ) : (
              rawJsonEditor(row, index)
            )}

            {adapter !== undefined && (
              <>
                {adapter.enabled === false && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={`适配器「${adapter.name}」当前未启用（开关 AGENT_ENTRY_${adapter.id.toUpperCase().replace(/-/g, "_")}_ENABLED），启用前本行收不到事件`}
                  />
                )}
                <DocPre
                  label={`入口事件文档（${adapter.name}）：本行事件长什么样、payload 什么形状`}
                  doc={adapter.eventDoc}
                />
              </>
            )}
          </div>
        );
      })}
      <Button
        type="dashed"
        block
        onClick={() =>
          onChange([
            ...value,
            { source: "manual", event_type: "", entry_config_text: "" },
          ])
        }
      >
        添加匹配行
      </Button>
    </div>
  );
}
