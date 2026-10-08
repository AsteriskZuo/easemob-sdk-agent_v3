import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import type { EventEnvelope } from "@asterisk/agent-contracts";
import { newEventId, newUlid } from "@asterisk/agent-contracts";
import { createTaskQueue } from "@asterisk/agent-queue";
import type { TaskQueue } from "@asterisk/agent-queue";
import { createBusinessRegistry } from "@asterisk/agent-registry";
import type { BusinessRegistry, ExitBinding } from "@asterisk/agent-registry";
import { createChannelPool } from "@asterisk/agent-channel";
import type { ChannelPool } from "@asterisk/agent-channel";
import { initLogger, resetForTests } from "@asterisk/agent-logger";
import { createExitLoop } from "../src/index.js";
import type { ExitDriver, SchedulerLoop } from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor 超时");
    }
    await delay(5);
  }
}

/** 出口队列只装派生事件：source='internal' + producer_business_id 必在 */
function makeExitEvent(
  producerBusinessId: string,
  payload: unknown = { ok: true },
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    contract_version: "v1",
    source: "internal",
    event_id: newEventId(),
    event_type: `${producerBusinessId}.completed`,
    timestamp: new Date().toISOString(),
    session_id: `sess_${newUlid()}`,
    correlation_id: `corr_${newUlid()}`,
    hop_count: 1,
    payload,
    producer_business_id: producerBusinessId,
    ...overrides,
  };
}

interface DeliverInterval {
  tool: string;
  dest: string;
  seq: number;
  startedAt: number;
  endedAt?: number;
}

class FakeExitDriver implements ExitDriver {
  calls: Array<{ binding: ExitBinding; payload: unknown }> = [];
  intervals: DeliverInterval[] = [];
  deliverHandler: (binding: ExitBinding, payload: unknown) => Promise<void> =
    async () => {};
  private seq = 0;

  /** 从绑定配置提取投递目标；缺 dest = 未知工具/非法配置，抛错 */
  destinationOf(binding: ExitBinding): string {
    const dest = binding.config["dest"];
    if (dest === undefined || dest === "") {
      throw new Error(`未知工具: ${binding.tool}`);
    }
    return dest;
  }

  async deliver(binding: ExitBinding, payload: unknown): Promise<void> {
    this.calls.push({ binding, payload });
    const rec: DeliverInterval = {
      tool: binding.tool,
      dest: binding.config["dest"] ?? "",
      seq: this.seq,
      startedAt: performance.now(),
    };
    this.seq += 1;
    this.intervals.push(rec);
    try {
      await this.deliverHandler(binding, payload);
    } finally {
      rec.endedAt = performance.now();
    }
  }
}

let tmpDir: string;
let db: Database;
let exitQueue: TaskQueue;
let registry: BusinessRegistry;
let channels: ChannelPool;
let driver: FakeExitDriver;
let loop: SchedulerLoop | undefined;

const CONFIG = { hop_limit: 8, task_concurrency: 4, result_concurrency: 4 };
const OPTIONS = {
  pollIntervalMs: 5,
  exitRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
};

function startLoop(): SchedulerLoop {
  loop = createExitLoop({
    queue: exitQueue,
    registry,
    channels,
    config: CONFIG,
    driver,
    options: OPTIONS,
  });
  loop.start();
  return loop;
}

function createBusinessWithBindings(
  bindings: Array<{ tool: string; config: Record<string, string> }>,
): string {
  return registry.create({
    business_name: "测试业务",
    creator_id: "u1",
    source: "webhook",
    event_type: "message.received",
    exit_bindings: bindings,
  });
}

function deadReason(taskId: string): string | undefined {
  const row = db.get<{ dead_reason: string | null }>(
    "SELECT dead_reason FROM exit_tasks WHERE task_id = ?",
    [taskId],
  );
  return row?.dead_reason ?? undefined;
}

function taskStatus(eventId: string): string | undefined {
  return exitQueue.query({ event_id: eventId })[0]?.status;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-scheduler-exit-test-"));
  initLogger({ logsDir: tmpDir });
});

afterAll(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDatabase(":memory:");
  exitQueue = createTaskQueue(db, "exit_tasks");
  registry = createBusinessRegistry(db);
  channels = createChannelPool(db);
  driver = new FakeExitDriver();
  loop = undefined;
});

afterEach(async () => {
  await loop?.stop();
  db.close();
});

describe("出口事件循环", () => {
  it("1. 无出口绑定 → 任务 done、deliver 未被调", async () => {
    const businessId = createBusinessWithBindings([]);
    const event = makeExitEvent(businessId);
    exitQueue.enqueue(event);
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "done");
    expect(driver.calls).toHaveLength(0);
  });

  it("2. 正常投递：deliver 收到 binding 与 payload 原样；任务 done", async () => {
    const businessId = createBusinessWithBindings([
      { tool: "webhook-out", config: { dest: "destA", url: "https://x" } },
    ]);
    const payload = { answer: 42, nested: { ok: true } };
    const event = makeExitEvent(businessId, payload);
    exitQueue.enqueue(event);
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "done");

    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.binding.business_id).toBe(businessId);
    expect(driver.calls[0]?.binding.tool).toBe("webhook-out");
    expect(driver.calls[0]?.binding.config).toEqual({
      dest: "destA",
      url: "https://x",
    });
    expect(driver.calls[0]?.payload).toEqual(payload); // 原样（出口不做内容加工）
  });

  it("3. 同目标串行、不同目标并行", async () => {
    // 阶段一：两条绑定同一 destination → deliver 区间不重叠、顺序 = 绑定序
    const b1 = createBusinessWithBindings([
      { tool: "toolA1", config: { dest: "destA" } },
      { tool: "toolA2", config: { dest: "destA" } },
    ]);
    const e1 = makeExitEvent(b1);
    exitQueue.enqueue(e1);
    driver.deliverHandler = async () => {
      await delay(20);
    };
    startLoop();
    await waitFor(() => taskStatus(e1.event_id) === "done");

    expect(driver.intervals).toHaveLength(2);
    expect(driver.intervals[0]?.tool).toBe("toolA1");
    expect(driver.intervals[1]?.tool).toBe("toolA2");
    expect(driver.intervals[0]?.endedAt ?? 0).toBeLessThanOrEqual(
      driver.intervals[1]?.startedAt ?? 0,
    );

    // 阶段二：两条绑定不同 destination → 并行（barrier 证明）
    const b2 = createBusinessWithBindings([
      { tool: "toolB1", config: { dest: "destB1" } },
      { tool: "toolB2", config: { dest: "destB2" } },
    ]);
    const e2 = makeExitEvent(b2);
    exitQueue.enqueue(e2);

    let started = 0;
    let bothStarted!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    driver.deliverHandler = async () => {
      started += 1;
      if (started === 2) {
        bothStarted();
      }
      await Promise.race([
        barrier,
        delay(800).then(() => {
          throw new Error("两个不同目标的投递未并行");
        }),
      ]);
    };
    await waitFor(() => taskStatus(e2.event_id) === "done");

    const phaseTwo = driver.intervals.slice(2);
    expect(phaseTwo).toHaveLength(2);
    const [a, b] = phaseTwo;
    expect(a?.startedAt ?? 0).toBeLessThan(b?.endedAt ?? 0);
    expect(b?.startedAt ?? 0).toBeLessThan(a?.endedAt ?? 0);
  });

  it("4. 重试成功：deliver 前 2 次抛错第 3 次成功 → 共调 3 次、任务 done", async () => {
    const businessId = createBusinessWithBindings([
      { tool: "webhook-out", config: { dest: "destA" } },
    ]);
    const event = makeExitEvent(businessId);
    exitQueue.enqueue(event);
    let attempt = 0;
    driver.deliverHandler = async () => {
      attempt += 1;
      if (attempt < 3) {
        throw new Error(`第 ${attempt} 次失败`);
      }
    };
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "done");
    expect(driver.calls).toHaveLength(3);
  });

  it("5. 重试耗尽：deliver 恒抛错（maxAttempts=3）→ 共调 3 次、任务 dead(reason deliver_failed)", async () => {
    const businessId = createBusinessWithBindings([
      { tool: "webhook-out", config: { dest: "destA" } },
    ]);
    const event = makeExitEvent(businessId);
    exitQueue.enqueue(event);
    driver.deliverHandler = async () => {
      throw new Error("一直失败");
    };
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "dead");
    expect(driver.calls).toHaveLength(3);
    const task = exitQueue.query({ event_id: event.event_id })[0];
    expect(deadReason(task?.task_id ?? "")).toBe("deliver_failed");
  });

  it("6. 缺 producer_business_id → 任务 dead(reason missing_producer)", async () => {
    const event: EventEnvelope = {
      contract_version: "v1",
      source: "webhook", // 外部事件误入出口队列
      event_id: newEventId(),
      event_type: "message.received",
      timestamp: new Date().toISOString(),
      session_id: `sess_${newUlid()}`,
      correlation_id: `corr_${newUlid()}`,
      hop_count: 0,
      payload: {},
    };
    exitQueue.enqueue(event);
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "dead");
    const task = exitQueue.query({ event_id: event.event_id })[0];
    expect(deadReason(task?.task_id ?? "")).toBe("missing_producer");
    expect(driver.calls).toHaveLength(0);
  });

  it("7. 多绑定一失败：一条恒失败一条成功 → 全部结算后任务 dead", async () => {
    const businessId = createBusinessWithBindings([
      { tool: "bad", config: { dest: "destBad" } },
      { tool: "good", config: { dest: "destGood" } },
    ]);
    const event = makeExitEvent(businessId);
    exitQueue.enqueue(event);
    driver.deliverHandler = async (binding) => {
      if (binding.tool === "bad") {
        throw new Error("恒失败");
      }
    };
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "dead");

    const badCalls = driver.calls.filter((c) => c.binding.tool === "bad");
    const goodCalls = driver.calls.filter((c) => c.binding.tool === "good");
    expect(badCalls).toHaveLength(3); // 重试耗尽
    expect(goodCalls).toHaveLength(1); // 一次成功
    const task = exitQueue.query({ event_id: event.event_id })[0];
    expect(deadReason(task?.task_id ?? "")).toBe("deliver_failed");
  });

  it("8. destinationOf 抛错（未知 tool）→ 该绑定判失败、任务 dead，另一绑定不受影响", async () => {
    const businessId = createBusinessWithBindings([
      { tool: "unknown-tool", config: {} }, // 无 dest → destinationOf 抛错
      { tool: "good", config: { dest: "destGood" } },
    ]);
    const event = makeExitEvent(businessId);
    exitQueue.enqueue(event);
    startLoop();
    await waitFor(() => taskStatus(event.event_id) === "dead");

    // 未知工具绑定从未进入 deliver；正常绑定投递成功一次
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.binding.tool).toBe("good");
    const task = exitQueue.query({ event_id: event.event_id })[0];
    expect(deadReason(task?.task_id ?? "")).toBe("deliver_failed");
  });
});
