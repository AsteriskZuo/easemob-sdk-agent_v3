import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probePiModel } from "../src/index.js";
import type { PiProbeOptions } from "../src/index.js";

// dist-test/tests 布局：向上三级到包根，再进 tests/fixtures
const FIXTURE = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "tests",
  "fixtures",
  "fake-pi-probe.js",
);

let workDir: string;

function base(env: Record<string, string> = {}): PiProbeOptions {
  return {
    pi_cli_path: process.execPath,
    pi_agent_dir: workDir,
    model: "test/model-a",
    // 显式基础环境（探针 exact 模式不继承）：fixture 的 shebang 需要 PATH 找 node
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
      ...env,
    },
    cwd: workDir,
    timeout_ms: 3000,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "agent-pi-probe-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// fixture 是带 shebang 的 plain JS 可执行脚本，直接作为 pi_cli_path（探针 argv 为 pi 形态，fixture 忽略参数）
function probeWith(
  env: Record<string, string>,
): ReturnType<typeof probePiModel> {
  return probePiModel({ ...base(env), pi_cli_path: FIXTURE });
}

test("非流式内容：最终 assistant message 含文本 → ok", async () => {
  const result = await probeWith({});
  expect(result.ok).toBe(true);
  expect(result.duration_ms).toBeGreaterThan(0);
});

test("首个 text_delta 后立即取消（进程被探针终止而非自然退出）→ ok 且耗时短", async () => {
  const startedAt = Date.now();
  const result = await probeWith({ FAKE_PI_STREAM_DELTA: "1" });
  expect(result.ok).toBe(true);
  // 进程会常驻 30s；探针取消应在远小于该时间内返回
  expect(Date.now() - startedAt).toBeLessThan(5000);
}, 10000);

test("只有 header/session 无 assistant → no_generation", async () => {
  const result = await probeWith({ FAKE_PI_NO_ASSISTANT: "1" });
  expect(result.ok).toBe(false);
  expect(result.failure_kind).toBe("no_generation");
});

test("空 delta 不算真实生成 → no_generation", async () => {
  const result = await probeWith({ FAKE_PI_EMPTY_DELTA: "1" });
  expect(result.ok).toBe(false);
  expect(result.failure_kind).toBe("no_generation");
});

test("assistant error 即使退出码 0 也失败 → assistant_error", async () => {
  const result = await probeWith({ FAKE_PI_ASSISTANT_ERROR: "1" });
  expect(result.ok).toBe(false);
  expect(result.failure_kind).toBe("assistant_error");
  expect(result.detail).toContain("模型拒绝了请求");
});

test("非零退出 → process_failed，detail 为 stderr 尾部", async () => {
  const result = await probeWith({ FAKE_PI_EXIT: "2" });
  expect(result.ok).toBe(false);
  expect(result.failure_kind).toBe("process_failed");
  expect(result.detail).toContain("FAKE_PI_EXIT=2");
});

test("超时 → timeout", async () => {
  const result = await probePiModel({
    ...base({ FAKE_PI_SLEEP_MS: "5000" }),
    pi_cli_path: FIXTURE,
    timeout_ms: 200,
  });
  expect(result.ok).toBe(false);
  expect(result.failure_kind).toBe("timeout");
}, 10000);

test("spawn 失败 → spawn_failed", async () => {
  const result = await probePiModel(base({}));
  // base 的 pi_cli_path 是 process.execPath（真实 node，能启动但参数非法退出非零）
  // 这里单独测不存在的路径
  const missing = await probePiModel({
    ...base({}),
    pi_cli_path: "/definitely/not/exist/pi",
  });
  expect(missing.ok).toBe(false);
  expect(missing.failure_kind).toBe("spawn_failed");
  expect(result.failure_kind).toBe("process_failed"); // node 收到 pi 参数直接非零退出
});

test("外部 signal 取消 → aborted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await probePiModel({
    ...base({ FAKE_PI_SLEEP_MS: "5000" }),
    pi_cli_path: FIXTURE,
    signal: controller.signal,
  });
  expect(result.ok).toBe(false);
  expect(result.failure_kind).toBe("aborted");
}, 10000);
