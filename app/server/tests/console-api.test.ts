import { jest } from "@jest/globals";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetForTests } from "@asterisk/agent-logger";
import { bootstrap } from "../src/index.js";
import type { ServerHandle } from "../src/index.js";

jest.setTimeout(60000);

let tmpDir: string;
let piCliPath: string;
let piAgentDir: string;
let handle: ServerHandle | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-console-test-"));
  piCliPath = join(tmpDir, "fake-pi");
  writeFileSync(piCliPath, "#!/bin/sh\nexit 0\n");
  chmodSync(piCliPath, 0o755);
  piAgentDir = join(tmpDir, "pi-agent-dir");
  mkdirSync(piAgentDir, { recursive: true });
  // 合法 models.json（伪造占位内容；自检要求可解析且非空）
  writeFileSync(
    join(piAgentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: "https://test-provider.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-fake-placeholder",
          models: [{ id: "model-a" }, { id: "model-b" }],
        },
      },
    }),
  );
});

afterEach(async () => {
  if (handle !== null) {
    await handle.stop();
    handle = null;
  }
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 取一个当前空闲的端口（释放后给 console API 用；存在竞态窗口，本地测试可接受） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function testEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AGENT_WORKSPACE: join(tmpDir, "workspace"),
    AGENT_PI_CLI_PATH: piCliPath,
    AGENT_PI_AGENT_DIR: piAgentDir,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpDir,
    ...over,
  };
}

describe("bootstrap 装配管理 API", () => {
  it("首启 admin 注入 → 端口可连、登录全链路；stop 后连接被拒绝", async () => {
    const port = await freePort();
    handle = await bootstrap({
      env: testEnv({
        AGENT_CONSOLE_PORT: String(port),
        AGENT_ADMIN_USERNAME: "root",
        AGENT_ADMIN_PASSWORD: "root-pass",
      }),
    });

    // 未登录 → 401（API 已在监听）
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    expect(unauthenticated.status).toBe(401);

    // 注入的首启 admin 可登录
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "root-pass" }),
    });
    expect(login.status).toBe(201);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const token = /agent_console_token=([0-9a-f]+)/.exec(setCookie)?.[1];
    expect(token).toBeDefined();

    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { cookie: `agent_console_token=${token}` },
    });
    expect(me.status).toBe(200);
    const user = (await me.json()) as { username: string; role: string };
    expect(user.username).toBe("root");
    expect(user.role).toBe("admin");

    // GET /api/config 携带 models（pi_agent_dir/models.json 解析结果）与 agents（MVP 恒 ['pi']）
    const configRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { cookie: `agent_console_token=${token}` },
    });
    expect(configRes.status).toBe(200);
    const configView = (await configRes.json()) as {
      models: string[];
      agents: string[];
      entry_adapters: Array<{
        id: string;
        enabled: boolean;
        eventDoc: string;
        configSchema: unknown[];
      }>;
    };
    expect(configView.models).toEqual([
      "test-provider/model-a",
      "test-provider/model-b",
    ]);
    expect(configView.agents).toEqual(["pi"]);
    // 入口适配器自描述 + 开关状态（默认：webhook 开、jira-polling 关）
    const webhook = configView.entry_adapters.find((a) => a.id === "webhook");
    expect(webhook?.enabled).toBe(true);
    expect(webhook?.eventDoc.length).toBeGreaterThan(0);
    expect(webhook?.configSchema.length).toBeGreaterThan(0);
    const jiraPolling = configView.entry_adapters.find(
      (a) => a.id === "jira-polling",
    );
    expect(jiraPolling?.enabled).toBe(false);

    // stop 后连接被拒绝
    await handle.stop();
    handle = null;
    await expect(
      fetch(`http://127.0.0.1:${port}/api/auth/me`),
    ).rejects.toThrow();
  });

  it("AGENT_CONSOLE_STATIC_DIR 开启静态托管：/ 返回 index.html，/api 不受影响", async () => {
    const staticDir = join(tmpDir, "console-dist");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(
      join(staticDir, "index.html"),
      "<!doctype html><html><body>console</body></html>",
    );

    const port = await freePort();
    handle = await bootstrap({
      env: testEnv({
        AGENT_CONSOLE_PORT: String(port),
        AGENT_CONSOLE_STATIC_DIR: staticDir,
      }),
    });

    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("console");

    // /api 前缀永远优先于静态分支
    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    expect(me.status).toBe(401);
  });

  it("AGENT_ENTRY_JIRA_POLLING_ENABLED=true → /api/config 里该适配器 enabled 为 true", async () => {
    const port = await freePort();
    handle = await bootstrap({
      env: testEnv({
        AGENT_CONSOLE_PORT: String(port),
        AGENT_ADMIN_USERNAME: "root",
        AGENT_ADMIN_PASSWORD: "root-pass",
        AGENT_ENTRY_JIRA_POLLING_ENABLED: "true",
      }),
    });
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "root-pass" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const token = /agent_console_token=([0-9a-f]+)/.exec(setCookie)?.[1];

    const configRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { cookie: `agent_console_token=${token}` },
    });
    expect(configRes.status).toBe(200);
    const configView = (await configRes.json()) as {
      entry_adapters: Array<{ id: string; enabled: boolean }>;
    };
    expect(
      configView.entry_adapters.find((a) => a.id === "jira-polling")?.enabled,
    ).toBe(true);
  });

  it("未注入首启 admin（'missing'）不阻断启动；登录 401", async () => {
    const port = await freePort();
    handle = await bootstrap({
      env: testEnv({ AGENT_CONSOLE_PORT: String(port) }),
    });
    // 平台正常起来了（users 表为空，无账号可登录）
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "root-pass" }),
    });
    expect(login.status).toBe(401);
  });
});
