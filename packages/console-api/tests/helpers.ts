import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssetRegistry } from "@asteriskzuo/agent-asset-registry";
import type { AssetRegistry } from "@asteriskzuo/agent-asset-registry";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { createExitRegistry } from "@asteriskzuo/agent-exit-tools";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createTaskQueue } from "@asteriskzuo/agent-queue";
import type { TaskQueue } from "@asteriskzuo/agent-queue";
import { createBusinessRegistry } from "@asteriskzuo/agent-registry";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import {
  createEnvProvider,
  createLifecycleStore,
} from "@asteriskzuo/agent-runtime";
import type {
  EnvProvider,
  LifecycleStore,
  LifecycleWriter,
} from "@asteriskzuo/agent-runtime";
import { createConsoleApi } from "../src/index.js";
import type { ConsoleApi, EffectiveConfigView } from "../src/index.js";
import { createAccountService } from "../src/accounts.js";
import type { AccountService } from "../src/accounts.js";
import { assertPlaceholderKeysExist } from "../src/placeholder-validation.js";
import { ApiError } from "../src/errors.js";
import type { BusinessPiConfigService } from "../src/routes-pi-config.js";
import type { UpdateSubmitter } from "../src/updates.js";
import type {
  BusinessPatch,
  CreateBusinessInput,
} from "@asteriskzuo/agent-registry";
import type { EventSource } from "@asteriskzuo/agent-contracts";
import type { AssetInput } from "@asteriskzuo/agent-asset-registry";

/** 测试用生效配置回显（GET /api/config 断言基准） */
export const TEST_CONFIG_VIEW: EffectiveConfigView = {
  workspace: "/tmp/console-api-test-workspace",
  log_level: "info",
  log_enabled: true,
  hop_limit: 8,
  task_concurrency: 4,
  result_concurrency: 16,
  task_timeout_minutes: 60,
  max_agent_calls: 20,
  pi_cli_path: "/fake/pi",
  pi_agent_dir: "/fake/agent-dir",
  models: ["test/model-a", "test/model-b"],
  agents: ["pi"],
  entry_adapters: [
    {
      id: "webhook",
      kind: "webhook",
      name: "自定义 Webhook",
      defaultEnabled: true,
      enabled: true,
      configSchema: [
        { key: "path", label: "URL 路径段", required: true },
        { key: "session_id_key", label: "session_id 字段路径", required: true },
      ],
      eventDoc: "# 自定义 Webhook 入口\n\nPOST /hooks/{path}",
    },
    {
      id: "jira-polling",
      kind: "jira",
      name: "Jira 定时轮询",
      defaultEnabled: false,
      enabled: false,
      configSchema: [
        { key: "jira_url", label: "Jira 站点根地址", required: true },
      ],
      eventDoc: "# Jira 定时轮询入口",
    },
  ],
};

// logger 全局外观每进程只能 init 一次：测试文件内多个 startTestServer 共用同一个
// （enabled=false 不落盘）；afterAll 调 resetTestLogger 复位
let loggerDir: string | null = null;

function ensureTestLogger(): void {
  if (loggerDir !== null) return;
  loggerDir = mkdtempSync(join(tmpdir(), "console-api-test-logs-"));
  initLogger({ logsDir: loggerDir, enabled: false });
}

/** 测试文件 afterAll 必调：复位 logger 全局外观并清日志目录 */
export function resetTestLogger(): void {
  if (loggerDir !== null) {
    rmSync(loggerDir, { recursive: true, force: true });
    loggerDir = null;
  }
  resetForTests();
}

/** 一套起好的测试服务：真实 HTTP（随机端口）+ 内存 db + 全真实依赖 */
export interface TestServer {
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  tmpDir: string;
  db: Database;
  accounts: AccountService;
  registry: BusinessRegistry;
  assets: AssetRegistry;
  env: EnvProvider;
  entryQueue: TaskQueue;
  exitQueue: TaskQueue;
  lifecycle: LifecycleStore & LifecycleWriter;
  api: ConsoleApi;
  /** 关 API + close db + 清临时目录（幂等） */
  stop(): Promise<void>;
}

/** 测试用直接更新提交器：无队列无屏障，立即按命令内容直写生效注册表。
 *  与 app/server 的 UpdateCoordinator 生产路径等价的效果，但绕过闲时/屏障语义
 *  （那些语义由 app/server 集成测试覆盖，console-api 单测只关心路由行为） */
function createDirectUpdates(deps: {
  registry: BusinessRegistry;
  env: EnvProvider;
  assets: AssetRegistry;
}): UpdateSubmitter {
  const { registry, env, assets } = deps;
  const credentialOf = (key?: string): string | undefined =>
    key === undefined ? undefined : env.getFor("").secrets[key];
  return {
    submit(command) {
      const p = command.payload as Record<string, unknown>;
      const result = ((): unknown => {
        switch (command.kind) {
          case "business.create": {
            const input = p.input as CreateBusinessInput;
            const businessId = registry.create(input);
            const written: Array<{ bucket: "vars" | "secrets"; key: string }> =
              [];
            try {
              for (const entry of (p.env_entries ?? []) as Array<{
                bucket: "vars" | "secrets";
                key: string;
                value: string;
              }>) {
                env.set(businessId, entry.bucket, entry.key, entry.value);
                written.push(entry);
              }
              if (p.entry_config !== undefined) {
                assertPlaceholderKeysExist(
                  env,
                  businessId,
                  p.entry_config as Record<string, unknown>,
                  "entry_config",
                );
              }
              for (const [index, binding] of (
                input.exit_bindings ?? []
              ).entries()) {
                assertPlaceholderKeysExist(
                  env,
                  businessId,
                  binding.config,
                  `exit_bindings[${index}].config`,
                );
              }
            } catch (err) {
              for (const entry of written) {
                env.remove(businessId, entry.bucket, entry.key);
              }
              registry.remove(businessId);
              throw err;
            }
            if (p.entry_config !== undefined) {
              registry.removeMatch(businessId, input.source, input.event_type);
              registry.addMatch(
                businessId,
                input.source,
                input.event_type,
                p.entry_config as Record<string, unknown>,
              );
            }
            return registry.getProfile(businessId);
          }
          case "business.patch":
            registry.update(p.business_id as string, p.patch as BusinessPatch);
            return null;
          case "business.delete":
            registry.remove(p.business_id as string);
            return null;
          case "business.match.add":
            registry.addMatch(
              p.business_id as string,
              p.source as EventSource,
              p.event_type as string,
              p.entry_config as Record<string, unknown> | undefined,
            );
            return registry.get(p.business_id as string);
          case "business.match.remove":
            registry.removeMatch(
              p.business_id as string,
              p.source as EventSource,
              p.event_type as string,
            );
            return null;
          case "env.global.set":
            env.set(
              null,
              p.bucket as "vars" | "secrets",
              p.key as string,
              p.value as string,
            );
            return null;
          case "env.global.remove":
            env.remove(null, p.bucket as "vars" | "secrets", p.key as string);
            return null;
          case "env.business.set":
            env.set(
              p.business_id as string,
              p.bucket as "vars" | "secrets",
              p.key as string,
              p.value as string,
            );
            return null;
          case "env.business.remove":
            env.remove(
              p.business_id as string,
              p.bucket as "vars" | "secrets",
              p.key as string,
            );
            return null;
          case "asset.register": {
            const input = p.input as AssetInput;
            return assets.register(input, {
              credential: credentialOf(input.credential_key),
            });
          }
          case "asset.update":
            return assets.updateRef(p.asset_id as string, p.commit as string, {
              credential: credentialOf(p.credential_key as string | undefined),
            });
          case "asset.enabled.set":
            return assets.setEnabled(
              p.asset_id as string,
              p.enabled as boolean,
            );
          case "asset.remove":
            assets.remove(p.asset_id as string);
            return null;
          case "asset.cache.clear":
            assets.clearCache();
            return { cleared: true };
          default:
            throw new Error(`测试提交器未知命令: ${command.kind}`);
        }
      })();
      return Promise.resolve({
        update_id: "upd_test",
        outcome: "applied" as const,
        result,
      });
    },
  };
}

/** 测试桩：业务 Pi 配置服务（真实验证链路属 app/server 测试；console-api 单测只验路由形状与权限） */
function createStubPiConfig(
  registry: BusinessRegistry,
): BusinessPiConfigService {
  return {
    getConfig: (businessId) => ({
      configured: false,
      model: registry.getProfile(businessId)?.model ?? "",
    }),
    validate: () =>
      Promise.reject(new ApiError("invalid_input", "测试桩：不执行真实验证")),
    confirm: () =>
      Promise.reject(new ApiError("conflict", "测试桩：无有效凭据")),
    remove: () =>
      Promise.reject(new ApiError("invalid_input", "测试桩：不支持")),
  };
}

/** 起测试服务。deps 全真实（无 mock）；bootstrap_admin 注入首启 admin；static_dir 开启静态托管 */
export async function startTestServer(
  options: {
    bootstrap_admin?: { username: string; password: string };
    static_dir?: string;
  } = {},
): Promise<TestServer> {
  ensureTestLogger();
  const tmpDir = mkdtempSync(join(tmpdir(), "console-api-test-"));
  const db = openDatabase(":memory:");
  const registry = createBusinessRegistry(db);
  const assets = createAssetRegistry(db, {
    cache_root: join(tmpDir, "cache", "assets"),
  });
  const env = createEnvProvider(db);
  const entryQueue = createTaskQueue(db, "entry_tasks");
  const exitQueue = createTaskQueue(db, "exit_tasks");
  const lifecycle = createLifecycleStore(db);
  const accounts = createAccountService(db);
  const api = createConsoleApi(
    {
      db,
      registry,
      assets,
      env,
      exits: createExitRegistry(),
      updates: createDirectUpdates({ registry, env, assets }),
      piConfig: createStubPiConfig(registry),
      entryQueue,
      exitQueue,
      lifecycle,
      config: TEST_CONFIG_VIEW,
    },
    {
      port: 0,
      ...(options.bootstrap_admin
        ? { bootstrap_admin: options.bootstrap_admin }
        : {}),
      ...(options.static_dir !== undefined
        ? { static_dir: options.static_dir }
        : {}),
    },
  );
  const port = await api.start();
  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tmpDir,
    db,
    accounts,
    registry,
    assets,
    env,
    entryQueue,
    exitQueue,
    lifecycle,
    api,
    async stop() {
      if (stopped) return;
      stopped = true;
      await api.stop();
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** fetch 封装返回值 */
export interface ApiResponse {
  status: number;
  /** JSON 解析结果；无体（204）为 null */
  body: unknown;
  headers: Headers;
}

/** 发请求：body 对象自动 JSON 序列化；rawBody 用于构造非法 JSON/超限 body；token 走 cookie */
export async function api(
  server: TestServer,
  method: string,
  path: string,
  options: {
    body?: unknown;
    rawBody?: string;
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) {
    headers.cookie = `agent_console_token=${options.token}`;
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    body,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

/** 登录并取会话 token（从 Set-Cookie 解析）；登录失败抛错 */
export async function loginToken(
  server: TestServer,
  username: string,
  password: string,
): Promise<string> {
  const res = await api(server, "POST", "/api/auth/login", {
    body: { username, password },
  });
  if (res.status !== 201) {
    throw new Error(`login 失败: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /agent_console_token=([0-9a-f]+)/.exec(setCookie);
  if (match === null) {
    throw new Error(`Set-Cookie 无 token: ${setCookie}`);
  }
  return match[1];
}

/** admin 经 API 建 member 并登录，返回 { user_id, token } */
export async function createMemberAndLogin(
  server: TestServer,
  adminToken: string,
  username: string,
  password = "member-pass",
): Promise<{ user_id: string; token: string }> {
  const res = await api(server, "POST", "/api/users", {
    token: adminToken,
    body: {
      username,
      display_name: username,
      password,
      role: "member",
    },
  });
  if (res.status !== 201) {
    throw new Error(
      `建 member 失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  const user = res.body as { user_id: string };
  const token = await loginToken(server, username, password);
  return { user_id: user.user_id, token };
}

/** 合法事件信封 fixture（enqueue 用） */
export function envelope(eventId: string): EventEnvelope {
  return {
    contract_version: "v1",
    source: "manual",
    event_id: eventId,
    event_type: "test.ping",
    timestamp: new Date().toISOString(),
    session_id: "S-1",
    correlation_id: eventId,
    hop_count: 0,
    payload: { hello: eventId },
  };
}

/** 本地 git 命令封装：显式带 user 配置，不依赖全局 git config */
export function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@test", "-c", "user.name=test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** 造一个本地 git 仓库：写入 files（相对路径 → 内容）并提交，返回目录 */
export function makeRepo(
  baseDir: string,
  files: Record<string, string>,
): string {
  const dir = mkdtempSync(join(baseDir, "repo-"));
  git(["init"], dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

/** 合法 package 仓库的清单文件集合（物化纪律：package/tool 必带 agent.materialize.mjs；
 *  契约闸口径：contract.json + 两个保留程序名齐备；本 fixture 产物已随仓库提交，用空脚本） */
export const PKG_FILES: Record<string, string> = {
  "agent-package.json": JSON.stringify({
    name: "demo",
    version: "1.0.0",
    programs: {
      main: "src/main.js",
      "check-input": "src/check-input.js",
      "check-output": "src/check-output.js",
    },
  }),
  "src/main.js": "console.log('hi');",
  "src/check-input.js": "console.log('check-input');",
  "src/check-output.js": "console.log('check-output');",
  "contract.json": JSON.stringify({ version: 1, input: null, output: null }),
  "agent.materialize.mjs": "// 测试 fixture：产物已随仓库提交，无需构建\n",
};
