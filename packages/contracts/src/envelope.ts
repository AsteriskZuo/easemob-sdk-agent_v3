/** 信封结构版本，当前恒为 "v1"；版本路由靠它，类型名不缀版本号（v2 到来时按值区分） */
export const CONTRACT_VERSION = "v1" as const;
/** 信封版本类型 = CONTRACT_VERSION 的字面量类型 */
export type ContractVersion = typeof CONTRACT_VERSION;

/** 入口来源枚举；新增来源 = 扩展此联合类型（向后兼容） */
export type EventSource =
  "wecom" | "jira" | "github" | "webhook" | "cron" | "internal" | "manual";

const EVENT_SOURCES: readonly string[] = [
  "wecom",
  "jira",
  "github",
  "webhook",
  "cron",
  "internal",
  "manual",
];

/** 事件信封：平台内一切事件的统一包装（入口包装落队列，业务产出再派发） */
export interface EventEnvelope {
  contract_version: ContractVersion; // 信封结构版本，恒为 "v1"；版本路由靠它
  source: EventSource; // 入口来源（internal = 平台内派生事件）
  event_id: string; // 全局唯一锚点，兼作入口幂等键（源生事件重推按它丢弃）
  event_type: string; // 类别标签（非实例标识），业务关注匹配的键
  timestamp: string; // ISO 8601 带时区
  session_id: string; // 源生会话标识（群 id / 工单 key 等），平台视为不透明字符串
  correlation_id: string; // 整条派生链首个任务的 event_id，全链追溯用
  hop_count: number; // 派生转发计数（派生 +1），防循环订阅
  payload: unknown; // 事件数据载体，结构由来源自定义；派生事件的 payload = 业务产出
  producer_business_id?: string; // 仅 internal 派生事件填写 = 产出方业务 id，出口循环按它做归属匹配
}

/** 校验结果：ok=true 通过；ok=false 时 errors 列出全部问题（不遇第一个错误就停） */
export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const REQUIRED_FIELDS = [
  "contract_version",
  "source",
  "event_id",
  "event_type",
  "timestamp",
  "session_id",
  "correlation_id",
  "hop_count",
  "payload",
] as const;

// 结尾时区偏移：Z 或 ±HH:MM / ±HHMM / ±HH
const TIMEZONE_SUFFIX = /([zZ]|[+-]\d{2}:?\d{2})$/;

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null) return false;
  // 排除数组/类实例等：原型必须是 Object.prototype 或 null
  const proto = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasValidTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!TIMEZONE_SUFFIX.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** 机械校验：结构/类型/取值域，不查业务语义。不识别的字段忽略（向后兼容规则） */
export function validateEnvelope(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["envelope must be a plain object"] };
  }

  const errors: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in input)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (
    "contract_version" in input &&
    input.contract_version !== CONTRACT_VERSION
  ) {
    errors.push(`contract_version must be "${CONTRACT_VERSION}"`);
  }

  if (
    "source" in input &&
    !(typeof input.source === "string" && EVENT_SOURCES.includes(input.source))
  ) {
    errors.push(`source must be one of: ${EVENT_SOURCES.join(", ")}`);
  }

  for (const field of [
    "event_id",
    "event_type",
    "session_id",
    "correlation_id",
  ] as const) {
    if (field in input && !isNonEmptyString(input[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if ("timestamp" in input && !hasValidTimestamp(input.timestamp)) {
    errors.push(
      "timestamp must be a valid ISO 8601 string with timezone offset",
    );
  }

  if (
    "hop_count" in input &&
    !(
      typeof input.hop_count === "number" &&
      Number.isInteger(input.hop_count) &&
      input.hop_count >= 0
    )
  ) {
    errors.push("hop_count must be an integer >= 0");
  }

  if (
    "producer_business_id" in input &&
    input.producer_business_id !== undefined &&
    !isNonEmptyString(input.producer_business_id)
  ) {
    errors.push("producer_business_id must be a non-empty string");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
