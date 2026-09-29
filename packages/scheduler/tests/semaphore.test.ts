import { createSemaphore } from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createSemaphore", () => {
  it("并发上限不被突破（计数器峰值 ≤ limit）", async () => {
    const sem = createSemaphore(3);
    let active = 0;
    let peak = 0;
    const workers = Array.from({ length: 10 }, async () => {
      await sem.acquire();
      try {
        active += 1;
        peak = Math.max(peak, active);
        await delay(5);
      } finally {
        active -= 1;
        sem.release();
      }
    });
    await Promise.all(workers);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3); // 证明确实打满了闸门，而非天然串行
  });

  it("release 后等待者放行（FIFO）", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    const order: string[] = [];
    const w1 = sem.acquire().then(() => {
      order.push("w1");
    });
    const w2 = sem.acquire().then(() => {
      order.push("w2");
    });
    await delay(20);
    expect(order).toEqual([]); // 无令牌，等待者不放行
    sem.release();
    await delay(20);
    expect(order).toEqual(["w1"]);
    sem.release();
    await Promise.all([w1, w2]);
    expect(order).toEqual(["w1", "w2"]);
  });

  it("超发 release 抛错", async () => {
    const sem = createSemaphore(1);
    expect(() => sem.release()).toThrow(/超发/);
    await sem.acquire();
    sem.release();
    expect(() => sem.release()).toThrow(/超发/);
  });

  it("limit < 1 抛错", () => {
    expect(() => createSemaphore(0)).toThrow();
    expect(() => createSemaphore(-2)).toThrow();
    expect(() => createSemaphore(1.5)).toThrow();
  });
});
