import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetForTests } from "@asterisk/agent-logger";
import { bootstrap } from "../src/index.js";
import type { ServerHandle } from "../src/index.js";

/** 端到端集成验证：全真实装配（内存外无一 mock），
 *  以「直接落队」模拟入口（入口适配器的本质动作就是 queue.enqueue），
 *  走通 落队 → 入口循环 → Lifecycle 四步时序 → 派生扇出 → 出口循环 → 真实投递 全链路 */

let tmpDir: string;
let workspace: string;
let handle: ServerHandle | null = null;
let receiver: Server | null = null;
let testBusinessId = "";
/** 出口接收服务器已收到的投递（body JSON） */
let received: unknown[] = [];

/** 轮询等待条件成立（默认总超时 15s） */
async function waitFor(
  describe: string,
  cond: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时: ${describe}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 造资产：临时目录 git init + commit 一个包资产（含流程程序 fixture），返回仓库路径 */
function makeAssetRepo(): string {
  const repoDir = join(tmpDir, "asset-repo");
  mkdirSync(join(repoDir, "programs"), { recursive: true });
  writeFileSync(
    join(repoDir, "agent-package.json"),
    JSON.stringify({
      name: "integration-test-pkg",
      version: "0.1.0",
      programs: { main: "programs/main.js" },
    }),
  );
  // 流程程序 fixture：读 stdin 信封，stdout 输出一行契约结果
  // （echo = 入口事件 payload 原样；got_config = vars 桶的 X，验证两桶注入）
  writeFileSync(
    join(repoDir, "programs", "main.js"),
    `let buf = "";
// stderr 业务日志行：runner 采集后落盘 logs/businesses/.../{run_id}.log（文件懒建，首行才产生）
process.stderr.write("integration fixture 执行中\\n");
process.stdin.on("data", (chunk) => { buf += chunk; });
process.stdin.on("end", () => {
  const envelope = JSON.parse(buf);
  process.stdout.write(JSON.stringify({
    contract_version: "v1",
    ok: true,
    output: { echo: envelope.input.payload, got_config: envelope.config["X"] },
  }));
});
`,
  );
  // 业务初始化脚本（物化纪律：package 资产必带）：产物 programs/main.js 已随仓库提交，无需构建
  writeFileSync(
    join(repoDir, "agent.materialize.mjs"),
    "// 集成测试 fixture：产物已随仓库提交，无需构建\n",
  );
  execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@test",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "-m",
      "init",
    ],
    { cwd: repoDir },
  );
  return repoDir;
}

/** 起本地出口接收服务器（127.0.0.1 随机端口），返回 url */
function startReceiver(): Promise<string> {
  return new Promise((resolve, reject) => {
    received = [];
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        // 空 body（如自检的 registry HEAD 探测）不算投递，不入账
        if (body !== "") {
          try {
            received.push(JSON.parse(body));
          } catch {
            received.push(body);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    receiver.on("error", reject);
    receiver.listen(0, "127.0.0.1", () => {
      const { port } = receiver!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/hook`);
    });
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-integration-test-"));
  workspace = join(tmpDir, "workspace");

  // fixture 假 pi（自检要求存在可执行；本链路不发起 agent 调用，不会被 spawn）
  const piCliPath = join(tmpDir, "fake-pi");
  writeFileSync(piCliPath, "#!/bin/sh\nexit 0\n");
  chmodSync(piCliPath, 0o755);
  // fixture pi_agent_dir（自检要求含可解析、非空的 models.json；伪造占位内容）
  const piAgentDir = join(tmpDir, "pi-agent-dir");
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

  const receiverUrl = await startReceiver();
  const repoDir = makeAssetRepo();

  handle = await bootstrap({
    env: {
      AGENT_WORKSPACE: workspace,
      AGENT_PI_CLI_PATH: piCliPath,
      AGENT_PI_AGENT_DIR: piAgentDir,
      AGENT_CONSOLE_PORT: "0", // 随机端口，避免与本机/并发测试的 6100 冲突
      AGENT_WEBHOOK_PORT: "0", // webhook 入口适配器同理（T21b 起默认开启，随机端口避冲突）
      // 自检的 registry 可达性检查指向本地接收服务器（测试不触外网）
      AGENT_NPM_REGISTRY: receiverUrl,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmpDir,
    },
  });

  // 登记包资产 → 建业务（绑包 + 入口程序 + 出口绑定 webhook）→ vars 写 X
  const asset = handle.context.assets.register({
    kind: "package",
    url: repoDir,
    ref: "HEAD",
    owner_id: "tester",
  });
  const businessId = handle.context.registry.create({
    business_name: "集成测试业务",
    creator_id: "tester",
    source: "manual",
    event_type: "test.ping",
    prompt: "集成测试总纲",
    package_asset_id: asset.asset_id,
    entry_program: "main",
    exit_bindings: [{ tool: "webhook", config: { url: receiverUrl } }],
  });
  handle.context.env.set(businessId, "vars", "X", "X值");
  testBusinessId = businessId;

  // 模拟入口落队（等价于入口适配器的落队动作）
  handle.context.entryQueue.enqueue({
    contract_version: "v1",
    source: "manual",
    event_id: "evt_integration_1",
    event_type: "test.ping",
    timestamp: new Date().toISOString(),
    session_id: "S-1",
    correlation_id: "evt_integration_1",
    hop_count: 0,
    payload: { hello: "world" },
  });
}, 30_000);

afterAll(async () => {
  if (handle !== null) {
    await handle.stop(); // 干净退出（不挂起）
    handle = null;
  }
  if (receiver !== null) {
    await new Promise<void>((resolve) => receiver!.close(() => resolve()));
    receiver = null;
  }
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
}, 30_000);

describe("端到端：直接落队 → 业务执行 → 出口投递", () => {
  it("① 出口接收服务器收到投递，payload = { echo: 原 payload, got_config: X值 }", async () => {
    await waitFor("出口投递到达", () => received.length > 0);
    expect(received[0]).toEqual({
      echo: { hello: "world" },
      got_config: "X值",
    });
  }, 30_000);

  it("② lifecycles 表有该业务 success 行；③ 业务 run 日志落盘；④ run 工作区存在", async () => {
    const ctx = (handle as ServerHandle).context;
    // ② lifecycles success 行
    await waitFor(
      "lifecycles success 行",
      () =>
        ctx.db.get<{ status: string }>(
          "SELECT status FROM lifecycles WHERE business_id = ? AND status = 'success'",
          [testBusinessId],
        ) !== undefined,
    );
    // ③ logs/businesses/manual/S-1/{bid}/ 下有 run 日志文件
    const bizLogDir = join(
      workspace,
      "logs",
      "businesses",
      "manual",
      "S-1",
      testBusinessId,
    );
    await waitFor("业务 run 日志文件", () => {
      try {
        return readdirSync(bizLogDir).some((f) => f.endsWith(".log"));
      } catch {
        return false;
      }
    });
    // ④ runs/manual/S-1/{bid}/ 下有 run 工作区
    const runsDir = join(workspace, "runs", "manual", "S-1", testBusinessId);
    await waitFor("run 工作区", () => {
      try {
        return readdirSync(runsDir).some((f) => f.startsWith("run_"));
      } catch {
        return false;
      }
    });
  }, 30_000);
});
