import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { newEventId } from "@asteriskzuo/agent-contracts";
import type { BusinessMatch } from "@asteriskzuo/agent-registry";
import type { ExecutionResult } from "./types.js";

/** 结果扇出的派生事件构造（纯函数）。调用方：入口循环 drain，业务执行完结后；
 *  构造结果由调用方判 hop_limit 后投入口队列与出口队列（或超限落库即死信）。
 *  规则：source='internal'；hop_count=上游+1；correlation_id/session_id 继承上游（源生标识全链不变）；
 *  event_type：success → `${business_id}.completed`，failed/timeout → `${business_id}.failed`；
 *  payload：success → output 原样；failed/timeout → { status, output: output ?? null } */
export function deriveEvent(
  upstream: EventEnvelope,
  producer: BusinessMatch,
  result: ExecutionResult,
): EventEnvelope {
  const success = result.status === "success";
  return {
    contract_version: "v1",
    source: "internal",
    event_id: newEventId(),
    event_type: success
      ? `${producer.business_id}.completed`
      : `${producer.business_id}.failed`,
    timestamp: new Date().toISOString(),
    session_id: upstream.session_id,
    correlation_id: upstream.correlation_id,
    hop_count: upstream.hop_count + 1,
    payload: success
      ? result.output
      : { status: result.status, output: result.output ?? null },
    producer_business_id: producer.business_id,
  };
}
