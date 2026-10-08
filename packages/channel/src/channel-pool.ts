import type { Database } from "@asterisk/agent-database";
import { migrate } from "@asterisk/agent-database";
import type { Task } from "@asterisk/agent-queue";

/** 挂入通道的一项：任务 + 关注者（关注者类型各循环自定，本包不解释） */
export interface ChannelItem<T = unknown> {
  task: Task; // 队列任务（本体已在任务队列持久化，此处只持有引用；通道上排队的项不单独持久化）
  watcher: T; // 关注者：入口循环 = BusinessMatch，出口循环 = ExitBinding（原样透传，本包不解释）
}

/** 通道：同通道严格串行的虚拟执行链。AsyncIterable——消化循环 for await 逐项取出。
 *  迭代器在队列空时结束（用完即焚）；之后再有 enqueue 须能重新迭代（经 onActivate 重启 drain） */
export interface Channel extends AsyncIterable<ChannelItem> {
  readonly key: string; // channel_id 字符串（不透明，本包不解析）
  /** 挂入 (task, 关注者)；同通道上一次消化未完结则排队。空闲通道挂入时触发 onActivate */
  enqueue(task: Task, watcher: unknown): void;
}

/** 通道池：按 channel_id 取或建（创建即落库） */
export interface ChannelPool {
  /** 取或建通道；同键返回同一实例（新建即落库 channels 表并刷新 last_active_at） */
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
  private readonly items: ChannelItem[] = []; // 待消化队列（FIFO：严格按 enqueue 顺序取出，消费即弃）
  private draining = false; // 消化标志（竞态纪律核心）：enqueue 时 !draining 才置位并触发 onActivate，防重复 drain
  private iteratorActive = false; // 活跃迭代器标志：保证同一时刻最多一个 drain 在跑
  private wake: (() => void) | null = null; // 迭代器"有界等待"的唤醒回调；非 null = 迭代器正在等新项
  private readonly activate: (channel: Channel) => void;

  constructor(key: string, activate: (channel: Channel) => void) {
    this.key = key;
    this.activate = activate;
  }

  enqueue(task: Task, watcher: unknown): void {
    this.items.push({ task, watcher });
    // 迭代器正在"有界等待"则唤醒它（新项不丢）
    const wake = this.wake;
    if (wake !== null) {
      this.wake = null;
      wake();
    }
    // 竞态纪律：仅空闲通道（!draining）置位并触发 onActivate；drain 进行中挂入不重复触发
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

  /** 有界等待：resolve(true) = 等到新项；resolve(false) = 超时（再判一次队列空才结束） */
  private waitForItem(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(false); // 超时未等到 → 由调用方判空结束迭代（用完即焚）
      }, IDLE_TIMEOUT_MS);
      this.wake = () => {
        clearTimeout(timer);
        resolve(true); // enqueue 唤醒 → 立即取新项
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
        // 创建即落库（防意外丢失）；INSERT OR IGNORE：已存在则不动 created_at
        db.run(
          "INSERT OR IGNORE INTO channels (channel_id, created_at, last_active_at) VALUES (?, ?, ?)",
          [key, nowIso(), nowIso()],
        );
      }
      // 每次取用都刷新活跃时间
      db.run("UPDATE channels SET last_active_at = ? WHERE channel_id = ?", [
        nowIso(),
        key,
      ]);
      return channel;
    },

    onActivate(cb: (channel: Channel) => void): void {
      activateCb = cb; // 每池单注册（装配纪律）：重复调用会覆盖前回调
    },
  };
}
