import { buildBusinessChannelId } from "@asterisk/agent-contracts";
import type { Channel, ChannelPool } from "@asterisk/agent-channel";
import type { Task, TaskQueue } from "@asterisk/agent-queue";
import type { BusinessMatch, BusinessRegistry } from "@asterisk/agent-registry";
import { logger } from "@asterisk/agent-logger";
import { createSemaphore } from "./semaphore.js";
import type { Semaphore } from "./semaphore.js";
import { deriveEvent } from "./derive-event.js";
import type {
  EntryDriver,
  ExecutionResult,
  PlatformConfig,
  SchedulerLoop,
  SchedulerOptions,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 创建入口事件循环。装配纪律（调用方职责，本包不代做）：
 *  ① start 前装配根已 initLogger() 并对两条队列调过 recover()；
 *  ② channels 必须是本循环专用的 ChannelPool 实例（onActivate 每池单注册，两个循环各持一池）。
 *  at-least-once：崩溃恢复后任务被重新 take、重新派发，已执行过的关注者可能重执行（业务幂等归业务）。
 *  崩溃恢复（recover()）由装配根在 start 前调用，本包不调。 */
export function createEntryLoop(deps: {
  queue: TaskQueue; // 入口队列
  exitQueue: TaskQueue; // 出口队列（扇出的另一半）
  registry: BusinessRegistry;
  channels: ChannelPool; // 入口专用池（与出口循环各持一个实例）
  config: PlatformConfig;
  driver: EntryDriver;
  options?: SchedulerOptions;
}): SchedulerLoop {
  const { queue, exitQueue, registry, channels, config, driver } = deps;
  const pollIntervalMs = deps.options?.pollIntervalMs ?? 50;
  const log = logger.for({ module: "entry-loop" });
  const semaphore: Semaphore = createSemaphore(config.task_concurrency);
  // 任务级完结计数（内存 Map）：崩溃后由 recover + at-least-once 语义兜底，不持久化
  const pending = new Map<string, number>();
  const inflightDrains = new Set<Promise<void>>(); // 在飞 drain 集合：stop() 时 await 全部落定
  let stopped = false; // 停止标志：摄取循环下一轮退出
  let started = false; // 启动标志：start 幂等
  let ingestPromise: Promise<void> | null = null; // 摄取循环 promise：stop() 等它退出

  /** 任务级完结计数 -1；归零 → queue.complete。pending 中不存在 = 已死信/已完结，跳过（防御） */
  function settle(task: Task): void {
    const remaining = pending.get(task.task_id);
    if (remaining === undefined) {
      return;
    }
    if (remaining > 1) {
      pending.set(task.task_id, remaining - 1);
      return;
    }
    pending.delete(task.task_id);
    queue.complete(task.task_id);
    log.info("任务完结", {
      event_id: task.event.event_id,
      task_id: task.task_id,
      correlation_id: task.event.correlation_id,
    });
  }

  /** 摄取派发：匹配关注者、挂通道。任何意外异常（含毒任务）→ 死信，绝不让循环崩溃 */
  function dispatch(task: Task): void {
    try {
      const watchers = registry.match(task.event.source, task.event.event_type);
      if (watchers.length === 0) {
        queue.complete(task.task_id);
        log.info("无关注者，事件丢弃", {
          event_id: task.event.event_id,
          task_id: task.task_id,
          source: task.event.source,
          event_type: task.event.event_type,
        });
        return;
      }
      pending.set(task.task_id, watchers.length);
      for (const bm of watchers) {
        const key = buildBusinessChannelId(
          task.event.source,
          task.event.session_id,
          bm.business_id,
        );
        channels.get(key).enqueue(task, bm); // 空闲通道触发 onActivate → drain
      }
      log.info("事件派发", {
        event_id: task.event.event_id,
        task_id: task.task_id,
        watchers: watchers.length,
        correlation_id: task.event.correlation_id,
      });
    } catch (err) {
      // 匹配/挂通道期意外异常（含毒任务）：死信防止在 processing 间反复热循环
      pending.delete(task.task_id);
      queue.deadLetter(task.task_id, "dispatch_error");
      log.error("摄取派发异常，任务死信", {
        event_id: task.event.event_id,
        task_id: task.task_id,
        error: errMessage(err),
      });
    }
  }

  /** 消化循环：一条通道同一时刻最多一个 drain（Channel 的 AsyncIterable 已保证）；消化空即退出 */
  async function drain(channel: Channel): Promise<void> {
    for await (const item of channel) {
      const { task } = item;
      const bm = item.watcher as BusinessMatch;
      await semaphore.acquire(); // 业务闸门 = config.task_concurrency
      try {
        let result: ExecutionResult;
        try {
          result = await driver.execute(task, bm); // 分钟级长调用
        } catch (err) {
          // 基础设施异常兜底：合成 failed
          result = { status: "failed", output: undefined };
          log.error("业务执行抛异常", {
            event_id: task.event.event_id,
            task_id: task.task_id,
            business_id: bm.business_id,
            channel_id: channel.key,
            error: errMessage(err),
          });
        }
        if (result.status === "success" || bm.on_failure === true) {
          const next = deriveEvent(task.event, bm, result);
          if (next.hop_count > config.hop_limit) {
            // 判循环：两队落库留痕即死信
            const t1 = queue.enqueue(next);
            queue.deadLetter(t1.task_id, "hop_limit");
            const t2 = exitQueue.enqueue(next);
            exitQueue.deadLetter(t2.task_id, "hop_limit");
            log.error("hop 超限，派生事件死信", {
              event_id: next.event_id,
              task_id: task.task_id,
              channel_id: channel.key,
              correlation_id: next.correlation_id,
              hop_count: next.hop_count,
            });
          } else {
            queue.enqueue(next); // 下游业务关注者消化
            exitQueue.enqueue(next); // 出口绑定投递
          }
        }
        // result.status 非 success 且 on_failure 未开：不扇出（下游天然不触发、出口无投递）
      } finally {
        semaphore.release();
        settle(task);
      }
    }
  }

  return {
    start(): void {
      if (started) {
        return; // 幂等：重复调不重复启动
      }
      started = true;
      channels.onActivate((channel) => {
        const p = drain(channel).catch((err: unknown) => {
          // drain 不应抛出（体内已兜底）；此处防未捕获拒绝，绝不让循环崩溃
          log.error("消化循环异常退出", {
            channel_id: channel.key,
            error: errMessage(err),
          });
        });
        inflightDrains.add(p);
        void p.finally(() => {
          inflightDrains.delete(p);
        });
      });
      ingestPromise = (async () => {
        while (!stopped) {
          const task = queue.take();
          if (task === null) {
            await sleep(pollIntervalMs);
            continue;
          }
          dispatch(task);
        }
      })();
    },

    async stop(): Promise<void> {
      // 优雅停：摄取循环在当前一轮结束后退出；await 全部在飞 drain 落定（不打断在飞的 execute）。
      // stop 后队列里 pending 任务原样保留（下次启动 recover 接回）
      stopped = true;
      if (ingestPromise !== null) {
        await ingestPromise;
      }
      await Promise.all([...inflightDrains]);
    },
  };
}
