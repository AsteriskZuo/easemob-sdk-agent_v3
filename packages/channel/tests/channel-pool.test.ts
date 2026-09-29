import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";
import type { EventEnvelope } from "@easemob/agent-contracts";
import { newEventId, newUlid } from "@easemob/agent-contracts";
import type { Task } from "@easemob/agent-queue";
import { createChannelPool } from "../src/index.js";
import type { Channel, ChannelItem, ChannelPool } from "../src/index.js";

let tmpDir: string;
let dbPath: string;
let db: Database;
let pool: ChannelPool;

function makeTask(): Task {
  const event: EventEnvelope = {
    contract_version: "v1",
    source: "webhook",
    event_id: newEventId(),
    event_type: "message.received",
    timestamp: new Date().toISOString(),
    session_id: `sess_${newUlid()}`,
    correlation_id: `corr_${newUlid()}`,
    hop_count: 0,
    payload: { text: "hello" },
  };
  return {
    task_id: `task_${newUlid()}`,
    event,
    status: "pending",
    enqueued_at: new Date().toISOString(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起一次 drain：for await 消费到迭代器自然结束，返回取出的项 */
async function collect(
  channel: Channel,
  onItem?: (item: ChannelItem) => void | Promise<void>,
): Promise<ChannelItem[]> {
  const items: ChannelItem[] = [];
  for await (const item of channel) {
    items.push(item);
    await onItem?.(item);
  }
  return items;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-channel-test-"));
  dbPath = join(tmpDir, "channel.db");
  db = openDatabase(dbPath);
  pool = createChannelPool(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("get", () => {
  it("同键返回同一 Channel 实例，不同键不同实例", () => {
    const a1 = pool.get("src__sess__biz_a");
    const a2 = pool.get("src__sess__biz_a");
    const b = pool.get("src__sess__biz_b");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.key).toBe("src__sess__biz_a");
    expect(b.key).toBe("src__sess__biz_b");
  });
});

describe("串行性", () => {
  it("同通道 enqueue 三项，for await 按 enqueue 顺序取出", async () => {
    const channel = pool.get("src__sess__biz");
    const tasks = [makeTask(), makeTask(), makeTask()];
    for (const task of tasks) {
      channel.enqueue(task, null);
    }

    const items = await collect(channel);
    expect(items.map((i) => i.task.task_id)).toEqual(
      tasks.map((t) => t.task_id),
    );
  });

  it("慢消费期间再 enqueue，仍严格有序", async () => {
    const channel = pool.get("src__sess__biz");
    const t1 = makeTask();
    const t2 = makeTask();
    const t3 = makeTask();
    channel.enqueue(t1, null);

    const items = await collect(channel, async (item) => {
      if (item.task.task_id === t1.task_id) {
        await delay(20);
        channel.enqueue(t2, null);
        await delay(20);
        channel.enqueue(t3, null);
      }
    });

    expect(items.map((i) => i.task.task_id)).toEqual([
      t1.task_id,
      t2.task_id,
      t3.task_id,
    ]);
  });
});

describe("并行性", () => {
  it("两个通道各自消费互不阻塞：快通道不等慢通道", async () => {
    const slow = pool.get("src__sess__slow");
    const fast = pool.get("src__sess__fast");
    slow.enqueue(makeTask(), null);
    fast.enqueue(makeTask(), null);

    const finishOrder: string[] = [];
    await Promise.all([
      collect(slow, async () => {
        await delay(50);
        finishOrder.push("slow");
      }),
      collect(fast, () => {
        finishOrder.push("fast");
      }),
    ]);

    expect(finishOrder[0]).toBe("fast");
    expect(finishOrder).toHaveLength(2);
  });
});

describe("用完即焚 + 重启", () => {
  it("迭代器结束后再 enqueue：onActivate 再次触发，新迭代正常消费", async () => {
    let activateCount = 0;
    pool.onActivate(() => {
      activateCount += 1;
    });
    const channel = pool.get("src__sess__biz");

    const t1 = makeTask();
    channel.enqueue(t1, null);
    expect(activateCount).toBe(1);
    const first = await collect(channel);
    expect(first.map((i) => i.task.task_id)).toEqual([t1.task_id]);

    const t2 = makeTask();
    channel.enqueue(t2, null);
    expect(activateCount).toBe(2);
    const second = await collect(channel);
    expect(second.map((i) => i.task.task_id)).toEqual([t2.task_id]);
  });
});

describe("onActivate 触发纪律", () => {
  it("空闲通道连续挂入只触发一次；drain 进行中 enqueue 不重复触发", async () => {
    let activateCount = 0;
    pool.onActivate(() => {
      activateCount += 1;
    });
    const channel = pool.get("src__sess__biz");

    const t1 = makeTask();
    const t2 = makeTask();
    const t3 = makeTask();
    channel.enqueue(t1, null);
    channel.enqueue(t2, null);
    channel.enqueue(t3, null);
    expect(activateCount).toBe(1);

    const t4 = makeTask();
    const items = await collect(channel, (item) => {
      if (item.task.task_id === t1.task_id) {
        channel.enqueue(t4, null); // drain 进行中挂入
      }
    });

    expect(activateCount).toBe(1);
    expect(items.map((i) => i.task.task_id)).toEqual([
      t1.task_id,
      t2.task_id,
      t3.task_id,
      t4.task_id,
    ]);
  });
});

describe("竞态", () => {
  it("enqueue 落在迭代器判空退出的等待窗口内：任务不丢失、不触发二次激活", async () => {
    let activateCount = 0;
    pool.onActivate(() => {
      activateCount += 1;
    });
    const channel = pool.get("src__sess__biz");

    const t1 = makeTask();
    const t2 = makeTask();
    channel.enqueue(t1, null);

    const items = await collect(channel, (item) => {
      if (item.task.task_id === t1.task_id) {
        // 宏任务保证 enqueue 落在迭代器"队列空、等待新项"的窗口内
        setTimeout(() => channel.enqueue(t2, null), 0);
      }
    });

    expect(items.map((i) => i.task.task_id)).toEqual([t1.task_id, t2.task_id]);
    expect(activateCount).toBe(1);
  });

  it("同一时刻最多一个活跃迭代器：drain 进行中再起迭代器抛错", async () => {
    const channel = pool.get("src__sess__biz");
    channel.enqueue(makeTask(), null);

    const first = channel[Symbol.asyncIterator]();
    await first.next(); // 激活第一个迭代器

    const second = channel[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow(/最多一个活跃迭代器/);

    await first.return(undefined);

    // 第一个迭代器结束后可以重新迭代
    const items = await collect(channel);
    expect(items).toHaveLength(0);
  });
});

describe("落库", () => {
  it("get 创建通道后 channels 表有记录（channel_id/created_at），同键重复 get 行数不增", () => {
    pool.get("src__sess__biz");
    pool.get("src__sess__biz");

    const rows = db.all<{ channel_id: string; created_at: string }>(
      "SELECT channel_id, created_at FROM channels",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe("src__sess__biz");
    expect(Number.isNaN(Date.parse(rows[0].created_at))).toBe(false);
  });

  it("重开数据库后记录仍在，迁移幂等", () => {
    pool.get("src__sess__biz");
    db.close();

    db = openDatabase(dbPath);
    pool = createChannelPool(db); // 重跑迁移不报错

    const row = db.get<{ channel_id: string }>(
      "SELECT channel_id FROM channels WHERE channel_id = ?",
      ["src__sess__biz"],
    );
    expect(row?.channel_id).toBe("src__sess__biz");
  });
});

describe("watcher 透传", () => {
  it("watcher 为任意对象原样透传（引用相等）", async () => {
    const channel = pool.get("src__sess__biz");
    const watcher = { nested: new Map([["k", 1]]) };
    channel.enqueue(makeTask(), watcher);

    const [item] = await collect(channel);
    expect(item.watcher).toBe(watcher);
  });
});
