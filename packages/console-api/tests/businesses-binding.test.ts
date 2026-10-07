import { jest } from "@jest/globals";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AssetMeta, BusinessProfile } from "../src/index.js";
import {
  api,
  createMemberAndLogin,
  loginToken,
  makeRepo,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(60000);

let server: TestServer;
let adminToken: string;
let alice: { user_id: string; token: string };
let bob: { user_id: string; token: string };

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  alice = await createMemberAndLogin(server, adminToken, "alice");
  bob = await createMemberAndLogin(server, adminToken, "bob");
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

/** 包清单：2 个 programs + requires（tool 名 do、skill 名 alpha） */
function pkgFiles(): Record<string, string> {
  return {
    "agent-package.json": JSON.stringify({
      name: "biz-pkg",
      programs: { main: "src/main.js", helper: "src/helper.js" },
      requires: { tools: ["do"], skills: ["alpha"] },
    }),
    "src/main.js": "console.log('main');",
    "src/helper.js": "console.log('helper');",
  };
}

function toolFiles(programs: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = {
    "agent-package.json": JSON.stringify({ name: "tool", programs }),
  };
  for (const rel of Object.values(programs)) files[rel] = "console.log(1);";
  return files;
}

function skillFiles(skills: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of skills) files[`${name}/SKILL.md`] = `# ${name}`;
  return files;
}

/** 经 API 登记资产，返回 asset_id */
async function register(
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await api(server, "POST", "/api/assets", { token, body });
  expect(res.status).toBe(201);
  return (res.body as AssetMeta).asset_id;
}

/** alice 的一套合法资产：包（requires do/alpha）+ 工具 do + skill alpha */
async function registerValidSet(): Promise<{
  pkg: string;
  tool: string;
  skill: string;
}> {
  const pkg = await register(alice.token, {
    kind: "package",
    url: makeRepo(server.tmpDir, pkgFiles()),
    ref: "HEAD",
  });
  const tool = await register(alice.token, {
    kind: "tool",
    url: makeRepo(server.tmpDir, toolFiles({ do: "do.js" })),
    ref: "HEAD",
  });
  const skill = await register(alice.token, {
    kind: "skill",
    url: makeRepo(server.tmpDir, skillFiles(["alpha"])),
    ref: "HEAD",
  });
  return { pkg, tool, skill };
}

function errMessage(res: { body: unknown }): string {
  return (res.body as { error: { message: string } }).error.message;
}

describe("业务绑定配置期校验", () => {
  it("全部合法 → 201 且物化发生（配置期 fail-fast 顺带落实初始化物化）", async () => {
    const ids = await registerValidSet();
    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "合法绑定",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: ids.pkg,
        entry_program: "main",
        tool_asset_ids: [ids.tool],
        skill_asset_ids: [ids.skill],
        model: "test/model-a",
        agent_kind: "pi",
      },
    });
    expect(res.status).toBe(201);
    // 校验期的 assets.get 已物化全部绑定资产（.materialized-ok 标记就位）
    for (const id of Object.values(ids)) {
      expect(
        existsSync(
          join(server.tmpDir, "cache", "assets", id, ".materialized-ok"),
        ),
      ).toBe(true);
    }
  });

  it("资产不存在 → 400 列出问题", async () => {
    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "不存在",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: "ast_0000000000000000",
        entry_program: "main",
      },
    });
    expect(res.status).toBe(400);
    expect(errMessage(res)).toContain("资产不存在: ast_0000000000000000");
  });

  it("绑定权限：他人包/他人非共享工具 → 400；admin 也不例外；共享工具可跨属主", async () => {
    const bobPkg = await register(bob.token, {
      kind: "package",
      url: makeRepo(server.tmpDir, pkgFiles()),
      ref: "HEAD",
    });
    const bobPrivateTool = await register(bob.token, {
      kind: "tool",
      url: makeRepo(server.tmpDir, toolFiles({ do: "do.js" })),
      ref: "HEAD",
    });
    const bobSharedTool = await register(bob.token, {
      kind: "tool",
      url: makeRepo(server.tmpDir, toolFiles({ do: "do.js" })),
      ref: "HEAD",
      shared: true,
    });

    const base = {
      business_name: "权限",
      source: "jira",
      event_type: "issue.created",
    };
    // 他人的包（包不共享）
    const byAlicePkg = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: { ...base, package_asset_id: bobPkg, entry_program: "main" },
    });
    expect(byAlicePkg.status).toBe(400);
    expect(errMessage(byAlicePkg)).toContain("无权限绑定包资产");
    // 他人的非共享工具（带上自己的包使 requires.tools 覆盖，隔离权限问题）
    const aliceSet = await registerValidSet();
    const byAliceTool = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        ...base,
        package_asset_id: aliceSet.pkg,
        entry_program: "main",
        tool_asset_ids: [bobPrivateTool],
        skill_asset_ids: [aliceSet.skill],
      },
    });
    expect(byAliceTool.status).toBe(400);
    expect(errMessage(byAliceTool)).toContain("无权限绑定资产");
    // admin 也不例外（admin 对资产只读，不替成员持有绑定）
    const byAdmin = await api(server, "POST", "/api/businesses", {
      token: adminToken,
      body: { ...base, package_asset_id: bobPkg, entry_program: "main" },
    });
    expect(byAdmin.status).toBe(400);
    expect(errMessage(byAdmin)).toContain("无权限绑定包资产");
    // 他人的共享工具 → 可绑
    const shared = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        ...base,
        package_asset_id: aliceSet.pkg,
        entry_program: "main",
        tool_asset_ids: [bobSharedTool],
        skill_asset_ids: [aliceSet.skill],
      },
    });
    expect(shared.status).toBe(201);
  });

  it("entry_program 不是包清单 programs 的键 → 400", async () => {
    const ids = await registerValidSet();
    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "入口非法",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: ids.pkg,
        entry_program: "nope",
        tool_asset_ids: [ids.tool],
        skill_asset_ids: [ids.skill],
      },
    });
    expect(res.status).toBe(400);
    expect(errMessage(res)).toContain(
      "entry_program 不是包清单 programs 的键: nope",
    );
  });

  it("程序名查重：包与工具同名 program → 400 报冲突名", async () => {
    const ids = await registerValidSet();
    const clashTool = await register(alice.token, {
      kind: "tool",
      url: makeRepo(server.tmpDir, toolFiles({ main: "main.js", do: "do.js" })),
      ref: "HEAD",
    });
    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "程序名冲突",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: ids.pkg,
        entry_program: "main",
        tool_asset_ids: [clashTool],
        skill_asset_ids: [ids.skill],
      },
    });
    expect(res.status).toBe(400);
    expect(errMessage(res)).toContain("程序名冲突: main");
  });

  it("skill 名查重：两个 skill 集合含同名技能 → 400 报冲突名", async () => {
    const ids = await registerValidSet();
    const skillB = await register(alice.token, {
      kind: "skill",
      url: makeRepo(server.tmpDir, skillFiles(["alpha", "beta"])),
      ref: "HEAD",
    });
    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "skill 名冲突",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: ids.pkg,
        entry_program: "main",
        tool_asset_ids: [ids.tool],
        skill_asset_ids: [ids.skill, skillB],
      },
    });
    expect(res.status).toBe(400);
    expect(errMessage(res)).toContain("skill 名冲突: alpha");
  });

  it("requires 缺绑 → 400 报出全部缺绑名", async () => {
    const ids = await registerValidSet();
    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "缺绑",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: ids.pkg,
        entry_program: "main",
      },
    });
    expect(res.status).toBe(400);
    const message = errMessage(res);
    expect(message).toContain("requires.tools 缺绑: do");
    expect(message).toContain("requires.skills 缺绑: alpha");
  });

  it("model 非法 → 400 列出可选集合；agent_kind 非法 → 400", async () => {
    const badModel = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "模型非法",
        source: "jira",
        event_type: "issue.created",
        model: "evil/model",
      },
    });
    expect(badModel.status).toBe(400);
    const message = errMessage(badModel);
    expect(message).toContain("model 不在可选集合: evil/model");
    expect(message).toContain("test/model-a");

    const badAgent = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "内核非法",
        source: "jira",
        event_type: "issue.created",
        agent_kind: "claude",
      },
    });
    expect(badAgent.status).toBe(400);
    expect(errMessage(badAgent)).toContain("agent_kind 不在可选集合: claude");
  });

  it("patch 只改 prompt → 零校验零物化（绑定资产已下架也 204）；patch 触碰绑定字段 → 触发校验", async () => {
    const ids = await registerValidSet();
    const created = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "patch 触发面",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: ids.pkg,
        entry_program: "main",
        tool_asset_ids: [ids.tool],
        skill_asset_ids: [ids.skill],
      },
    });
    expect(created.status).toBe(201);
    const businessId = (created.body as BusinessProfile).business_id;

    // 下架全部绑定资产：若 patch 触发校验，取用必然 400
    for (const id of Object.values(ids)) server.assets.remove(id);

    const promptOnly = await api(
      server,
      "PATCH",
      `/api/businesses/${businessId}`,
      { token: alice.token, body: { prompt: "只改总纲" } },
    );
    expect(promptOnly.status).toBe(204);

    const touchBinding = await api(
      server,
      "PATCH",
      `/api/businesses/${businessId}`,
      { token: alice.token, body: { tool_asset_ids: [] } },
    );
    expect(touchBinding.status).toBe(400);
    expect(errMessage(touchBinding)).toContain("资产不存在");
  });

  it("私有资产凭据 key 未在通用安全桶登记 → 400 提示登记", async () => {
    // 先登记凭据完成资产登记，再删掉凭据（登记与绑定校验都从通用层安全桶取）
    await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "secrets", key: "bind-git-token", value: "SECRET" },
    });
    const privPkg = await register(alice.token, {
      kind: "package",
      url: makeRepo(server.tmpDir, pkgFiles()),
      ref: "HEAD",
      is_private: true,
      credential_key: "bind-git-token",
    });
    await api(server, "DELETE", "/api/env/global", {
      token: adminToken,
      body: { bucket: "secrets", key: "bind-git-token" },
    });

    const res = await api(server, "POST", "/api/businesses", {
      token: alice.token,
      body: {
        business_name: "凭据缺失",
        source: "jira",
        event_type: "issue.created",
        package_asset_id: privPkg,
        entry_program: "main",
      },
    });
    expect(res.status).toBe(400);
    expect(errMessage(res)).toContain(
      "凭据 key 未在通用配置安全桶登记: bind-git-token",
    );
  });
});
