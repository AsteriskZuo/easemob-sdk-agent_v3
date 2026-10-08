import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import { createBusinessRegistry } from "@asterisk/agent-registry";
import type { BusinessRegistry } from "@asterisk/agent-registry";
import { createAssetRegistry } from "@asterisk/agent-asset-registry";
import type { AssetRegistry } from "@asterisk/agent-asset-registry";
import { createContextLoader, createEnvProvider } from "../src/index.js";
import type { ContextLoader, EnvProvider } from "../src/index.js";

jest.setTimeout(60000);

let tmpDir: string;
let db: Database;
let registry: BusinessRegistry;
let assets: AssetRegistry;
let env: EnvProvider;
let cacheRoot: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runtime-loader-test-"));
  cacheRoot = join(tmpDir, "cache");
  db = openDatabase(":memory:");
  registry = createBusinessRegistry(db);
  assets = createAssetRegistry(db, { cache_root: cacheRoot });
  env = createEnvProvider(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const DEFAULTS = { task_timeout_minutes: 60, max_agent_calls: 10 };

function newLoader(): ContextLoader {
  return createContextLoader({ registry, assets, env, defaults: DEFAULTS });
}

/** 本地 git 命令封装：显式带 user 配置，不依赖全局 git config */
function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@test", "-c", "user.name=test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** 造一个本地 git 仓库：写入 files（相对路径 → 内容）并提交 */
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpDir, "repo-"));
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

/** 物化纪律（package/tool 必带 agent.materialize.mjs）：产物已随仓库提交，用空脚本 */
const NOOP_MATERIALIZE = "// 测试 fixture：产物已随仓库提交，无需构建\n";

const PKG_FILES: Record<string, string> = {
  "agent-package.json": JSON.stringify({
    name: "demo",
    programs: { main: "src/main.js", helper: "src/helper.js" },
  }),
  "src/main.js": "console.log('hi');",
  "src/helper.js": "console.log('helper');",
  "agent.materialize.mjs": NOOP_MATERIALIZE,
};

const TOOL_FILES: Record<string, string> = {
  "agent-package.json": JSON.stringify({
    name: "tool-a",
    programs: { do: "do.js" },
  }),
  "do.js": "console.log('do');",
  "agent.materialize.mjs": NOOP_MATERIALIZE,
};

const SKILL_FILES: Record<string, string> = {
  "beta/SKILL.md": "# beta",
  "alpha/SKILL.md": "# alpha",
};

/** 登记三族资产（包 + 工具 + skill 集合），返回 asset_id 组 */
function registerAssets(): {
  pkg: string;
  tool: string;
  skill: string;
} {
  const pkg = assets.register({
    kind: "package",
    url: makeRepo(PKG_FILES),
    ref: "HEAD",
    owner_id: "alice",
  }).asset_id;
  const tool = assets.register({
    kind: "tool",
    url: makeRepo(TOOL_FILES),
    ref: "HEAD",
    owner_id: "alice",
  }).asset_id;
  const skill = assets.register({
    kind: "skill",
    url: makeRepo(SKILL_FILES),
    ref: "HEAD",
    owner_id: "alice",
  }).asset_id;
  return { pkg, tool, skill };
}

/** 造一个绑定三族资产的业务 */
function createBusiness(
  ids: { pkg: string; tool: string; skill: string },
  over: Record<string, unknown> = {},
): string {
  return registry.create({
    business_name: "全绑定业务",
    creator_id: "user-1",
    source: "jira",
    event_type: "issue.created",
    prompt: "你是审查助手",
    model: "qwen/qwen3.8-max",
    package_asset_id: ids.pkg,
    entry_program: "main",
    tool_asset_ids: [ids.tool],
    skill_asset_ids: [ids.skill],
    timeout_minutes: 30,
    max_agent_calls: 5,
    ...over,
  });
}

describe("全链路组装", () => {
  it("绑定三族 + prompt + quota 覆盖 → RunContext 各字段正确", () => {
    const ids = registerAssets();
    const businessId = createBusiness(ids);
    env.set(null, "vars", "lang", "zh");
    env.set(null, "vars", "region", "global");
    env.set(businessId, "vars", "region", "cn");
    env.set(businessId, "secrets", "api_key", "sk-1");

    const channelId = `jira__sess-1__${businessId}`;
    const ctx = newLoader().load(businessId, channelId);

    expect(ctx.business_id).toBe(businessId);
    expect(ctx.channel_id).toBe(channelId);
    // program = 包清单 programs.main 名解析命中的绝对路径（存在于物化缓存）
    expect(ctx.program).toBe(join(assets.materialize(ids.pkg), "src/main.js"));
    expect(existsSync(ctx.program)).toBe(true);
    // skills = 绑定 skill 集合的技能并集（字典序），path 存在
    const skillRoot = assets.materialize(ids.skill);
    expect(ctx.skills).toEqual([
      { name: "alpha", path: join(skillRoot, "alpha") },
      { name: "beta", path: join(skillRoot, "beta") },
    ]);
    for (const s of ctx.skills) expect(existsSync(s.path)).toBe(true);
    // prompt / model / 两桶合并（业务优先）/ quota 覆盖值
    expect(ctx.prompt).toBe("你是审查助手");
    expect(ctx.model).toBe("qwen/qwen3.8-max");
    expect(ctx.vars).toEqual({ lang: "zh", region: "cn" });
    expect(ctx.secrets).toEqual({ api_key: "sk-1" });
    expect(ctx.quota).toEqual({ timeout_minutes: 30, max_agent_calls: 5 });
    // programs = 本包 ∪ 绑定工具的全量映射（名→物化绝对路径）
    const pkgRoot = assets.materialize(ids.pkg);
    const toolRoot = assets.materialize(ids.tool);
    expect(ctx.programs).toEqual({
      main: join(pkgRoot, "src/main.js"),
      helper: join(pkgRoot, "src/helper.js"),
      do: join(toolRoot, "do.js"),
    });
    for (const p of Object.values(ctx.programs)) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it("同名程序名按数组顺序首个命中（包在前、工具随后）", () => {
    const pkg = assets.register({
      kind: "package",
      url: makeRepo(PKG_FILES),
      ref: "HEAD",
      owner_id: "alice",
    }).asset_id;
    // 工具声明与包同名的 main 程序：首个命中 = 包
    const tool = assets.register({
      kind: "tool",
      url: makeRepo({
        "agent-package.json": JSON.stringify({
          name: "tool-clash",
          programs: { main: "main.js" },
        }),
        "main.js": "console.log('tool main');",
        "agent.materialize.mjs": NOOP_MATERIALIZE,
      }),
      ref: "HEAD",
      owner_id: "alice",
    }).asset_id;
    const businessId = registry.create({
      business_name: "同名程序业务",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      package_asset_id: pkg,
      entry_program: "main",
      tool_asset_ids: [tool],
    });
    const ctx = newLoader().load(businessId, `jira__s__${businessId}`);
    expect(ctx.programs.main).toBe(
      join(assets.materialize(pkg), "src/main.js"),
    );
  });

  it("quota 缺省 → 取 defaults", () => {
    const ids = registerAssets();
    const businessId = createBusiness(ids, {
      timeout_minutes: undefined,
      max_agent_calls: undefined,
    });
    const ctx = newLoader().load(businessId, `jira__s__${businessId}`);
    expect(ctx.quota).toEqual({ timeout_minutes: 60, max_agent_calls: 10 });
  });
});

describe("私有资产凭据", () => {
  const SECRET = "SECRET_TOKEN_xyz";

  function registerPrivatePackage(owner: string): string {
    return assets.register(
      {
        kind: "package",
        url: makeRepo(PKG_FILES),
        ref: "HEAD",
        owner_id: owner,
        is_private: true,
        credential_key: "git-token",
      },
      { credential: SECRET },
    ).asset_id;
  }

  it("secrets 里有同名 key → load 成功（本地 git 路径模拟）", () => {
    const pkg = registerPrivatePackage("carol");
    const businessId = registry.create({
      business_name: "私有资产业务",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      package_asset_id: pkg,
      entry_program: "main",
    });
    env.set(businessId, "secrets", "git-token", SECRET);
    const ctx = newLoader().load(businessId, `jira__s__${businessId}`);
    expect(existsSync(ctx.program)).toBe(true);
  });

  it("vars 兜底（secrets 无、vars 有同名 key）→ load 成功", () => {
    const pkg = registerPrivatePackage("dave");
    const businessId = registry.create({
      business_name: "私有资产业务2",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      package_asset_id: pkg,
      entry_program: "main",
    });
    env.set(businessId, "vars", "git-token", SECRET);
    const ctx = newLoader().load(businessId, `jira__s__${businessId}`);
    expect(existsSync(ctx.program)).toBe(true);
  });

  it("secrets/vars 都没有同名 key → 抛 credential_required", () => {
    const pkg = registerPrivatePackage("erin");
    const businessId = registry.create({
      business_name: "私有资产业务3",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      package_asset_id: pkg,
      entry_program: "main",
    });
    expect(() =>
      newLoader().load(businessId, `jira__s__${businessId}`),
    ).toThrow(/^credential_required: git-token$/);
  });
});

describe("错误路径", () => {
  it("业务不存在 → business_not_found", () => {
    expect(() => newLoader().load("b_nope", "jira__s__b_nope")).toThrow(
      /^business_not_found: b_nope$/,
    );
  });

  it("未绑定包 → invalid_business: 未绑定包", () => {
    const businessId = registry.create({
      business_name: "无包业务",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    expect(() => newLoader().load(businessId, "jira__s__x")).toThrow(
      /^invalid_business: 未绑定包$/,
    );
  });

  it("未指定 entry_program → invalid_business: 未指定入口程序", () => {
    const ids = registerAssets();
    const businessId = createBusiness(ids, { entry_program: undefined });
    expect(() => newLoader().load(businessId, "jira__s__x")).toThrow(
      /^invalid_business: 未指定入口程序$/,
    );
  });

  it("entry_program 名解析不到 → resource_not_found 原样上抛", () => {
    const ids = registerAssets();
    const businessId = createBusiness(ids, { entry_program: "nope" });
    expect(() => newLoader().load(businessId, "jira__s__x")).toThrow(
      /^resource_not_found: program nope$/,
    );
  });
});
