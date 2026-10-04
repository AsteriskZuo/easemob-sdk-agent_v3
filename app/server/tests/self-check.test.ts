import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSelfCheck } from "../src/index.js";
import type { ServerConfig } from "../src/index.js";

let tmpDir: string;
let workspace: string;
let piCliPath: string;
let piAgentDir: string;
/** 只读目录用例用：结束后须恢复可写才能 rm */
let readonlyDir: string | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-selfcheck-test-"));
  workspace = join(tmpDir, "workspace");
  // fixture 假 pi：存在且可执行即可（自检不运行它）
  piCliPath = join(tmpDir, "fake-pi");
  writeFileSync(piCliPath, "#!/bin/sh\nexit 0\n");
  chmodSync(piCliPath, 0o755);
  // fixture pi_agent_dir：含哑 models.json
  piAgentDir = join(tmpDir, "pi-agent-dir");
  mkdirSync(piAgentDir, { recursive: true });
  writeFileSync(join(piAgentDir, "models.json"), "{}");
});

afterEach(() => {
  if (readonlyDir !== null) {
    chmodSync(readonlyDir, 0o755);
    readonlyDir = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    workspace,
    log_level: "info",
    log_enabled: false,
    hop_limit: 8,
    task_concurrency: 4,
    result_concurrency: 16,
    task_timeout_minutes: 60,
    max_agent_calls: 20,
    pi_cli_path: piCliPath,
    pi_agent_dir: piAgentDir,
    pi_env: { PATH: "/usr/bin", HOME: "/home/tester" },
    ...over,
  };
}

describe("runSelfCheck", () => {
  it("全绿通过（临时 workspace + fixture pi）", () => {
    expect(() => runSelfCheck(makeConfig())).not.toThrow();
  });

  it("pi_cli_path 不存在 → 抛错且 message 含路径", () => {
    const missing = join(tmpDir, "no-such-pi");
    expect(() => runSelfCheck(makeConfig({ pi_cli_path: missing }))).toThrow(
      /启动自检失败/,
    );
    try {
      runSelfCheck(makeConfig({ pi_cli_path: missing }));
    } catch (err) {
      expect((err as Error).message).toContain(missing);
    }
  });

  it("pi_cli_path 不可执行 → 抛错且 message 含路径", () => {
    const notExec = join(tmpDir, "not-exec-pi");
    writeFileSync(notExec, "#!/bin/sh\nexit 0\n");
    chmodSync(notExec, 0o644);
    try {
      runSelfCheck(makeConfig({ pi_cli_path: notExec }));
      throw new Error("应抛错而未抛");
    } catch (err) {
      expect((err as Error).message).toContain(notExec);
    }
  });

  it("pi_agent_dir 缺 models.json → 抛错", () => {
    const emptyDir = join(tmpDir, "empty-agent-dir");
    mkdirSync(emptyDir);
    expect(() => runSelfCheck(makeConfig({ pi_agent_dir: emptyDir }))).toThrow(
      /models\.json/,
    );
  });

  it("workspace 不可写（只读目录）→ 抛错", () => {
    mkdirSync(workspace, { recursive: true });
    chmodSync(workspace, 0o555);
    readonlyDir = workspace;
    expect(() => runSelfCheck(makeConfig())).toThrow(
      /workspace 不可建\/不可写/,
    );
  });

  it("多项同时失败 → message 列出全部失败项", () => {
    const missingPi = join(tmpDir, "no-such-pi");
    const emptyDir = join(tmpDir, "empty-agent-dir");
    mkdirSync(emptyDir);
    try {
      runSelfCheck(
        makeConfig({ pi_cli_path: missingPi, pi_agent_dir: emptyDir }),
      );
      throw new Error("应抛错而未抛");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(missingPi);
      expect(message).toContain("models.json");
    }
  });

  it("git 不可用（PATH 无 git）→ 抛错且 message 含 git", () => {
    // jest ESM realm 里改 process.env 不会传播到 spawn 的子进程（实测），
    // 因此用真实子进程跑 runSelfCheck（被测代码 = dist-test 编译产物本身）：
    // 经 spawn 显式 env 把 PATH 置为空目录，git 必然解析不到
    const checkScript = `
      import { runSelfCheck } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist-test", "src", "self-check.js")).href)};
      try {
        runSelfCheck(${JSON.stringify(makeConfig())});
      } catch (err) {
        process.stderr.write(String(err instanceof Error ? err.message : err));
        process.exit(1);
      }
    `;
    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", checkScript],
        {
          env: { ...process.env, PATH: join(tmpDir, "empty-bin") },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      exitCode = e.status ?? -1;
      stderr = e.stderr?.toString("utf8") ?? "";
    }
    expect(exitCode).toBe(1);
    expect(stderr).toContain("git");
  });
});
