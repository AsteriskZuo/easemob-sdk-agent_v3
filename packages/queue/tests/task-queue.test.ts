import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { newEventId, newUlid } from "@asteriskzuo/agent-contracts";
import { createTaskQueue } from "../src/index.js";
import type { TaskQueue } from "../src/index.js";

let tmpDir: string;
let dbPath: string;
let db: Database;
let queue: TaskQueue;

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
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

function rowCount(table: string): number {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-queue-test-"));
  dbPath = join(tmpDir, "queue.db");
  db = openDatabase(dbPath);
  queue = createTaskQueue(db, "entry_tasks");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("enqueue", () => {
  it("enqueue 后 query 能查到，status=pending，字段完整", () => {
    const event = makeEnvelope();
    const task = queue.enqueue(event);

    expect(task.task_id).toMatch(/^task_[0-9A-Z]{26}$/);
    expect(task.status).toBe("pending");
    expect(task.event).toEqual(event);
    expect(typeof task.enqueued_at).toBe("string");
    expect(Number.isNaN(Date.parse(task.enqueued_at))).toBe(false);

    const found = queue.query({ status: "pending" });
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(task);
  });

  it("非法信封 enqueue 抛错、不落库", () => {
    const invalid = { ...makeEnvelope(), hop_count: -1 };
    expect(() => queue.enqueue(invalid)).toThrow(/非法事件信封/);
    expect(rowCount("entry_tasks")).toBe(0);
  });

  it("同 event_id 重复 enqueue 返回同一 task_id，行数不增", () => {
    const event = makeEnvelope();
    const first = queue.enqueue(event);
    const second = queue.enqueue({ ...event });

    expect(second.task_id).toBe(first.task_id);
    expect(second.status).toBe(first.status);
    expect(second.enqueued_at).toBe(first.enqueued_at);
    expect(rowCount("entry_tasks")).toBe(1);
  });
});

describe("take", () => {
  it("FIFO 序：入队 A、B、C 依次取出；空队列返回 null", () => {
    const a = queue.enqueue(makeEnvelope());
    const b = queue.enqueue(makeEnvelope());
    const c = queue.enqueue(makeEnvelope());

    expect(queue.take()?.task_id).toBe(a.task_id);
    expect(queue.take()?.task_id).toBe(b.task_id);
    expect(queue.take()?.task_id).toBe(c.task_id);
    expect(queue.take()).toBeNull();
  });

  it("take 后状态为 processing", () => {
    const task = queue.enqueue(makeEnvelope());
    const taken = queue.take();

    expect(taken?.task_id).toBe(task.task_id);
    expect(taken?.status).toBe("processing");
    expect(queue.query({ status: "processing" })).toHaveLength(1);
    expect(queue.query({ status: "pending" })).toHaveLength(0);
  });
});

describe("complete", () => {
  it("complete 后状态为 done 且写入 finished_at", () => {
    queue.enqueue(makeEnvelope());
    const taken = queue.take();
    queue.complete(taken!.task_id);

    const [task] = queue.query({ status: "done" });
    expect(task.task_id).toBe(taken!.task_id);
    expect(typeof task.finished_at).toBe("string");
    expect(Number.isNaN(Date.parse(task.finished_at!))).toBe(false);
  });

  it("complete 不存在的 task_id 抛错", () => {
    expect(() => queue.complete("task_nonexistent")).toThrow(/任务不存在/);
  });
});

describe("deadLetter", () => {
  it("deadLetter 后状态为 dead 且 reason 落库可查", () => {
    queue.enqueue(makeEnvelope());
    const taken = queue.take();
    queue.deadLetter(taken!.task_id, "hop_count 超阈值");

    const [task] = queue.query({ status: "dead" });
    expect(task.task_id).toBe(taken!.task_id);
    expect(typeof task.finished_at).toBe("string");

    const row = db.get<{ dead_reason: string }>(
      "SELECT dead_reason FROM entry_tasks WHERE task_id = ?",
      [taken!.task_id],
    );
    expect(row?.dead_reason).toBe("hop_count 超阈值");
  });

  it("deadLetter 不存在的 task_id 抛错", () => {
    expect(() => queue.deadLetter("task_nonexistent", "x")).toThrow(
      /任务不存在/,
    );
  });
});

describe("query", () => {
  it("status / event_id / correlation_id 三种 filter 各自生效", () => {
    const e1 = makeEnvelope({ correlation_id: "corr_alpha" });
    const e2 = makeEnvelope({ correlation_id: "corr_beta" });
    const t1 = queue.enqueue(e1);
    queue.enqueue(e2);
    queue.take(); // t1 -> processing

    expect(queue.query({ status: "processing" }).map((t) => t.task_id)).toEqual(
      [t1.task_id],
    );
    expect(queue.query({ status: "pending" })).toHaveLength(1);

    expect(queue.query({ event_id: e1.event_id })).toHaveLength(1);
    expect(queue.query({ event_id: e1.event_id })[0].task_id).toBe(t1.task_id);
    expect(queue.query({ event_id: "evt_nonexistent" })).toHaveLength(0);

    expect(queue.query({ correlation_id: "corr_alpha" })).toHaveLength(1);
    expect(queue.query({ correlation_id: "corr_alpha" })[0].event).toEqual(e1);
    expect(queue.query({ correlation_id: "corr_nonexistent" })).toHaveLength(0);
  });

  it("空 filter 返回全部任务", () => {
    queue.enqueue(makeEnvelope());
    queue.enqueue(makeEnvelope());
    expect(queue.query({})).toHaveLength(2);
  });
});

describe("recover", () => {
  it("processing 残留重置回 pending，返回条数正确，可被 take 重新取出", () => {
    queue.enqueue(makeEnvelope());
    queue.enqueue(makeEnvelope());
    const first = queue.take();
    queue.enqueue(makeEnvelope());

    expect(queue.recover()).toBe(1);
    expect(queue.query({ status: "processing" })).toHaveLength(0);
    expect(queue.query({ status: "pending" })).toHaveLength(3);

    const retaken = queue.take();
    expect(retaken?.task_id).toBe(first!.task_id);
    expect(retaken?.status).toBe("processing");
  });

  it("无残留时返回 0", () => {
    queue.enqueue(makeEnvelope());
    expect(queue.recover()).toBe(0);
  });
});

describe("purge", () => {
  it("done 且超期的被删、返回条数正确；其余状态不受影响", () => {
    // 超期 done
    const t1 = queue.enqueue(makeEnvelope());
    queue.take();
    queue.complete(t1.task_id);
    db.run("UPDATE entry_tasks SET finished_at = ? WHERE task_id = ?", [
      "2020-01-01T00:00:00.000Z",
      t1.task_id,
    ]);

    // 未超期 done
    const t2 = queue.enqueue(makeEnvelope());
    queue.take();
    queue.complete(t2.task_id);
    db.run("UPDATE entry_tasks SET finished_at = ? WHERE task_id = ?", [
      "2999-01-01T00:00:00.000Z",
      t2.task_id,
    ]);

    // dead
    const t3 = queue.enqueue(makeEnvelope());
    queue.take();
    queue.deadLetter(t3.task_id, "投递失败");
    db.run("UPDATE entry_tasks SET finished_at = ? WHERE task_id = ?", [
      "2020-01-01T00:00:00.000Z",
      t3.task_id,
    ]);

    // pending
    queue.enqueue(makeEnvelope());
    // processing
    queue.enqueue(makeEnvelope());
    queue.take();

    const deleted = queue.purge("2026-01-01T00:00:00.000Z");
    expect(deleted).toBe(1);
    expect(rowCount("entry_tasks")).toBe(4);
    expect(queue.query({ status: "done" })).toHaveLength(1);
    expect(queue.query({ status: "dead" })).toHaveLength(1);
    expect(queue.query({ status: "pending" })).toHaveLength(1);
    expect(queue.query({ status: "processing" })).toHaveLength(1);
  });

  it("无可删任务时返回 0", () => {
    queue.enqueue(makeEnvelope());
    expect(queue.purge("2026-01-01T00:00:00.000Z")).toBe(0);
    expect(rowCount("entry_tasks")).toBe(1);
  });
});

describe("持久化", () => {
  it("enqueue 后 close 重开，任务仍在且状态不变；迁移幂等", () => {
    const event = makeEnvelope();
    const task = queue.enqueue(event);
    queue.take(); // -> processing
    db.close();

    db = openDatabase(dbPath);
    queue = createTaskQueue(db, "entry_tasks"); // 重跑迁移不报错

    const [found] = queue.query({ event_id: event.event_id });
    expect(found.task_id).toBe(task.task_id);
    expect(found.status).toBe("processing");
    expect(found.event).toEqual(event);
    expect(found.enqueued_at).toBe(task.enqueued_at);
    expect(rowCount("entry_tasks")).toBe(1);
  });
});

describe("双队列实例", () => {
  it("entry_tasks / exit_tasks 同库共存、互不干扰，同 event_id 可分别入两队", () => {
    const exitQueue = createTaskQueue(db, "exit_tasks");
    const event = makeEnvelope();

    const entryTask = queue.enqueue(event);
    const exitTask = exitQueue.enqueue({ ...event });

    expect(entryTask.task_id).not.toBe(exitTask.task_id);
    expect(rowCount("entry_tasks")).toBe(1);
    expect(rowCount("exit_tasks")).toBe(1);

    exitQueue.take();
    expect(queue.query({ status: "pending" })).toHaveLength(1);
    expect(exitQueue.query({ status: "processing" })).toHaveLength(1);
    expect(exitQueue.query({ status: "pending" })).toHaveLength(0);
  });
});
