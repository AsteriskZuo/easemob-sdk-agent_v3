import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/** 本地假 npm registry（测试不触外网）：任何方法一律 200 */
let registryServer: Server;
let registryUrl: string;
/** 已关闭的端口（registry 不可达用例） */
let closedPortUrl: string;

beforeAll(async () => {
  registryServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) =>
    registryServer.listen(0, "127.0.0.1", resolve),
  );
  registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}/`;

  // 占一个端口后立刻关闭，拿到一个确定不可达的地址
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  closedPortUrl = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => registryServer.close(() => resolve()));
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-selfcheck-test-"));
  workspace = join(tmpDir, "workspace");
  // fixture 假 pi：存在且可执行即可（自检不运行它）
  piCliPath = join(tmpDir, "fake-pi");
  writeFileSync(piCliPath, "#!/bin/sh\nexit 0\n");
  chmodSync(piCliPath, 0o755);
  // fixture pi_agent_dir：含合法 models.json（伪造占位内容；自检要求可解析且非空）
  piAgentDir = join(tmpDir, "pi-agent-dir");
  mkdirSync(piAgentDir, { recursive: true });
  writeFileSync(
    join(piAgentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: "https://test-provider.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-fake-placeholder",
          models: [{ id: "model-a" }],
        },
      },
    }),
  );
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
    npm_registry: registryUrl,
    ...over,
  };
}

describe("runSelfCheck", () => {
  it("全绿通过（临时 workspace + fixture pi + 本地 registry）", async () => {
    await expect(runSelfCheck(makeConfig())).resolves.toBeUndefined();
  });

  it("pi_cli_path 不存在 → 抛错且 message 含路径", async () => {
    const missing = join(tmpDir, "no-such-pi");
    await expect(
      runSelfCheck(makeConfig({ pi_cli_path: missing })),
    ).rejects.toThrow(/启动自检失败/);
    await expect(
      runSelfCheck(makeConfig({ pi_cli_path: missing })),
    ).rejects.toThrow(missing);
  });

  it("pi_cli_path 不可执行 → 抛错且 message 含路径", async () => {
    const notExec = join(tmpDir, "not-exec-pi");
    writeFileSync(notExec, "#!/bin/sh\nexit 0\n");
    chmodSync(notExec, 0o644);
    await expect(
      runSelfCheck(makeConfig({ pi_cli_path: notExec })),
    ).rejects.toThrow(notExec);
  });

  it("pi_agent_dir 缺 models.json → 抛错", async () => {
    const emptyDir = join(tmpDir, "empty-agent-dir");
    mkdirSync(emptyDir);
    await expect(
      runSelfCheck(makeConfig({ pi_agent_dir: emptyDir })),
    ).rejects.toThrow(/models\.json/);
  });

  it("models.json 存在但无可用模型（空 providers / 全部空 models）→ 抛错", async () => {
    const badDir = join(tmpDir, "bad-models-dir");
    mkdirSync(badDir);
    writeFileSync(join(badDir, "models.json"), "{}");
    await expect(
      runSelfCheck(makeConfig({ pi_agent_dir: badDir })),
    ).rejects.toThrow(/models\.json 不可用/);
    writeFileSync(
      join(badDir, "models.json"),
      JSON.stringify({ providers: { p: { models: [] } } }),
    );
    await expect(
      runSelfCheck(makeConfig({ pi_agent_dir: badDir })),
    ).rejects.toThrow(/models\.json 不可用/);
  });

  it("workspace 不可写（只读目录）→ 抛错", async () => {
    mkdirSync(workspace, { recursive: true });
    chmodSync(workspace, 0o555);
    readonlyDir = workspace;
    await expect(runSelfCheck(makeConfig())).rejects.toThrow(
      /workspace 不可建\/不可写/,
    );
  });

  it("多项同时失败 → message 列出全部失败项", async () => {
    const missingPi = join(tmpDir, "no-such-pi");
    const emptyDir = join(tmpDir, "empty-agent-dir");
    mkdirSync(emptyDir);
    let message = "";
    try {
      await runSelfCheck(
        makeConfig({ pi_cli_path: missingPi, pi_agent_dir: emptyDir }),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(missingPi);
    expect(message).toContain("models.json");
  });

  it("npm registry 不可达 → 拒启动且 message 含地址", async () => {
    await expect(
      runSelfCheck(makeConfig({ npm_registry: closedPortUrl })),
    ).rejects.toThrow(/npm registry 不可达/);
    let message = "";
    try {
      await runSelfCheck(makeConfig({ npm_registry: closedPortUrl }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(closedPortUrl);
  });

  it("git/npm 不可用（PATH 无 git/npm）→ 抛错且 message 两项都列", () => {
    // jest ESM realm 里改 process.env 不会传播到 spawn 的子进程（实测），
    // 因此用真实子进程跑 runSelfCheck（被测代码 = dist-test 编译产物本身）：
    // 经 spawn 显式 env 把 PATH 置为空目录，git/npm 必然解析不到。
    // 注：registry 可达性检查不依赖 PATH（fetch 进程内发起），指回本地假 registry
    const checkScript = `
      import { runSelfCheck } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist-test", "src", "self-check.js")).href)};
      try {
        await runSelfCheck(${JSON.stringify(makeConfig())});
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
    expect(stderr).toContain("git 不可用");
    expect(stderr).toContain("npm 不可用");
  });
});
