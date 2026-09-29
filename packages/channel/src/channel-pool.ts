import type { Database } from "@easemob/agent-database";
import { migrate } from "@easemob/agent-database";
import type { Task } from "@easemob/agent-queue";

/** 挂入通道的一项：任务 + 关注者（关注者类型各循环自定，本包不解释） */
export interface ChannelItem<T = unknown> {
  task: Task;
  watcher: T;
}

/** 通道：同通道严格串行的虚拟执行链。AsyncIterable——消化循环 for await 逐项取出。
 *  迭代器在队列空时结束（用完即焚）；之后再有 enqueue 须能重新迭代（经 onActivate 重启 drain） */
export interface Channel extends AsyncIterable<ChannelItem> {
  readonly key: string; // channel_id 字符串
  enqueue(task: Task, watcher: unknown): void;
}

/** 通道池：按 channel_id 取或建（创建即落库） */
export interface ChannelPool {
  get(key: string): Channel;
  /** 通道激活回调：空闲通道挂入任务时触发（每个 ChannelPool 只注册一次） */
  onActivate(cb: (channel: Channel) => void): void;
}

/** module 'channel' 的 v1 迁移：channels + channel_sessions 两表（channel-store 复用同一份） */
export const channelMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_sessions (
  channel_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,
];

/** 迭代器判空前的有界等待：队列空时等新项一小段时间再判结束（竞态纪律） */
const IDLE_TIMEOUT_MS = 10;

function nowIso(): string {
  return new Date().toISOString();
}

class ChannelImpl implements Channel {
  readonly key: string;
  private readonly items: ChannelItem[] = [];
  private draining = false;
  private iteratorActive = false;
  private wake: (() => void) | null = null;
  private readonly activate: (channel: Channel) => void;

  constructor(key: string, activate: (channel: Channel) => void) {
    this.key = key;
    this.activate = activate;
  }

  enqueue(task: Task, watcher: unknown): void {
    this.items.push({ task, watcher });
    const wake = this.wake;
    if (wake !== null) {
      this.wake = null;
      wake();
    }
    if (!this.draining) {
      this.draining = true;
      this.activate(this);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChannelItem> {
    if (this.iteratorActive) {
      throw new Error(`channel "${this.key}": 同一时刻最多一个活跃迭代器`);
    }
    this.iteratorActive = true;
    try {
      for (;;) {
        const item = this.items.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        // 有界等待：enqueue 落在"已判空、未复位"窗口时由 wake 唤醒，任务不丢
        const arrived = await this.waitForItem();
        if (!arrived && this.items.length === 0) {
          break;
        }
      }
    } finally {
      // 复位与最后一次判空之间无 await，JS 单线程保证不存在竞态窗口
      this.iteratorActive = false;
      this.draining = false;
    }
  }

  private waitForItem(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(false);
      }, IDLE_TIMEOUT_MS);
      this.wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }
}

/** 创建通道池。get 无则建（内存 Map + channels 表落库），有则取 */
export function createChannelPool(db: Database): ChannelPool {
  migrate(db, "channel", channelMigrations);

  const channels = new Map<string, ChannelImpl>();
  let activateCb: ((channel: Channel) => void) | null = null;

  return {
    get(key: string): Channel {
      let channel = channels.get(key);
      if (channel === undefined) {
        channel = new ChannelImpl(key, (ch) => activateCb?.(ch));
        channels.set(key, channel);
        db.run(
          "INSERT OR IGNORE INTO channels (channel_id, created_at, last_active_at) VALUES (?, ?, ?)",
          [key, nowIso(), nowIso()],
        );
      }
      db.run("UPDATE channels SET last_active_at = ? WHERE channel_id = ?", [
        nowIso(),
        key,
      ]);
      return channel;
    },

    onActivate(cb: (channel: Channel) => void): void {
      activateCb = cb;
    },
  };
}
