import { buildExitChannelId } from "@easemob/agent-contracts";
import type { Channel, ChannelPool } from "@easemob/agent-channel";
import type { Task, TaskQueue } from "@easemob/agent-queue";
import type { BusinessRegistry, ExitBinding } from "@easemob/agent-registry";
import { logger } from "@easemob/agent-logger";
import { createSemaphore } from "./semaphore.js";
import type { Semaphore } from "./semaphore.js";
import type {
  ExitDriver,
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

/** 任务级结算状态（内存）：剩余绑定数 + 失败累计 */
interface ExitPending {
  remaining: number;
  failed: number;
}

/** 创建出口事件循环。装配纪律同入口循环（start 前 initLogger + queue.recover()；
 *  channels 为出口专用池）。出口队列里应只有派生事件（producer_business_id 必在），
 *  缺失时本包防御性死信而非断言崩溃。出口循环不派生新事件、不参与 hop_count；
 *  投递 at-least-once（接收方凭 event_id 幂等）。 */
export function createExitLoop(deps: {
  queue: TaskQueue; // 出口队列
  registry: BusinessRegistry;
  channels: ChannelPool; // 出口专用池
  config: PlatformConfig;
  driver: ExitDriver;
  options?: SchedulerOptions;
}): SchedulerLoop {
  const { queue, registry, channels, config, driver } = deps;
  const pollIntervalMs = deps.options?.pollIntervalMs ?? 50;
  const maxAttempts = deps.options?.exitRetry?.maxAttempts ?? 3;
  const baseDelayMs = deps.options?.exitRetry?.baseDelayMs ?? 1000;
  const maxDelayMs = deps.options?.exitRetry?.maxDelayMs ?? 10000;
  const log = logger.for({ module: "exit-loop" });
  const semaphore: Semaphore = createSemaphore(config.result_concurrency);
  const pending = new Map<string, ExitPending>();
  const inflightDrains = new Set<Promise<void>>();
  let stopped = false;
  let started = false;
  let ingestPromise: Promise<void> | null = null;

  /** 结算一个绑定：remaining-1，failed 累计；remaining 归零时 failed>0 → 死信，否则完结。
   *  pending 中不存在 = 已死信/已完结，跳过（防御） */
  function settle(task: Task, failed: boolean): void {
    const state = pending.get(task.task_id);
    if (state === undefined) {
      return;
    }
    state.remaining -= 1;
    if (failed) {
      state.failed += 1;
    }
    if (state.remaining > 0) {
      return;
    }
    pending.delete(task.task_id);
    if (state.failed > 0) {
      queue.deadLetter(task.task_id, "deliver_failed");
      log.error("出口投递失败，任务死信", {
        event_id: task.event.event_id,
        task_id: task.task_id,
        failed: state.failed,
      });
    } else {
      queue.complete(task.task_id);
      log.info("出口任务完结", {
        event_id: task.event.event_id,
        task_id: task.task_id,
      });
    }
  }

  /** 摄取派发：归属匹配、挂出口通道（同目标串行）。任何意外异常 → 死信，绝不让循环崩溃 */
  function dispatch(task: Task): void {
    try {
      const producer = task.event.producer_business_id;
      if (producer === undefined || producer === "") {
        // 防御：出口队列只装派生事件
        queue.deadLetter(task.task_id, "missing_producer");
        log.error("出口任务缺 producer_business_id，死信", {
          event_id: task.event.event_id,
          task_id: task.task_id,
        });
        return;
      }
      const bindings = registry.exitBindings(producer);
      if (bindings.length === 0) {
        queue.complete(task.task_id);
        log.info("无出口绑定，事件丢弃", {
          event_id: task.event.event_id,
          task_id: task.task_id,
          producer_business_id: producer,
        });
        return;
      }
      pending.set(task.task_id, { remaining: bindings.length, failed: 0 });
      for (const b of bindings) {
        let key: string;
        try {
          key = buildExitChannelId(driver.destinationOf(b)); // 同目标串行
        } catch (err) {
          // 未知工具/非法配置：该绑定直接判失败（此时尚未挂通道，直接结算）
          log.error("出口目标解析失败", {
            event_id: task.event.event_id,
            task_id: task.task_id,
            tool: b.tool,
            error: errMessage(err),
          });
          settle(task, true);
          continue;
        }
        channels.get(key).enqueue(task, b);
      }
    } catch (err) {
      pending.delete(task.task_id);
      queue.deadLetter(task.task_id, "dispatch_error");
      log.error("出口摄取派发异常，任务死信", {
        event_id: task.event.event_id,
        task_id: task.task_id,
        error: errMessage(err),
      });
    }
  }

  /** 消化循环：有界重试在通道内原地进行（同目标本就该串行排队）；消化空即退出 */
  async function drain(channel: Channel): Promise<void> {
    for await (const item of channel) {
      const { task } = item;
      const binding = item.watcher as ExitBinding;
      await semaphore.acquire(); // 出口闸门 = config.result_concurrency
      let failed = false;
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await driver.deliver(binding, task.event.payload); // 出口不做内容加工
            failed = false;
            break;
          } catch (err) {
            if (attempt === maxAttempts) {
              failed = true;
              log.error("出口投递重试耗尽", {
                event_id: task.event.event_id,
                task_id: task.task_id,
                tool: binding.tool,
                channel_id: channel.key,
                attempts: maxAttempts,
                error: errMessage(err),
              });
            } else {
              await sleep(
                Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs),
              );
            }
          }
        }
      } finally {
        semaphore.release();
        settle(task, failed);
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
          log.error("出口消化循环异常退出", {
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
      stopped = true;
      if (ingestPromise !== null) {
        await ingestPromise;
      }
      await Promise.all([...inflightDrains]);
    },
  };
}
