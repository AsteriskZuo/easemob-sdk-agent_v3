import { Button, Input, Select, Tooltip } from "antd";
import { DeleteOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import type { EventSource, MatchBody } from "@easemob/agent-console-api";

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

export interface MatchEditorProps {
  /** 匹配行列表（受控） */
  value: MatchRow[];
  onChange(rows: MatchRow[]): void;
}

/** 匹配行编辑器：source 下拉 + event_type + entry_config JSON 文本域；增删行。
 *  关注上游业务产出 = source 选 internal + event_type 填 `业务id.产出类型` */
export default function MatchEditor({ value, onChange }: MatchEditorProps) {
  const updateRow = (index: number, patch: Partial<MatchRow>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div>
      <div style={{ marginBottom: 8, color: "#666" }}>
        关注上游业务产出 = source 选 internal + event_type 填「业务id.产出类型」
        <Tooltip title="匹配行决定什么事件触发本业务。source 是入口来源（manual=手动、internal=平台内派生）；event_type 与事件精确匹配。配错会导致业务不触发或误触发。">
          <QuestionCircleOutlined style={{ marginLeft: 6, color: "#999" }} />
        </Tooltip>
      </div>
      {value.map((row, index) => {
        const parsed = parseEntryConfig(row.entry_config_text);
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
