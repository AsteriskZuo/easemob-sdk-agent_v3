import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createUpdateQueue } from "@asteriskzuo/agent-queue";
import { createBusinessRegistry } from "@asteriskzuo/agent-registry";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import { createEnvProvider } from "@asteriskzuo/agent-runtime";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import { createAssetRegistry } from "@asteriskzuo/agent-asset-registry";
import type { PiValidationStatus } from "@asteriskzuo/agent-console-api";
import { createBusinessPiConfigService } from "../src/pi-config-service.js";
import type { BusinessPiConfigService } from "../src/pi-config-service.js";
import { createUpdateCoordinator } from "../src/updates/coordinator.js";
import { buildUpdateHandlers } from "../src/updates/handlers.js";

/** fake pi（每个用例写到 tmpDir 并 chmod）：--model 含 "bad" 或 FAKE_PI_OK=0 → 非零退出；
 *  FAKE_PI_SLEEP_MS 可模拟慢探针；否则回 assistant 文本 */
const FAKE_PI_SCRIPT = `#!/usr/bin/env node
const ok = (process.env.FAKE_PI_OK ?? "1") === "1";
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS ?? "0");
const modelIdx = process.argv.indexOf("--model");
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : "";
const fail = !ok || model.includes("bad");
setTimeout(() => {
  if (fail) {
    process.stderr.write("fake pi 验证失败: 模型不可达\\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ type: "session", session_id: "fake" }) + "\\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "pong" }] },
    }) + "\\n",
  );
  process.exit(0);
}, sleepMs);
`;

/** 合法配置（显式 models；spec §9.2 简写已废除） */
const BUSINESS_CONFIG = {
  providers: {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "sk-test-secret",
      models: [{ id: "deepseek-chat" }],
    },
  },
};

/** 双 provider 配置：local/bad-model 会被 fake pi 判失败（model 名含 "bad"） */
const MULTI_CONFIG = {
  providers: {
    cloud: {
      baseUrl: "https://cloud.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-cloud",
      models: [{ id: "good" }],
    },
    local: {
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "bad-model" }],
    },
  },
};

let tmpDir: string;
let loggerDir: string | null = null;
let db: Database;
let registry: BusinessRegistry;
let env: EnvProvider;
let service: BusinessPiConfigService;
let businessId: string;
let fakePiPath: string;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询到终态（done/failed）；fake pi 毫秒级，100×25ms 足够 */
async function waitDone(
  svc: BusinessPiConfigService,
  bid: string,
  validationId: string,
): Promise<PiValidationStatus> {
  for (let i = 0; i < 200; i += 1) {
    const status = svc.getValidation(bid, validationId);
    if (status.status !== "running") return status;
    await sleep(25);
  }
  throw new Error("验证超时未结束");
}

beforeEach(async () => {
  if (loggerDir === null) {
    loggerDir = mkdtempSync(join(tmpdir(), "pi-config-test-logs-"));
    initLogger({ logsDir: loggerDir, enabled: false });
  }
  tmpDir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
  fakePiPath = join(tmpDir, "fake-pi.js");
  writeFileSync(fakePiPath, FAKE_PI_SCRIPT);
  chmodSync(fakePiPath, 0o755);
  db = openDatabase(join(tmpDir, "test.db"));
  registry = createBusinessRegistry(db);
  env = createEnvProvider(db);
  const assets = createAssetRegistry(db, {
    cache_root: join(tmpDir, "cache", "assets"),
  });
  const coordinator = createUpdateCoordinator({
    queue: createUpdateQueue(db),
    handlers: buildUpdateHandlers({ registry, env, assets }),
  });
  service = createBusinessPiConfigService({
    registry,
    updates: coordinator,
    workspace: tmpDir,
    pi_cli_path: fakePiPath,
    pi_env: { PATH: process.env.PATH ?? "" },
  });
  businessId = registry.create({
    business_name: "pi 配置业务",
    creator_id: "user-1",
    source: "jira",
    event_type: "issue.created",
  });
});

afterEach(() => {
  service.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  if (loggerDir !== null) {
    rmSync(loggerDir, { recursive: true, force: true });
    loggerDir = null;
  }
  resetForTests();
});

test("提交 202 → 轮询 done 全过 → 确认生效：pi_models 写入且 model = 派生默认；GET 视图脱敏", async () => {
  const v = service.validate(businessId, "user-1", BUSINESS_CONFIG);
  expect(v.validation_id).toMatch(/^val_/);
  expect(v.total).toBe(1);
  // 验证成功前尚未生效
  expect(registry.getPiModels(businessId)).toBeUndefined();

  const done = await waitDone(service, businessId, v.validation_id);
  expect(done.status).toBe("done");
  if (done.status !== "done") throw new Error("unreachable");
  expect(done.all_passed).toBe(true);
  expect(done.results).toHaveLength(1);
  expect(done.results[0]).toMatchObject({
    model: "deepseek/deepseek-chat",
    ok: true,
  });
  expect(done.default_model).toBe("deepseek/deepseek-chat");

  const submission = await service.confirm(
    businessId,
    "user-1",
    v.validation_id,
  );
  expect(submission.outcome).toBe("applied");
  expect(registry.getPiModels(businessId)).toEqual(BUSINESS_CONFIG);
  expect(registry.getProfile(businessId)?.model).toBe("deepseek/deepseek-chat");

  const view = service.getConfig(businessId);
  expect(view.configured).toBe(true);
  expect(view.model).toBe("deepseek/deepseek-chat");
  const providers = view.config?.providers as Record<
    string,
    Record<string, unknown>
  >;
  expect(providers.deepseek.apiKey).toBe("******");
  expect(JSON.stringify(view.config)).not.toContain("sk-test-secret");
});

test("部分模型探针失败 → done all_passed=false 无确认资格；结果按声明顺序且失败原因脱敏", async () => {
  const v = service.validate(businessId, "user-1", MULTI_CONFIG);
  expect(v.total).toBe(2);

  const done = await waitDone(service, businessId, v.validation_id);
  expect(done.status).toBe("done");
  if (done.status !== "done") throw new Error("unreachable");
  expect(done.all_passed).toBe(false);
  // 声明顺序：cloud/good 成功、local/bad-model 失败；失败项不带 default_model
  expect(done.results.map((r) => [r.model, r.ok])).toEqual([
    ["cloud/good", true],
    ["local/bad-model", false],
  ]);
  expect(done.results[1]?.error).toContain("模型不可达");
  expect(done.default_model).toBeUndefined();

  // 有失败项：confirm 一律 409，配置不生效
  await expect(
    service.confirm(businessId, "user-1", v.validation_id),
  ).rejects.toThrow(/存在验证失败的模型/);
  expect(registry.getPiModels(businessId)).toBeUndefined();

  // 记录在 TTL 内保留（可轮询），close 后目录被清理
  const validationsDir = join(
    tmpDir,
    "businesses",
    businessId,
    "cache",
    "pi",
    "validations",
  );
  expect(existsSync(validationsDir)).toBe(true);
  service.close();
  expect(
    existsSync(validationsDir) && readdirSync(validationsDir).length > 0,
  ).toBe(false);
});

test("running 中 confirm → 409 验证尚未完成；全部探针串行（慢探针期间 results 逐条增长）", async () => {
  const slow = createBusinessPiConfigService({
    registry,
    updates: createUpdateCoordinator({
      queue: createUpdateQueue(db),
      handlers: buildUpdateHandlers({
        registry,
        env,
        assets: createAssetRegistry(db, {
          cache_root: join(tmpDir, "cache2"),
        }),
      }),
    }),
    workspace: tmpDir,
    pi_cli_path: fakePiPath,
    pi_env: {
      PATH: process.env.PATH ?? "",
      FAKE_PI_SLEEP_MS: "300",
    },
  });
  const v = slow.validate(businessId, "user-1", MULTI_CONFIG);
  // 第一个探针（300ms）未完成时 confirm → 409
  await expect(
    slow.confirm(businessId, "user-1", v.validation_id),
  ).rejects.toThrow(/验证尚未完成/);
  const done = await waitDone(slow, businessId, v.validation_id);
  expect(done.status).toBe("done");
  slow.close();
});

test("结构校验：缺 models / provider 纯整数 / 掩码占位 → 同步 400（不产生凭据、不建目录）", () => {
  expect(() =>
    service.validate(businessId, "user-1", {
      providers: { deepseek: { apiKey: "sk-x" } },
    }),
  ).toThrow(/models 必须是非空数组/);
  expect(() =>
    service.validate(businessId, "user-1", {
      providers: { "42": { models: [{ id: "m" }] } },
    }),
  ).toThrow(/纯整数形态/);
  expect(() =>
    service.validate(businessId, "user-1", {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "******",
          models: [{ id: "deepseek-chat" }],
        },
      },
    }),
  ).toThrow(/敏感字段需重新填写/);
  // 同步失败不产生任何验证记录
  expect(() => service.getValidation(businessId, "val_anything")).toThrow(
    /不存在或已过期/,
  );
});

test("getValidation：未知/跨业务 → not_found；确认：跨操作者/跨业务/无效凭据 → 409", async () => {
  const v = service.validate(businessId, "user-1", BUSINESS_CONFIG);
  expect(() => service.getValidation(businessId, "val_nonexistent")).toThrow(
    /不存在或已过期/,
  );
  const other = registry.create({
    business_name: "别的业务",
    creator_id: "user-2",
    source: "jira",
    event_type: "issue.updated",
  });
  expect(() => service.getValidation(other, v.validation_id)).toThrow(
    /不存在或已过期/,
  );

  await waitDone(service, businessId, v.validation_id);
  await expect(
    service.confirm(businessId, "user-2", v.validation_id),
  ).rejects.toThrow(/不属于该业务\/操作者/);
  await expect(
    service.confirm(other, "user-1", v.validation_id),
  ).rejects.toThrow(/不属于该业务\/操作者/);
  await expect(
    service.confirm(businessId, "user-1", "val_nonexistent"),
  ).rejects.toThrow(/无效或已过期/);
});

test("删除自定义：无需替代模型；生效后 pi_models 清空、model=''", async () => {
  const v = service.validate(businessId, "user-1", BUSINESS_CONFIG);
  await waitDone(service, businessId, v.validation_id);
  await service.confirm(businessId, "user-1", v.validation_id);
  expect(registry.getPiModels(businessId)).toBeDefined();

  const submission = await service.remove(businessId, "user-1");
  expect(submission.outcome).toBe("applied");
  expect(registry.getPiModels(businessId)).toBeUndefined();
  expect(registry.getProfile(businessId)?.model).toBe("");
  expect(service.getConfig(businessId).configured).toBe(false);
});

test("新验证取代旧验证：旧凭据 confirm → 409；旧验证目录被清理", async () => {
  const first = service.validate(businessId, "user-1", MULTI_CONFIG);
  // 同一业务立刻提交第二个验证（取代第一个，含在飞探针取消）
  const second = service.validate(businessId, "user-1", BUSINESS_CONFIG);
  expect(second.validation_id).not.toBe(first.validation_id);
  // 旧凭据不再可确认（等待第二个完成后断言第一个已作废）
  await waitDone(service, businessId, second.validation_id);
  await expect(
    service.confirm(businessId, "user-1", first.validation_id),
  ).rejects.toThrow(/无效或已过期/);
  const submission = await service.confirm(
    businessId,
    "user-1",
    second.validation_id,
  );
  expect(submission.outcome).toBe("applied");
});
