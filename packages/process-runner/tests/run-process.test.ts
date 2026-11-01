import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessError, runProcess } from "../src/index.js";
import type { RunProcessOptions } from "../src/index.js";

const NODE = process.execPath;

let workDir: string;

function base(overrides: Partial<RunProcessOptions> = {}): RunProcessOptions {
  return {
    cwd: workDir,
    env: { mode: "exact", values: {} },
    timeout_ms: 5000,
    ...overrides,
  };
}

/** 轮询直到 cond 为真或超时（用于进程组清理等异步断言） */
async function eventually(
  cond: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "agent-process-runner-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("成功：exit 0 聚合 stdout，code/signal 正确", async () => {
  const result = await runProcess(
    NODE,
    ["-e", 'process.stdout.write("hello");process.stderr.write("warn")'],
    base(),
  );
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("hello");
  expect(result.stderr).toBe("warn");
});

test("stdin：提供文本时写入并关闭，子进程可读全", async () => {
  const result = await runProcess(
    NODE,
    [
      "-e",
      'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>process.stdout.write("echo:"+d))',
    ],
    base({ stdin: "payload" }),
  );
  expect(result.stdout).toBe("echo:payload");
});

test("env exact：只使用 values，不继承调用方环境", async () => {
  process.env.PROCESS_RUNNER_TEST_VAR = "from-parent";
  const script =
    'process.stdout.write(process.env.PROCESS_RUNNER_TEST_VAR ?? "unset")';
  const exact = await runProcess(
    NODE,
    ["-e", script],
    base({
      env: { mode: "exact", values: { PROCESS_RUNNER_TEST_VAR: "mine" } },
    }),
  );
  expect(exact.stdout).toBe("mine");
  const empty = await runProcess(
    NODE,
    ["-e", script],
    base({ env: { mode: "exact", values: {} } }),
  );
  expect(empty.stdout).toBe("unset");
  const inherited = await runProcess(
    NODE,
    ["-e", script],
    base({ env: { mode: "inherit" } }),
  );
  expect(inherited.stdout).toBe("from-parent");
});

test("非零退出：rejected ProcessError kind=nonzero_exit，带退出码和 stderr 尾部", async () => {
  const err = await runProcess(
    NODE,
    ["-e", 'process.stderr.write("boom");process.exit(3)'],
    base(),
  ).then(
    () => {
      throw new Error("应当拒绝");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProcessError);
  const perr = err as ProcessError;
  expect(perr.kind).toBe("nonzero_exit");
  expect(perr.code).toBe(3);
  expect(perr.message).toContain("boom");
});

test("spawn 失败：kind=spawn_failed", async () => {
  const err = await runProcess("definitely-not-a-command-xyz", [], base()).then(
    () => {
      throw new Error("应当拒绝");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProcessError);
  expect((err as ProcessError).kind).toBe("spawn_failed");
});

test("超时：kind=timeout，子进程被终止", async () => {
  const startedAt = Date.now();
  const err = await runProcess(
    NODE,
    ["-e", "setTimeout(()=>{}, 30000)"],
    base({ timeout_ms: 150, kill_grace_ms: 100 }),
  ).then(
    () => {
      throw new Error("应当拒绝");
    },
    (e: unknown) => e,
  );
  expect((err as ProcessError).kind).toBe("timeout");
  expect(Date.now() - startedAt).toBeLessThan(5000);
});

test("主动取消：AbortSignal 触发后 kind=aborted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const err = await runProcess(
    NODE,
    ["-e", "setTimeout(()=>{}, 30000)"],
    base({ timeout_ms: 10000, kill_grace_ms: 100, signal: controller.signal }),
  ).then(
    () => {
      throw new Error("应当拒绝");
    },
    (e: unknown) => e,
  );
  expect((err as ProcessError).kind).toBe("aborted");
});

test("输出超限：stdout 超过 max_output_bytes 即终止，kind=output_limit", async () => {
  const err = await runProcess(
    NODE,
    ["-e", 'process.stdout.write("x".repeat(64 * 1024))'],
    base({ max_output_bytes: 1024 }),
  ).then(
    () => {
      throw new Error("应当拒绝");
    },
    (e: unknown) => e,
  );
  expect((err as ProcessError).kind).toBe("output_limit");
});

test("显式不限制输出：max_output_bytes=null 时完整聚合大输出", async () => {
  const size = 2 * 1024 * 1024;
  const result = await runProcess(
    NODE,
    ["-e", `process.stdout.write("y".repeat(${size}))`],
    base({ max_output_bytes: null }),
  );
  expect(result.stdout.length).toBe(size);
});

test("流回调：on_stdout/on_stderr 收到原始数据块，回调异常被吞掉", async () => {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const result = await runProcess(
    NODE,
    [
      "-e",
      'process.stdout.write("o1");process.stderr.write("e1");process.stdout.write("o2")',
    ],
    base({
      on_stdout: (chunk) => {
        outChunks.push(chunk);
        throw new Error("回调异常不应影响执行");
      },
      on_stderr: (chunk) => {
        errChunks.push(chunk);
      },
    }),
  );
  expect(Buffer.concat(outChunks).toString("utf8")).toBe("o1o2");
  expect(Buffer.concat(errChunks).toString("utf8")).toBe("e1");
  expect(result.stdout).toBe("o1o2");
});

test("timeout_ms 非正数：同步抛错", () => {
  expect(() => runProcess(NODE, ["-e", ""], base({ timeout_ms: 0 }))).toThrow(
    "timeout_ms 必须为正数",
  );
});

test("POSIX 进程组清理：取消后子进程的子进程也被终止", async () => {
  if (process.platform === "win32") return;
  const pidFile = join(workDir, "grandchild.pid");
  // 父进程：派生一个不分离的孙子 sleeper（同进程组），把其 pid 写文件后常驻
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const gc = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });`,
    "fs.writeFileSync(process.env.PID_FILE, String(gc.pid));",
    "setTimeout(()=>{},30000);",
  ].join("");
  const controller = new AbortController();
  const promise = runProcess(
    NODE,
    ["-e", parentScript],
    base({
      timeout_ms: 30000,
      kill_grace_ms: 100,
      signal: controller.signal,
      env: { mode: "exact", values: { PID_FILE: pidFile } },
    }),
  );
  // 等孙子 pid 落盘再取消
  const appeared = await eventually(() => existsSync(pidFile));
  expect(appeared).toBe(true);
  const grandchildPid = Number(readFileSync(pidFile, "utf8"));
  controller.abort();
  const err = await promise.then(
    () => {
      throw new Error("应当拒绝");
    },
    (e: unknown) => e,
  );
  expect((err as ProcessError).kind).toBe("aborted");
  const reaped = await eventually(() => {
    try {
      process.kill(grandchildPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  expect(reaped).toBe(true);
});
