export const CONTRACT_VERSION = "v1" as const;
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

export interface EventEnvelope {
  contract_version: ContractVersion;
  source: EventSource;
  event_id: string;
  event_type: string;
  timestamp: string; // ISO 8601 带时区
  session_id: string;
  correlation_id: string;
  hop_count: number;
  payload: unknown;
  producer_business_id?: string; // 仅 internal 派生事件填写
}

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
