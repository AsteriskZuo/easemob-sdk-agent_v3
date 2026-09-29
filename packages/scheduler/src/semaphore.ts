/** 计数信号量：闸门并发控制。acquire 无令牌则 FIFO 排队等待 */
export interface Semaphore {
  acquire(): Promise<void>; // 无令牌则排队等（FIFO 唤醒）
  release(): void; // 超发（release 多于 acquire）抛错
  readonly limit: number;
}

/** 创建信号量。limit < 1（或非整数）抛错 */
export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createSemaphore: limit 必须是 >= 1 的整数，收到 ${limit}`);
  }
  let available = limit;
  const waiters: Array<() => void> = [];
  return {
    limit,
    acquire(): Promise<void> {
      if (available > 0) {
        available -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        // 令牌直接移交等待者，available 不变
        next();
        return;
      }
      if (available >= limit) {
        throw new Error("semaphore: release 超发（release 多于 acquire）");
      }
      available += 1;
    },
  };
}
