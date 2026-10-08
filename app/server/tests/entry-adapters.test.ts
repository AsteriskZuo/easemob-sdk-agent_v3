import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

/** 入口适配器开关（§7.4）装配验证：全真实装配，
 *  断言 开启=创建并启动（webhook 端口可达）/ 关闭=不创建不启动（端口拒连）+ 启动日志含开关状态 */

let tmpDir: string;
let registryStub: Server | null = null;
let handle: ServerHandle | null = null;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-entry-adapters-test-"));
  // 自检的 npm registry 可达性检查指向本地桩（测试不触外网）
  registryStub = createServer((_req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  await new Promise<void>((resolve) =>
    registryStub!.listen(0, "127.0.0.1", resolve),
  );
});

afterAll(async () => {
  if (registryStub !== null) {
    await new Promise<void>((resolve) => registryStub!.close(() => resolve()));
    registryStub = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  if (handle !== null) {
    await handle.stop();
    handle = null;
  }
  resetForTests();
});

/** 取一个当前空闲端口（先听后放；竞态窗口在测试环境可接受） */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function stubRegistryUrl(): string {
  return `http://127.0.0.1:${(registryStub!.address() as AddressInfo).port}/`;
}

/** 造完整可过自检的 fixture（假 pi + models.json + 独立 workspace），返回 bootstrap envMap */
async function makeEnv(
  name: string,
  over: Record<string, string | undefined> = {},
): Promise<Record<string, string | undefined>> {
  const dir = join(tmpDir, name);
  const workspace = join(dir, "workspace");
  const piCliPath = join(dir, "fake-pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(piCliPath, "#!/bin/sh\nexit 0\n");
  chmodSync(piCliPath, 0o755);
  const piAgentDir = join(dir, "pi-agent-dir");
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
  return {
    AGENT_WORKSPACE: workspace,
    AGENT_PI_CLI_PATH: piCliPath,
    AGENT_PI_AGENT_DIR: piAgentDir,
    AGENT_CONSOLE_PORT: "0",
    AGENT_NPM_REGISTRY: stubRegistryUrl(),
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? dir,
    ...over,
  };
}

/** 读 system.log 全文（断言启动日志用） */
function readSystemLog(workspace: string): string {
  return readFileSync(join(workspace, "logs", "system.log"), "utf8");
}

/** 轮询直到 webhook 端口有响应（bootstrap 返回时 listen 可能尚未完成） */
async function waitWebhookUp(port: number): Promise<Response> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${port}/hooks/nope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      if (Date.now() > deadline) {
        throw new Error("waitWebhookUp 超时：webhook 端口一直拒连");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("入口适配器开关（AGENT_ENTRY_*_ENABLED）", () => {
  it("默认开关：webhook 启动（端口可达，未知 path → 404）；jira-polling 默认关闭；启动日志列出开关状态", async () => {
    const webhookPort = await freePort();
    const env = await makeEnv("case-default", {
      AGENT_WEBHOOK_PORT: String(webhookPort),
    });
    handle = await bootstrap({ env });

    // webhook 已监听：无任何业务行 → 404（证明服务活着且走 path 路由）
    const res = await waitWebhookUp(webhookPort);
    expect(res.status).toBe(404);

    // 启动日志含各适配器开关状态（含关闭的）
    const log = readSystemLog(env.AGENT_WORKSPACE as string);
    expect(log).toContain("入口适配器开关");
    expect(log).toContain('"id":"webhook","enabled":true');
    expect(log).toContain('"id":"jira-polling","enabled":false');
  }, 30_000);

  it("webhook 关闭：不创建不启动（端口拒连），平台照常启动；日志含 enabled:false", async () => {
    const webhookPort = await freePort();
    const env = await makeEnv("case-webhook-off", {
      AGENT_WEBHOOK_PORT: String(webhookPort),
      AGENT_ENTRY_WEBHOOK_ENABLED: "false",
    });
    handle = await bootstrap({ env });

    // 关闭 = 不监听：fetch 连接被拒
    await expect(
      fetch(`http://127.0.0.1:${webhookPort}/hooks/x`, { method: "POST" }),
    ).rejects.toThrow();

    const log = readSystemLog(env.AGENT_WORKSPACE as string);
    expect(log).toContain('"id":"webhook","enabled":false');
  }, 30_000);

  it("jira-polling 开启：无任何 jira 行/凭据配置也启动成功（关闭的适配器不看配置，开启的也无全局必需配置）", async () => {
    const webhookPort = await freePort();
    const env = await makeEnv("case-jira-on", {
      AGENT_WEBHOOK_PORT: String(webhookPort),
      AGENT_ENTRY_JIRA_POLLING_ENABLED: "true",
    });
    handle = await bootstrap({ env });

    // 启动成功且日志含开启状态；无 jira 行 → 无轮询器无任何动作
    const log = readSystemLog(env.AGENT_WORKSPACE as string);
    expect(log).toContain('"id":"jira-polling","enabled":true');
    expect(log).toContain("平台启动完成");
  }, 30_000);
});
