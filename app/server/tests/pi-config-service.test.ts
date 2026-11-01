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
import { createBusinessPiConfigService } from "../src/pi-config-service.js";
import type { BusinessPiConfigService } from "../src/pi-config-service.js";
import { createUpdateCoordinator } from "../src/updates/coordinator.js";
import { buildUpdateHandlers } from "../src/updates/handlers.js";

/** fake pi（每个用例写到 tmpDir 并 chmod）：FAKE_PI_OK=0 时非零退出，否则回 assistant 文本 */
const FAKE_PI_SCRIPT = `#!/usr/bin/env node
const ok = (process.env.FAKE_PI_OK ?? "1") === "1";
if (!ok) {
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
`;

const BUSINESS_CONFIG = {
  providers: {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "sk-test-secret",
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
    globalModels: ["qwen/qwen-plus", "deepseek/deepseek-chat"],
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

test("验证 → 确认 → 生效：pi_models 写入且 model 同步；GET 视图脱敏不回显 apiKey", async () => {
  const v = await service.validate(
    businessId,
    "user-1",
    "deepseek/deepseek-chat",
    BUSINESS_CONFIG,
  );
  expect(v.validation_id).toMatch(/^val_/);
  expect(v.duration_ms).toBeGreaterThan(0);
  // 验证成功但尚未生效
  expect(registry.getPiModels(businessId)).toBeUndefined();

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

test("验证失败（探针非零）→ 400 且不产生凭据；目录被清理", async () => {
  const failing = createBusinessPiConfigService({
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
    pi_env: { PATH: process.env.PATH ?? "", FAKE_PI_OK: "0" },
    globalModels: ["qwen/qwen-plus"],
  });
  await expect(
    failing.validate(
      businessId,
      "user-1",
      "deepseek/deepseek-chat",
      BUSINESS_CONFIG,
    ),
  ).rejects.toThrow(/配置验证失败/);
  expect(registry.getPiModels(businessId)).toBeUndefined();
  // 验证目录已被清理（validations 根不存在或为空）
  const validationsDir = join(
    tmpDir,
    "businesses",
    businessId,
    "cache",
    "pi",
    "validations",
  );
  expect(
    existsSync(validationsDir) && readdirSync(validationsDir).length > 0,
  ).toBe(false);
  failing.close();
});

test("掩码占位符拒绝验证（不把 ****** 当真值）", async () => {
  await expect(
    service.validate(businessId, "user-1", "deepseek/deepseek-chat", {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          api: "openai-completions",
          apiKey: "******",
        },
      },
    }),
  ).rejects.toThrow(/敏感字段需重新填写/);
});

test("确认：无效/跨业务/跨操作者凭据 → 409", async () => {
  const v = await service.validate(
    businessId,
    "user-1",
    "deepseek/deepseek-chat",
    BUSINESS_CONFIG,
  );
  await expect(
    service.confirm(businessId, "user-2", v.validation_id),
  ).rejects.toThrow(/不属于该业务\/操作者/);
  const other = registry.create({
    business_name: "别的业务",
    creator_id: "user-2",
    source: "jira",
    event_type: "issue.updated",
  });
  await expect(
    service.confirm(other, "user-1", v.validation_id),
  ).rejects.toThrow(/不属于该业务\/操作者/);
  await expect(
    service.confirm(businessId, "user-1", "val_nonexistent"),
  ).rejects.toThrow(/无效或已过期/);
});

test("删除自定义：回退模型必须 ∈ 全局可选；成功后 pi_models 清空、model 切换", async () => {
  const v = await service.validate(
    businessId,
    "user-1",
    "deepseek/deepseek-chat",
    BUSINESS_CONFIG,
  );
  await service.confirm(businessId, "user-1", v.validation_id);

  await expect(
    service.remove(businessId, "user-1", "not/global"),
  ).rejects.toThrow(/全局可选模型/);
  const submission = await service.remove(
    businessId,
    "user-1",
    "qwen/qwen-plus",
  );
  expect(submission.outcome).toBe("applied");
  expect(registry.getPiModels(businessId)).toBeUndefined();
  expect(registry.getProfile(businessId)?.model).toBe("qwen/qwen-plus");
  expect(service.getConfig(businessId).configured).toBe(false);
});
