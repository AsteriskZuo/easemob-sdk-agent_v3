import type { EventEnvelope } from "@asterisk/agent-contracts";
import { newEventId, newUlid } from "@asterisk/agent-contracts";
import type { BusinessMatch } from "@asterisk/agent-registry";
import { deriveEvent } from "../src/index.js";
import type { ExecutionResult } from "../src/index.js";

function makeUpstream(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    contract_version: "v1",
    source: "webhook",
    event_id: newEventId(),
    event_type: "message.received",
    timestamp: new Date().toISOString(),
    session_id: `sess_${newUlid()}`,
    correlation_id: `corr_${newUlid()}`,
    hop_count: 2,
    payload: { text: "hello" },
    ...overrides,
  };
}

function makeProducer(businessId = "b001"): BusinessMatch {
  return {
    business_id: businessId,
    business_name: "测试业务",
    creator_id: "u1",
    source: "webhook",
    event_type: "message.received",
  };
}

describe("deriveEvent", () => {
  it("success：全字段逐条断言", () => {
    const upstream = makeUpstream();
    const output = { answer: 42 };
    const result: ExecutionResult = { status: "success", output };
    const next = deriveEvent(upstream, makeProducer(), result);

    expect(next.contract_version).toBe("v1");
    expect(typeof next.event_id).toBe("string");
    expect(next.event_id.startsWith("evt_")).toBe(true);
    expect(next.event_id.length).toBeGreaterThan(0);
    expect(next.event_id).not.toBe(upstream.event_id);
    expect(Number.isNaN(Date.parse(next.timestamp))).toBe(false);
    expect(next.source).toBe("internal");
    expect(next.producer_business_id).toBe("b001");
    expect(next.hop_count).toBe(upstream.hop_count + 1);
    expect(next.correlation_id).toBe(upstream.correlation_id);
    expect(next.session_id).toBe(upstream.session_id);
    expect(next.event_type).toBe("b001.completed");
    expect(next.payload).toBe(output); // 原样（引用相等）
  });

  it("failed：event_type=b.failed、payload 包装 {status, output}", () => {
    const upstream = makeUpstream();
    const result: ExecutionResult = { status: "failed", output: "boom" };
    const next = deriveEvent(upstream, makeProducer(), result);

    expect(next.event_type).toBe("b001.failed");
    expect(next.source).toBe("internal");
    expect(next.hop_count).toBe(upstream.hop_count + 1);
    expect(next.payload).toEqual({ status: "failed", output: "boom" });
  });

  it("timeout：同 failed 形态", () => {
    const upstream = makeUpstream();
    const result: ExecutionResult = { status: "timeout", output: undefined };
    const next = deriveEvent(upstream, makeProducer(), result);

    expect(next.event_type).toBe("b001.failed");
    expect(next.payload).toEqual({ status: "timeout", output: null });
  });

  it("output 为 undefined 时 failed payload.output=null", () => {
    const result: ExecutionResult = { status: "failed", output: undefined };
    const next = deriveEvent(makeUpstream(), makeProducer(), result);
    expect(next.payload).toEqual({ status: "failed", output: null });
  });

  it("hop_count 从 0 起步 +1；business_id 取 producer 行", () => {
    const upstream = makeUpstream({ hop_count: 0 });
    const next = deriveEvent(upstream, makeProducer("bXYZ"), {
      status: "success",
      output: null,
    });
    expect(next.hop_count).toBe(1);
    expect(next.event_type).toBe("bXYZ.completed");
    expect(next.producer_business_id).toBe("bXYZ");
  });
});
