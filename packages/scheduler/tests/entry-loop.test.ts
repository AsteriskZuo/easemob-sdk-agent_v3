import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import type { EventEnvelope } from "@asterisk/agent-contracts";
import { newEventId, newUlid } from "@asterisk/agent-contracts";
import { createTaskQueue } from "@asterisk/agent-queue";
import type { Task, TaskQueue } from "@asterisk/agent-queue";
import { createBusinessRegistry } from "@asterisk/agent-registry";
import type { BusinessMatch, BusinessRegistry } from "@asterisk/agent-registry";
import { createChannelPool } from "@asterisk/agent-channel";
import type { ChannelPool } from "@asterisk/agent-channel";
import { initLogger, resetForTests } from "@asterisk/agent-logger";
import { createEntryLoop } from "../src/index.js";
import type {
  EntryDriver,
  ExecutionResult,
  SchedulerLoop,
} from "../src/index.js";

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

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    contract_version: "v1",
    source: "webhook",
    event_id: newEventId(),
    event_type: "message.received",
    timestamp: new Date().toISOString(),
    session_id: `sess_${newUlid()}`,
    correlation_id: `corr_${newUlid()}`,
    hop_count: 0,
    payload: { text: "hello" },
    ...overrides,
  };
}

interface ExecInterval {
  task_id: string;
  business_id: string;
  startedAt: number;
  endedAt?: number;
}

class FakeEntryDriver implements EntryDriver {
  calls: Array<{ task: Task; watcher: BusinessMatch }> = [];
  intervals: ExecInterval[] = [];
  handler: (task: Task, bm: BusinessMatch) => Promise<ExecutionResult> =
    async () => ({ status: "success", output: { ok: true } });

  async execute(task: Task, watcher: BusinessMatch): Promise<ExecutionResult> {
    this.calls.push({ task, watcher });
    const rec: ExecInterval = {
      task_id: task.task_id,
      business_id: watcher.business_id,
      startedAt: performance.now(),
    };
    this.intervals.push(rec);
    try {
      return await this.handler(task, watcher);
    } finally {
      rec.endedAt = performance.now();
    }
  }
}

let tmpDir: string;
let db: Database;
let entryQueue: TaskQueue;
let exitQueue: TaskQueue;
let registry: BusinessRegistry;
let channels: ChannelPool;
let driver: FakeEntryDriver;
let loop: SchedulerLoop | undefined;

const CONFIG = { hop_limit: 8, task_concurrency: 4, result_concurrency: 4 };
const OPTIONS = { pollIntervalMs: 5 };

function startLoop(
  overrides: Partial<typeof CONFIG> = {},
  reg: BusinessRegistry = registry,
): SchedulerLoop {
  loop = createEntryLoop({
    queue: entryQueue,
    exitQueue,
    registry: reg,
    channels,
    config: { ...CONFIG, ...overrides },
    driver,
    options: OPTIONS,
  });
  loop.start();
  return loop;
}

function createBusiness(
  eventType = "message.received",
  onFailure?: boolean,
): string {
  return registry.create({
    business_name: "测试业务",
    creator_id: "u1",
    source: "webhook",
    event_type: eventType,
    ...(onFailure !== undefined ? { on_failure: onFailure } : {}),
  });
}

function deadReason(table: string, taskId: string): string | undefined {
  const row = db.get<{ dead_reason: string | null }>(
    `SELECT dead_reason FROM ${table} WHERE task_id = ?`,
    [taskId],
  );
  return row?.dead_reason ?? undefined;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-scheduler-entry-test-"));
  initLogger({ logsDir: tmpDir });
});

afterAll(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDatabase(":memory:");
  entryQueue = createTaskQueue(db, "entry_tasks");
  exitQueue = createTaskQueue(db, "exit_tasks");
  registry = createBusinessRegistry(db);
  channels = createChannelPool(db);
  driver = new FakeEntryDriver();
  loop = undefined;
});

afterEach(async () => {
  await loop?.stop();
  db.close();
});

describe("入口事件循环", () => {
  it("1. 无关注者 → 任务 done、driver 未被调", async () => {
    const event = makeEvent();
    const task = entryQueue.enqueue(event);
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done",
    );
    expect(driver.calls).toHaveLength(0);
    expect(entryQueue.query({ event_id: event.event_id })[0]?.task_id).toBe(
      task.task_id,
    );
  });

  it("2. 单关注者成功 → driver 收到 (task, bm)；两队各多一条派生任务且字段正确；原任务 done", async () => {
    const businessId = createBusiness();
    const event = makeEvent();
    const task = entryQueue.enqueue(event);
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done",
    );

    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.task.task_id).toBe(task.task_id);
    expect(driver.calls[0]?.watcher.business_id).toBe(businessId);
    expect(driver.calls[0]?.watcher.source).toBe("webhook");
    expect(driver.calls[0]?.watcher.event_type).toBe("message.received");

    // 入口队列：同 correlation_id 下多一条派生任务
    const related = entryQueue.query({ correlation_id: event.correlation_id });
    expect(related).toHaveLength(2);
    const derived = related.find((t) => t.event.event_id !== event.event_id);
    expect(derived).toBeDefined();
    expect(derived?.event.source).toBe("internal");
    expect(derived?.event.event_type).toBe(`${businessId}.completed`);
    expect(derived?.event.hop_count).toBe(1);
    expect(derived?.event.producer_business_id).toBe(businessId);
    expect(derived?.event.session_id).toBe(event.session_id);
    expect(derived?.event.correlation_id).toBe(event.correlation_id);
    expect(derived?.event.payload).toEqual({ ok: true });

    // 出口队列：同一派生事件 pending（本测试不跑出口循环）
    const exitTasks = exitQueue.query({
      event_id: derived?.event.event_id ?? "",
    });
    expect(exitTasks).toHaveLength(1);
    expect(exitTasks[0]?.status).toBe("pending");
  });

  it("3. 同通道串行：同 (source, session_id, business_id) 两事件 → 执行区间不重叠且顺序 = 入队序", async () => {
    createBusiness();
    const sessionId = `sess_${newUlid()}`;
    const e1 = makeEvent({ session_id: sessionId });
    const e2 = makeEvent({ session_id: sessionId });
    const t1 = entryQueue.enqueue(e1);
    const t2 = entryQueue.enqueue(e2);
    driver.handler = async () => {
      await delay(20);
      return { status: "success", output: null };
    };
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: e1.event_id })[0]?.status === "done" &&
        entryQueue.query({ event_id: e2.event_id })[0]?.status === "done",
    );

    expect(driver.intervals).toHaveLength(2);
    expect(driver.intervals[0]?.task_id).toBe(t1.task_id);
    expect(driver.intervals[1]?.task_id).toBe(t2.task_id);
    const [first, second] = driver.intervals;
    expect(first?.endedAt ?? 0).toBeLessThanOrEqual(second?.startedAt ?? 0);
  });

  it("4. 跨通道并行：两个 session_id 各一事件 → driver 执行区间重叠（barrier 证明）", async () => {
    createBusiness();
    const e1 = makeEvent();
    const e2 = makeEvent();
    entryQueue.enqueue(e1);
    entryQueue.enqueue(e2);

    let started = 0;
    let bothStarted!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    driver.handler = async () => {
      started += 1;
      if (started === 2) {
        bothStarted();
      }
      // 串行执行时先到者会卡在 barrier 上 → 超时失败，以此证明并行
      await Promise.race([
        barrier,
        delay(800).then(() => {
          throw new Error("两个不同通道的执行未并行");
        }),
      ]);
      return { status: "success", output: null };
    };
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: e1.event_id })[0]?.status === "done" &&
        entryQueue.query({ event_id: e2.event_id })[0]?.status === "done",
    );

    expect(driver.intervals).toHaveLength(2);
    const [a, b] = driver.intervals;
    // 区间重叠：互相的 start 都在对方 end 之前
    expect(a?.startedAt ?? 0).toBeLessThan(b?.endedAt ?? 0);
    expect(b?.startedAt ?? 0).toBeLessThan(a?.endedAt ?? 0);
  });

  it("5. 闸门生效：task_concurrency=1 时两个不同通道也串行", async () => {
    createBusiness();
    const e1 = makeEvent();
    const e2 = makeEvent();
    entryQueue.enqueue(e1);
    entryQueue.enqueue(e2);
    driver.handler = async () => {
      await delay(20);
      return { status: "success", output: null };
    };
    startLoop({ task_concurrency: 1 });
    await waitFor(
      () =>
        entryQueue.query({ event_id: e1.event_id })[0]?.status === "done" &&
        entryQueue.query({ event_id: e2.event_id })[0]?.status === "done",
    );

    expect(driver.intervals).toHaveLength(2);
    const [first, second] = driver.intervals;
    expect(first?.endedAt ?? 0).toBeLessThanOrEqual(second?.startedAt ?? 0);
  });

  it("6. 失败不扇出：on_failure 默认 false + driver 返回 failed → 两队均无新任务，原任务 done", async () => {
    createBusiness();
    const event = makeEvent();
    entryQueue.enqueue(event);
    driver.handler = async () => ({ status: "failed", output: "boom" });
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done",
    );
    await delay(30); // 给潜在的错误扇出一个窗口

    expect(driver.calls).toHaveLength(1);
    expect(
      entryQueue.query({ correlation_id: event.correlation_id }),
    ).toHaveLength(1);
    expect(exitQueue.query({})).toHaveLength(0);
  });

  it("7. 失败扇出：on_failure: true + failed → 两队各有 b.failed 事件，payload 带 status", async () => {
    const businessId = createBusiness("message.received", true);
    const event = makeEvent();
    entryQueue.enqueue(event);
    driver.handler = async () => ({ status: "failed", output: "boom" });
    startLoop();
    await waitFor(
      () =>
        exitQueue.query({ correlation_id: event.correlation_id }).length === 1,
    );

    const exitTask = exitQueue.query({
      correlation_id: event.correlation_id,
    })[0];
    expect(exitTask?.event.event_type).toBe(`${businessId}.failed`);
    expect(exitTask?.event.producer_business_id).toBe(businessId);
    expect(exitTask?.event.payload).toEqual({
      status: "failed",
      output: "boom",
    });

    const related = entryQueue.query({ correlation_id: event.correlation_id });
    const derived = related.find((t) => t.event.event_id !== event.event_id);
    expect(derived?.event.event_type).toBe(`${businessId}.failed`);
    expect(derived?.event.payload).toEqual({
      status: "failed",
      output: "boom",
    });
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done",
    );
  });

  it("8. driver 抛异常 → 合成 failed（行为同 6：不扇出、原任务 done）", async () => {
    createBusiness();
    const event = makeEvent();
    entryQueue.enqueue(event);
    driver.handler = async () => {
      throw new Error("基础设施异常");
    };
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done",
    );
    await delay(30);

    expect(driver.calls).toHaveLength(1);
    expect(
      entryQueue.query({ correlation_id: event.correlation_id }),
    ).toHaveLength(1);
    expect(exitQueue.query({})).toHaveLength(0);
  });

  it("9. hop 超限：hop_count=hop_limit 的事件执行完结后两队各一条 dead(reason hop_limit)，原任务 done", async () => {
    createBusiness();
    const event = makeEvent({ hop_count: 8 }); // hop_limit = 8
    entryQueue.enqueue(event);
    startLoop();
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done" &&
        exitQueue.query({ status: "dead" }).length === 1,
    );

    const entryDead = entryQueue.query({ status: "dead" });
    const exitDead = exitQueue.query({ status: "dead" });
    expect(entryDead).toHaveLength(1);
    expect(exitDead).toHaveLength(1);
    // 派生事件 event_id 可查：两队死信是同一事件
    const derivedEventId = entryDead[0]?.event.event_id ?? "";
    expect(derivedEventId).not.toBe(event.event_id);
    expect(exitDead[0]?.event.event_id).toBe(derivedEventId);
    expect(entryDead[0]?.event.hop_count).toBe(9);
    expect(deadReason("entry_tasks", entryDead[0]?.task_id ?? "")).toBe(
      "hop_limit",
    );
    expect(deadReason("exit_tasks", exitDead[0]?.task_id ?? "")).toBe(
      "hop_limit",
    );
    // 派生事件 event_id 可按 id 查到
    expect(entryQueue.query({ event_id: derivedEventId })).toHaveLength(1);
  });

  it("10. 任务级完结计数：一事件两关注者，快者完结后任务仍 processing，慢者完结后才 done", async () => {
    const bFast = createBusiness();
    const bSlow = createBusiness();
    const event = makeEvent();
    entryQueue.enqueue(event);

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    driver.handler = async (_task, bm) => {
      if (bm.business_id === bSlow) {
        await slowGate;
      }
      return { status: "success", output: null };
    };
    startLoop();
    // 快者完结（不同 business → 不同通道，与慢者并行执行）
    await waitFor(() =>
      driver.intervals.some(
        (r) => r.business_id === bFast && r.endedAt !== undefined,
      ),
    );
    expect(entryQueue.query({ event_id: event.event_id })[0]?.status).toBe(
      "processing",
    );

    releaseSlow();
    await waitFor(
      () =>
        entryQueue.query({ event_id: event.event_id })[0]?.status === "done",
    );
    expect(driver.calls).toHaveLength(2);
  });

  it("11. 派发异常：registry.match 抛错 → 任务 dead(reason dispatch_error)，循环继续消化后续任务", async () => {
    createBusiness();
    const throwingRegistry: BusinessRegistry = {
      match: (source, eventType) => {
        if (eventType === "poison") {
          throw new Error("匹配爆炸");
        }
        return registry.match(source, eventType);
      },
      exitBindings: (id) => registry.exitBindings(id),
      get: (id) => registry.get(id),
      update: (id, patch) => registry.update(id, patch),
      create: (input) => registry.create(input),
      addMatch: (id, source, eventType) =>
        registry.addMatch(id, source, eventType),
      removeMatch: (id, source, eventType) =>
        registry.removeMatch(id, source, eventType),
      remove: (id) => registry.remove(id),
    };

    const poison = makeEvent({ event_type: "poison" });
    entryQueue.enqueue(poison);
    startLoop({}, throwingRegistry);
    await waitFor(
      () =>
        entryQueue.query({ event_id: poison.event_id })[0]?.status === "dead",
    );
    const poisonTask = entryQueue.query({ event_id: poison.event_id })[0];
    expect(deadReason("entry_tasks", poisonTask?.task_id ?? "")).toBe(
      "dispatch_error",
    );

    // 循环未崩溃：后续正常任务照常消化
    const normal = makeEvent();
    entryQueue.enqueue(normal);
    await waitFor(
      () =>
        entryQueue.query({ event_id: normal.event_id })[0]?.status === "done",
    );
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.task.event.event_id).toBe(normal.event_id);
  });
});
