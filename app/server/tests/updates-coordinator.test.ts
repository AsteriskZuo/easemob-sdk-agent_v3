import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createUpdateQueue } from "@asteriskzuo/agent-queue";
import type { UpdateQueue } from "@asteriskzuo/agent-queue";
import { createUpdateCoordinator } from "../src/updates/coordinator.js";
import type {
  UpdateCoordinator,
  UpdateHandler,
} from "../src/updates/coordinator.js";

let tmpDir: string;
let db: Database;
let queue: UpdateQueue;
let loggerDir: string | null = null;

function ensureTestLogger(): void {
  if (loggerDir !== null) return;
  loggerDir = mkdtempSync(join(tmpdir(), "agent-updates-test-logs-"));
  initLogger({ logsDir: loggerDir, enabled: false });
}

afterAll(() => {
  if (loggerDir !== null) {
    rmSync(loggerDir, { recursive: true, force: true });
    loggerDir = null;
  }
  resetForTests();
});

/** 可手动放行的 promise */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 建协调器：effects 记录命令应用顺序；failOn 命中的 kind 抛错 */
function makeCoordinator(
  effects: string[],
  opts: {
    failKinds?: string[];
    hangKinds?: Map<string, ReturnType<typeof deferred>>;
  } = {},
): UpdateCoordinator {
  const handlers: Record<string, UpdateHandler> = {
    set: (payload) => {
      const p = payload as { key: string };
      effects.push(p.key);
      return `applied:${p.key}`;
    },
    "business.delete": (payload) => {
      const p = payload as { business_id: string };
      effects.push(`delete:${p.business_id}`);
      return null;
    },
  };
  return createUpdateCoordinator({
    queue,
    handlers: new Proxy(handlers, {
      get(target, kind: string) {
        if (typeof kind !== "string") return undefined;
        if (opts.failKinds?.includes(kind)) {
          return () => {
            throw new Error(`boom:${kind}`);
          };
        }
        const hang = opts.hangKinds?.get(kind);
        if (hang) {
          return async (payload: unknown) => {
            await hang.promise;
            effects.push((payload as { key: string }).key);
            return `applied:${(payload as { key: string }).key}`;
          };
        }
        return target[kind];
      },
    }) as Record<string, UpdateHandler>,
  });
}

beforeEach(() => {
  ensureTestLogger();
  tmpDir = mkdtempSync(join(tmpdir(), "agent-updates-test-"));
  db = openDatabase(join(tmpDir, "test.db"));
  queue = createUpdateQueue(db);
});

afterEach(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("空闲时立即应用：submit 返回 applied + 处理器结果，命令落库 done", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const submission = await coordinator.submit<string>({
    kind: "set",
    payload: { key: "a" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  expect(submission.outcome).toBe("applied");
  if (submission.outcome === "applied") {
    expect(submission.result).toBe("applied:a");
  }
  expect(effects).toEqual(["a"]);
  expect(queue.get(submission.update_id)?.status).toBe("done");
  await coordinator.stop();
});

test("忙时阻塞：活动 run 期间 submit 返回 accepted；run 结束后自动应用", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const runGate = deferred<string>();
  const runPromise = coordinator.run("biz_1", () => runGate.promise);
  await tick();
  const submission = await coordinator.submit({
    kind: "set",
    payload: { key: "a" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  expect(submission.outcome).toBe("accepted");
  expect(effects).toEqual([]); // 等待期间不应用
  runGate.resolve("done");
  await runPromise;
  await tick();
  expect(effects).toEqual(["a"]); // 自然空闲后应用
  await coordinator.stop();
});

test("等待期新 run 可进入（不被 pending 命令阻塞）", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const holdA = deferred<string>();
  const firstRun = coordinator.run("biz_1", () => holdA.promise);
  await tick();
  await coordinator.submit({
    kind: "set",
    payload: { key: "a" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  }); // accepted，等待 biz_1 空闲
  // 新 run 仍可进入并完成
  const second = await coordinator.run("biz_1", async () => "ok");
  expect(second).toBe("ok");
  expect(effects).toEqual([]);
  holdA.resolve("done");
  await firstRun;
  await tick();
  expect(effects).toEqual(["a"]);
  await coordinator.stop();
});

test("应用窗口互斥：命令应用期间同业务新 run 等待，应用完才进入", async () => {
  const effects: string[] = [];
  const hang = deferred<void>();
  const coordinator = makeCoordinator(effects, {
    hangKinds: new Map([["set", hang]]),
  });
  const submissionPromise = coordinator.submit({
    kind: "set",
    payload: { key: "a" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  await tick();
  // 应用窗口中：run 必须等待
  let runEntered = false;
  const runPromise = coordinator
    .run("biz_1", async () => {
      runEntered = true;
      return "ok";
    })
    .then((v) => v);
  await tick();
  expect(runEntered).toBe(false);
  hang.resolve();
  const submission = await submissionPromise;
  expect(submission.outcome).toBe("applied");
  await runPromise;
  expect(runEntered).toBe(true);
  await coordinator.stop();
});

test("严格全局 FIFO：队首等业务 A 忙时，业务 B 的空闲命令不插队", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const holdA = deferred<string>();
  const runA = coordinator.run("biz_a", () => holdA.promise);
  await tick();
  const sub1 = await coordinator.submit({
    kind: "set",
    payload: { key: "cmd-a" },
    business_ids: ["biz_a"],
    requested_by: "u1",
  });
  const sub2 = await coordinator.submit({
    kind: "set",
    payload: { key: "cmd-b" },
    business_ids: ["biz_b"],
    requested_by: "u1",
  });
  expect(sub1.outcome).toBe("accepted");
  expect(sub2.outcome).toBe("accepted"); // B 空闲但不得插队
  expect(effects).toEqual([]);
  holdA.resolve("done");
  await runA;
  await tick();
  expect(effects).toEqual(["cmd-a", "cmd-b"]); // 按 seq 顺序应用
  await coordinator.stop();
});

test("空影响集合豁免：队首被繁忙业务阻塞时，创建类命令立即应用", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const holdA = deferred<string>();
  const runA = coordinator.run("biz_a", () => holdA.promise);
  await tick();
  const blocked = await coordinator.submit({
    kind: "set",
    payload: { key: "cmd-a" },
    business_ids: ["biz_a"],
    requested_by: "u1",
  });
  expect(blocked.outcome).toBe("accepted");
  const created = await coordinator.submit<string>({
    kind: "set",
    payload: { key: "cmd-create" },
    business_ids: [],
    requested_by: "u1",
  });
  expect(created.outcome).toBe("applied");
  expect(effects).toEqual(["cmd-create"]);
  holdA.resolve("done");
  await runA;
  await tick();
  expect(effects).toEqual(["cmd-create", "cmd-a"]);
  await coordinator.stop();
});

test("全业务屏障：all 命令在任一业务忙时等待，全部空闲后应用", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const holdA = deferred<string>();
  const holdB = deferred<string>();
  const runA = coordinator.run("biz_a", () => holdA.promise);
  const runB = coordinator.run("biz_b", () => holdB.promise);
  await tick();
  const submission = await coordinator.submit({
    kind: "set",
    payload: { key: "global" },
    business_ids: "all",
    requested_by: "admin",
  });
  expect(submission.outcome).toBe("accepted");
  holdA.resolve("done");
  await runA;
  await tick();
  expect(effects).toEqual([]); // biz_b 仍在忙
  holdB.resolve("done");
  await runB;
  await tick();
  expect(effects).toEqual(["global"]);
  await coordinator.stop();
});

test("business.delete 应用后同业务后续 pending 标 failed；delete 已接受后新写 submit 抛 business_deleting", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects);
  const holdA = deferred<string>();
  const runA = coordinator.run("biz_1", () => holdA.promise);
  await tick();
  const del = await coordinator.submit({
    kind: "business.delete",
    payload: { business_id: "biz_1" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  expect(del.outcome).toBe("accepted");
  // delete 已接受：后续写命令 409 前缀
  await expect(
    coordinator.submit({
      kind: "set",
      payload: { key: "x" },
      business_ids: ["biz_1"],
      requested_by: "u1",
    }),
  ).rejects.toThrow("business_deleting");
  // 队列里再制造一条 delete 之后的 pending（模拟 delete 前已排队）：直接落库
  queue.enqueue({
    kind: "set",
    payload: { key: "stale" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  holdA.resolve("done");
  await runA;
  await tick();
  // delete 应用后，stale 被标 failed 而非应用
  expect(effects).not.toContain("stale");
  const stale = queue.peek();
  expect(stale).toBeNull();
  await coordinator.stop();
});

test("recover：processing 残留恢复 pending 并重新应用", async () => {
  const effects: string[] = [];
  queue.enqueue({
    kind: "set",
    payload: { key: "a" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  const head = queue.peek();
  expect(head).not.toBeNull();
  queue.begin((head as { update_id: string }).update_id); // 模拟崩溃前进入应用窗口
  const coordinator = makeCoordinator(effects);
  await coordinator.recover();
  await tick();
  expect(effects).toEqual(["a"]);
  await coordinator.stop();
});

test("立即应用失败：submit 同步抛错，命令标 failed，后续命令不受阻", async () => {
  const effects: string[] = [];
  const coordinator = makeCoordinator(effects, { failKinds: ["bad"] });
  await expect(
    coordinator.submit({
      kind: "bad",
      payload: { key: "x" },
      business_ids: ["biz_1"],
      requested_by: "u1",
    }),
  ).rejects.toThrow("boom:bad");
  const next = await coordinator.submit<string>({
    kind: "set",
    payload: { key: "next" },
    business_ids: ["biz_1"],
    requested_by: "u1",
  });
  expect(next.outcome).toBe("applied");
  expect(effects).toEqual(["next"]);
  await coordinator.stop();
});
