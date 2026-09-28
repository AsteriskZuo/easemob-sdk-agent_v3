import { validateEnvelope } from "../src/envelope.js";

function validEnvelope(): Record<string, unknown> {
  return {
    contract_version: "v1",
    source: "wecom",
    event_id: "evt_01J8XK3M4N5P6Q7R8S9T0V1W",
    event_type: "message.received",
    timestamp: "2026-09-28T10:00:00.000Z",
    session_id: "wmAb3xK9Qf",
    correlation_id: "evt_01J8XK3M4N5P6Q7R8S9T0V1W",
    hop_count: 0,
    payload: { text: "hello" },
  };
}

describe("validateEnvelope", () => {
  it("合法信封（不含 producer_business_id）→ ok", () => {
    expect(validateEnvelope(validEnvelope())).toEqual({ ok: true });
  });

  it("合法信封（含 producer_business_id）→ ok", () => {
    const envelope = { ...validEnvelope(), producer_business_id: "b01J8xk" };
    expect(validateEnvelope(envelope)).toEqual({ ok: true });
  });

  it.each([
    "contract_version",
    "source",
    "event_id",
    "event_type",
    "timestamp",
    "session_id",
    "correlation_id",
    "hop_count",
    "payload",
  ])("缺少必填字段 %s → 报对应错误", (field) => {
    const envelope = validEnvelope();
    delete envelope[field];
    const result = validateEnvelope(envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(`missing required field: ${field}`);
    }
  });

  it.each([null, undefined, "not-an-object", 42, []])(
    "非 plain object（%s）→ 报错",
    (input) => {
      const result = validateEnvelope(input);
      expect(result.ok).toBe(false);
    },
  );

  it("contract_version 非 v1 → 报错", () => {
    const result = validateEnvelope({
      ...validEnvelope(),
      contract_version: "v2",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("contract_version"))).toBe(
        true,
      );
    }
  });

  it("source 枚举外 → 报错", () => {
    const result = validateEnvelope({ ...validEnvelope(), source: "slack" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("source"))).toBe(true);
    }
  });

  it.each(["event_id", "event_type", "session_id", "correlation_id"])(
    "%s 为空字符串 → 报错",
    (field) => {
      const result = validateEnvelope({ ...validEnvelope(), [field]: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes(field))).toBe(true);
      }
    },
  );

  it("hop_count 为负数 → 报错", () => {
    const result = validateEnvelope({ ...validEnvelope(), hop_count: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("hop_count"))).toBe(true);
    }
  });

  it("hop_count 为非整数 → 报错", () => {
    const result = validateEnvelope({ ...validEnvelope(), hop_count: 0.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("hop_count"))).toBe(true);
    }
  });

  it("timestamp 无时区偏移 → 报错", () => {
    const result = validateEnvelope({
      ...validEnvelope(),
      timestamp: "2026-09-28T10:00:00.000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("timestamp"))).toBe(true);
    }
  });

  it("timestamp 带数字时区偏移 → ok", () => {
    const result = validateEnvelope({
      ...validEnvelope(),
      timestamp: "2026-09-28T18:00:00.000+08:00",
    });
    expect(result).toEqual({ ok: true });
  });

  it("timestamp 无法解析 → 报错", () => {
    const result = validateEnvelope({
      ...validEnvelope(),
      timestamp: "not-a-dateZ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("timestamp"))).toBe(true);
    }
  });

  it("producer_business_id 为空字符串 → 报错", () => {
    const result = validateEnvelope({
      ...validEnvelope(),
      producer_business_id: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes("producer_business_id")),
      ).toBe(true);
    }
  });

  it("携带未知额外字段 → ok（兼容规则）", () => {
    const envelope = { ...validEnvelope(), future_field: { nested: [1, 2] } };
    expect(validateEnvelope(envelope)).toEqual({ ok: true });
  });

  it("多错误同时存在 → errors 数组全部列出", () => {
    const result = validateEnvelope({
      ...validEnvelope(),
      contract_version: "v9",
      source: "slack",
      hop_count: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("contract_version"))).toBe(
        true,
      );
      expect(result.errors.some((e) => e.includes("source"))).toBe(true);
      expect(result.errors.some((e) => e.includes("hop_count"))).toBe(true);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
