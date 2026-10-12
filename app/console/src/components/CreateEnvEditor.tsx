import { Button, Input, Tooltip } from "antd";
import { DeleteOutlined, QuestionCircleOutlined } from "@ant-design/icons";

/** 随建环境配置的一行（key/value；key 空白的行提交时丢弃） */
export interface EnvKvRow {
  key: string;
  value: string;
}

export interface CreateEnvEditorProps {
  /** 普通变量行（明文） */
  vars: EnvKvRow[];
  /** 安全变量行（值用 Password 输入，不回显保护） */
  secrets: EnvKvRow[];
  onVarsChange(rows: EnvKvRow[]): void;
  onSecretsChange(rows: EnvKvRow[]): void;
}

/** 行编辑组：可增删的 key/value 行（secret=true 时值用 Input.Password）。
 *  EnvEditor（编辑页草稿模式）也复用本组件，保持创建/编辑两处交互一致 */
export function KvGroup({
  groupLabel,
  title,
  tip,
  rows,
  secret,
  onChange,
  valuePlaceholder,
  readOnly,
}: {
  /** aria-label 前缀（如「普通变量」→「普通变量 1 键」） */
  groupLabel: string;
  title: string;
  tip: string;
  rows: EnvKvRow[];
  secret: boolean;
  onChange(rows: EnvKvRow[]): void;
  /** 值输入框占位文案（缺省按 secret 给创建场景文案；编辑页传入覆盖语义） */
  valuePlaceholder?: string;
  /** true = 全部输入与增删禁用（只读查看） */
  readOnly?: boolean;
}) {
  const updateRow = (index: number, patch: Partial<EnvKvRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <Tooltip title={tip}>
          <QuestionCircleOutlined style={{ marginLeft: 6, color: "#999" }} />
        </Tooltip>
        {!readOnly && (
          <Button
            size="small"
            style={{ marginLeft: 12 }}
            onClick={() => onChange([...rows, { key: "", value: "" }])}
          >
            添加
          </Button>
        )}
      </div>
      {rows.length === 0 && (
        <div style={{ color: "#999", fontSize: 12 }}>暂无，点「添加」新增</div>
      )}
      {rows.map((row, index) => (
        <div key={index} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <Input
            aria-label={`${groupLabel} ${index + 1} 键`}
            style={{ width: 240 }}
            placeholder="键，如 jira_url"
            value={row.key}
            disabled={readOnly}
            onChange={(e) => updateRow(index, { key: e.target.value })}
          />
          {secret ? (
            <Input.Password
              aria-label={`${groupLabel} ${index + 1} 值`}
              style={{ flex: 1 }}
              placeholder={valuePlaceholder ?? "值（创建后不回显）"}
              value={row.value}
              disabled={readOnly}
              onChange={(e) => updateRow(index, { value: e.target.value })}
            />
          ) : (
            <Input
              aria-label={`${groupLabel} ${index + 1} 值`}
              style={{ flex: 1 }}
              placeholder={valuePlaceholder ?? "值（明文）"}
              value={row.value}
              disabled={readOnly}
              onChange={(e) => updateRow(index, { value: e.target.value })}
            />
          )}
          {!readOnly && (
            <Button
              aria-label={`删除${groupLabel} ${index + 1}`}
              icon={<DeleteOutlined />}
              danger
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** 创建页随建环境配置：普通变量（明文）+ 安全变量（Password）两组行编辑。
 *  纯受控组件——状态由 BusinessEditPage 持有（并入创建草稿），提交时组装进
 *  POST /api/businesses 的 env 字段（key 空白的行丢弃；两组皆空不携带 env） */
export default function CreateEnvEditor({
  vars,
  secrets,
  onVarsChange,
  onSecretsChange,
}: CreateEnvEditorProps) {
  return (
    <div>
      <KvGroup
        groupLabel="普通变量"
        title="普通变量（vars）"
        tip="明文键值对，随业务创建落入该业务普通桶；入口/出口配置里 {{key}} 占位的真值可在这里先建好。键名写错 = 占位解析失败。"
        rows={vars}
        secret={false}
        onChange={onVarsChange}
      />
      <KvGroup
        groupLabel="安全变量"
        title="安全变量（secrets）"
        tip="机密键值（令牌、凭据），随业务创建落入该业务安全桶；只写不读，创建后不再回显。"
        rows={secrets}
        secret={true}
        onChange={onSecretsChange}
      />
    </div>
  );
}
