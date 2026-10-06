import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@easemob/agent-database";
import { createBusinessRegistry } from "../src/index.js";
import type { BusinessRegistry } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-registry-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newRegistry(): { registry: BusinessRegistry; close: () => void } {
  const db = openDatabase(":memory:");
  return { registry: createBusinessRegistry(db), close: () => db.close() };
}

describe("create / get", () => {
  it("create → get 返回一行，字段一致；business_id 以 b 开头", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "审查工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      on_failure: true,
    });
    expect(id.startsWith("b")).toBe(true);
    expect(registry.get(id)).toEqual([
      {
        business_id: id,
        business_name: "审查工单",
        creator_id: "user-1",
        source: "jira",
        event_type: "issue.created",
        on_failure: true,
      },
    ]);
    close();
  });

  it("get 不存在的业务返回空数组", () => {
    const { registry, close } = newRegistry();
    expect(registry.get("b_nonexistent")).toEqual([]);
    close();
  });
});

describe("match 订阅匹配", () => {
  it("addMatch 第二行 → get 返回两行；match 对两个组合各自命中", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "多入口业务",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    registry.addMatch(id, "wecom", "message.receive");

    const rows = registry.get(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.source}/${r.event_type}`).sort()).toEqual([
      "jira/issue.created",
      "wecom/message.receive",
    ]);

    const hitA = registry.match("jira", "issue.created");
    expect(hitA).toHaveLength(1);
    expect(hitA[0].business_id).toBe(id);
    const hitB = registry.match("wecom", "message.receive");
    expect(hitB).toHaveLength(1);
    expect(hitB[0].business_id).toBe(id);
    close();
  });

  it("match 无关注者 → 空数组（不抛错）", () => {
    const { registry, close } = newRegistry();
    expect(registry.match("github", "push")).toEqual([]);
    close();
  });

  it("同 (source, event_type) 多业务 → match 全部返回", () => {
    const { registry, close } = newRegistry();
    const idA = registry.create({
      business_name: "业务A",
      creator_id: "user-1",
      source: "webhook",
      event_type: "alert",
    });
    const idB = registry.create({
      business_name: "业务B",
      creator_id: "user-2",
      source: "webhook",
      event_type: "alert",
    });
    const hits = registry.match("webhook", "alert");
    expect(hits.map((h) => h.business_id).sort()).toEqual([idA, idB].sort());
    close();
  });
});

describe("exit_bindings", () => {
  it("create 时写入 → exitBindings 读回一致", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.done",
      exit_bindings: [{ tool: "wecom-bot", config: { webhook: "https://x" } }],
    });
    expect(registry.exitBindings(id)).toEqual([
      {
        business_id: id,
        tool: "wecom-bot",
        config: { webhook: "https://x" },
      },
    ]);
    close();
  });

  it("一个业务绑定多个出口工具 → exitBindings 返回全部、顺序保持", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.done",
      exit_bindings: [
        { tool: "wecom-bot", config: { webhook: "https://a" } },
        { tool: "email", config: { to: "ops@example.com" } },
        { tool: "jira-comment", config: { project: "OPS" } },
      ],
    });
    expect(registry.exitBindings(id)).toEqual([
      { business_id: id, tool: "wecom-bot", config: { webhook: "https://a" } },
      {
        business_id: id,
        tool: "email",
        config: { to: "ops@example.com" },
      },
      { business_id: id, tool: "jira-comment", config: { project: "OPS" } },
    ]);
    close();
  });

  it("无绑定业务 → 空数组；不存在的业务 → 空数组", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "无出口",
      creator_id: "user-1",
      source: "cron",
      event_type: "tick",
    });
    expect(registry.exitBindings(id)).toEqual([]);
    expect(registry.exitBindings("b_nonexistent")).toEqual([]);
    close();
  });

  it("update 全量替换 exit_bindings 生效", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.done",
      exit_bindings: [{ tool: "wecom-bot", config: { webhook: "https://a" } }],
    });
    registry.update(id, {
      exit_bindings: [
        { business_id: id, tool: "email", config: { to: "a@b.c" } },
      ],
    });
    expect(registry.exitBindings(id)).toEqual([
      { business_id: id, tool: "email", config: { to: "a@b.c" } },
    ]);
    close();
  });
});

describe("update", () => {
  it("改 business_name/on_failure → get 的所有行都反映新值", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "旧名",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    registry.addMatch(id, "wecom", "message.receive");
    registry.update(id, { business_name: "新名", on_failure: true });

    const rows = registry.get(id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.business_name).toBe("新名");
      expect(row.on_failure).toBe(true);
      expect(row.creator_id).toBe("user-1");
    }
    expect(registry.match("jira", "issue.created")[0].business_name).toBe(
      "新名",
    );
    expect(registry.match("wecom", "message.receive")[0].on_failure).toBe(true);
    close();
  });

  it("update 不存在的 business_id → 抛错", () => {
    const { registry, close } = newRegistry();
    expect(() =>
      registry.update("b_nonexistent", { business_name: "x" }),
    ).toThrow();
    close();
  });
});

describe("addMatch / removeMatch", () => {
  it("addMatch 重复 → 幂等（get 行数不增）", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    registry.addMatch(id, "jira", "issue.created");
    registry.addMatch(id, "jira", "issue.created");
    expect(registry.get(id)).toHaveLength(1);
    expect(registry.match("jira", "issue.created")).toHaveLength(1);
    close();
  });

  it("removeMatch → match 不再命中；重复 removeMatch 不抛错", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    registry.addMatch(id, "wecom", "message.receive");
    registry.removeMatch(id, "jira", "issue.created");

    expect(registry.match("jira", "issue.created")).toEqual([]);
    expect(registry.match("wecom", "message.receive")).toHaveLength(1);
    expect(registry.get(id)).toHaveLength(1);

    registry.removeMatch(id, "jira", "issue.created");
    expect(registry.get(id)).toHaveLength(1);
    close();
  });
});

describe("remove", () => {
  it("remove → get/match/exitBindings 全部为空", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "工单",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      exit_bindings: [{ tool: "wecom-bot", config: { webhook: "https://a" } }],
    });
    registry.remove(id);
    expect(registry.get(id)).toEqual([]);
    expect(registry.match("jira", "issue.created")).toEqual([]);
    expect(registry.exitBindings(id)).toEqual([]);
    close();
  });

  it("remove 不存在业务 → 不抛错", () => {
    const { registry, close } = newRegistry();
    expect(() => registry.remove("b_nonexistent")).not.toThrow();
    close();
  });
});

describe("持久化", () => {
  it("写入后 close 重开 → 新实例 match/get/exitBindings 结果一致", () => {
    const dbPath = join(tmpDir, "registry.db");

    const db1 = openDatabase(dbPath);
    const r1 = createBusinessRegistry(db1);
    const id = r1.create({
      business_name: "持久业务",
      creator_id: "user-9",
      source: "jira",
      event_type: "issue.created",
      on_failure: true,
      exit_bindings: [
        { tool: "wecom-bot", config: { webhook: "https://a" } },
        { tool: "email", config: { to: "ops@example.com" } },
      ],
    });
    r1.addMatch(id, "webhook", "alert");
    db1.close();

    const db2 = openDatabase(dbPath);
    const r2 = createBusinessRegistry(db2);
    expect(r2.get(id)).toEqual([
      {
        business_id: id,
        business_name: "持久业务",
        creator_id: "user-9",
        source: "jira",
        event_type: "issue.created",
        on_failure: true,
      },
      {
        business_id: id,
        business_name: "持久业务",
        creator_id: "user-9",
        source: "webhook",
        event_type: "alert",
        on_failure: true,
      },
    ]);
    expect(r2.match("jira", "issue.created")).toHaveLength(1);
    expect(r2.match("webhook", "alert")).toHaveLength(1);
    expect(r2.exitBindings(id)).toEqual([
      { business_id: id, tool: "wecom-bot", config: { webhook: "https://a" } },
      {
        business_id: id,
        tool: "email",
        config: { to: "ops@example.com" },
      },
    ]);
    db2.close();
  });
});

describe("迁移 v2：v1 老库升级", () => {
  it("先以 v1 建库写数据，migrate 后老数据在、新列取缺省", () => {
    const dbPath = join(tmpDir, "old-v1.db");
    const db1 = openDatabase(dbPath);
    // 手工落 v1 schema + 迁移登记（模拟老库）
    db1.exec(`CREATE TABLE businesses (
      business_id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      on_failure INTEGER NOT NULL DEFAULT 0,
      exit_bindings TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE business_matches (
      business_id TEXT NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      UNIQUE (business_id, source, event_type)
    );
    CREATE TABLE schema_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    );`);
    db1.run(
      "INSERT INTO schema_migrations (module, version, applied_at) VALUES ('registry', 1, ?)",
      [new Date().toISOString()],
    );
    db1.run(
      "INSERT INTO businesses (business_id, business_name, creator_id, on_failure, exit_bindings) VALUES ('b_old', '老业务', 'user-1', 1, '[]')",
    );
    db1.run(
      "INSERT INTO business_matches (business_id, source, event_type) VALUES ('b_old', 'jira', 'issue.created')",
    );
    db1.close();

    const db2 = openDatabase(dbPath);
    const r2 = createBusinessRegistry(db2);
    expect(r2.get("b_old")).toEqual([
      {
        business_id: "b_old",
        business_name: "老业务",
        creator_id: "user-1",
        source: "jira",
        event_type: "issue.created",
        on_failure: true,
      },
    ]);
    const profile = r2.getProfile("b_old");
    expect(profile).toBeDefined();
    expect(profile?.prompt).toBe("");
    expect(profile?.model).toBe("qwen3.8max");
    expect(profile?.agent_kind).toBe("pi");
    expect(profile?.package_asset_id).toBeUndefined();
    expect(profile?.entry_program).toBeUndefined();
    expect(profile?.tool_asset_ids).toEqual([]);
    expect(profile?.skill_asset_ids).toEqual([]);
    expect(profile?.timeout_minutes).toBeUndefined();
    expect(profile?.max_agent_calls).toBeUndefined();
    db2.close();
  });
});

describe("getProfile 业务资料", () => {
  it("缺省 create → getProfile 各字段为缺省值", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "裸业务",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    expect(registry.getProfile(id)).toEqual({
      business_id: id,
      business_name: "裸业务",
      creator_id: "user-1",
      on_failure: false,
      prompt: "",
      model: "qwen3.8max",
      agent_kind: "pi",
      tool_asset_ids: [],
      skill_asset_ids: [],
    });
    close();
  });

  it("create 带资料字段 → getProfile 读回一致", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "全配置业务",
      creator_id: "user-1",
      source: "webhook",
      event_type: "alert",
      prompt: "你是审查助手",
      model: "qwen3.8max",
      agent_kind: "pi",
      package_asset_id: "ast_pkg1",
      entry_program: "main",
      tool_asset_ids: ["ast_t1", "ast_t2"],
      skill_asset_ids: ["ast_s1"],
      timeout_minutes: 30,
      max_agent_calls: 5,
    });
    expect(registry.getProfile(id)).toEqual({
      business_id: id,
      business_name: "全配置业务",
      creator_id: "user-1",
      on_failure: false,
      prompt: "你是审查助手",
      model: "qwen3.8max",
      agent_kind: "pi",
      package_asset_id: "ast_pkg1",
      entry_program: "main",
      tool_asset_ids: ["ast_t1", "ast_t2"],
      skill_asset_ids: ["ast_s1"],
      timeout_minutes: 30,
      max_agent_calls: 5,
    });
    close();
  });

  it("getProfile 不存在业务 → undefined", () => {
    const { registry, close } = newRegistry();
    expect(registry.getProfile("b_nonexistent")).toBeUndefined();
    close();
  });

  it("update 资料字段 → getProfile 反映；timeout_minutes: null → 覆盖清除", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "待更新",
      creator_id: "user-1",
      source: "cron",
      event_type: "tick",
    });
    registry.update(id, {
      prompt: "新总纲",
      model: "qwen3.8max",
      package_asset_id: "ast_pkg9",
      entry_program: "review",
      tool_asset_ids: ["ast_t9"],
      skill_asset_ids: ["ast_s8", "ast_s9"],
      timeout_minutes: 45,
      max_agent_calls: 7,
    });
    let profile = registry.getProfile(id);
    expect(profile?.prompt).toBe("新总纲");
    expect(profile?.package_asset_id).toBe("ast_pkg9");
    expect(profile?.entry_program).toBe("review");
    expect(profile?.tool_asset_ids).toEqual(["ast_t9"]);
    expect(profile?.skill_asset_ids).toEqual(["ast_s8", "ast_s9"]);
    expect(profile?.timeout_minutes).toBe(45);
    expect(profile?.max_agent_calls).toBe(7);

    registry.update(id, { timeout_minutes: null });
    profile = registry.getProfile(id);
    expect(profile?.timeout_minutes).toBeUndefined();
    expect(profile?.max_agent_calls).toBe(7); // 未触碰字段保持
    close();
  });

  it("update 资料字段持久化：close 重开后 getProfile 一致", () => {
    const dbPath = join(tmpDir, "profile.db");
    const db1 = openDatabase(dbPath);
    const r1 = createBusinessRegistry(db1);
    const id = r1.create({
      business_name: "持久资料",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      prompt: "总纲",
      package_asset_id: "ast_pkg1",
      entry_program: "main",
      tool_asset_ids: ["ast_t1"],
      timeout_minutes: 20,
    });
    db1.close();

    const db2 = openDatabase(dbPath);
    const r2 = createBusinessRegistry(db2);
    expect(r2.getProfile(id)).toEqual({
      business_id: id,
      business_name: "持久资料",
      creator_id: "user-1",
      on_failure: false,
      prompt: "总纲",
      model: "qwen3.8max",
      agent_kind: "pi",
      package_asset_id: "ast_pkg1",
      entry_program: "main",
      tool_asset_ids: ["ast_t1"],
      skill_asset_ids: [],
      timeout_minutes: 20,
    });
    db2.close();
  });
});

describe("list 业务列表", () => {
  it("空表 → 空数组", () => {
    const { registry, close } = newRegistry();
    expect(registry.list()).toEqual([]);
    close();
  });

  it("多业务 → 全部 profile，按 business_id 字典序", () => {
    const { registry, close } = newRegistry();
    const idA = registry.create({
      business_name: "业务A",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
      prompt: "总纲A",
    });
    const idB = registry.create({
      business_name: "业务B",
      creator_id: "user-2",
      source: "webhook",
      event_type: "alert",
      timeout_minutes: 30,
    });
    const profiles = registry.list();
    expect(profiles.map((p) => p.business_id)).toEqual([idA, idB].sort());
    const byId = new Map(profiles.map((p) => [p.business_id, p]));
    expect(byId.get(idA)).toEqual(registry.getProfile(idA));
    expect(byId.get(idB)).toEqual(registry.getProfile(idB));
    close();
  });

  it("创建/删除后列表随之反映", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "临时业务",
      creator_id: "user-1",
      source: "cron",
      event_type: "tick",
    });
    expect(registry.list()).toHaveLength(1);
    registry.remove(id);
    expect(registry.list()).toEqual([]);
    close();
  });
});

describe("addMatch entry_config", () => {
  it("带 entry_config → get/match 读出对象；不带 → undefined", () => {
    const { registry, close } = newRegistry();
    const id = registry.create({
      business_name: "多入口",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    const config = { filter: { level: "p1" }, session_rule: "by-issue" };
    registry.addMatch(id, "webhook", "alert", config);

    const rows = registry.get(id);
    expect(rows).toHaveLength(2);
    const jiraRow = rows.find((r) => r.source === "jira");
    const webhookRow = rows.find((r) => r.source === "webhook");
    expect(jiraRow?.entry_config).toBeUndefined();
    expect(webhookRow?.entry_config).toEqual(config);

    expect(registry.match("webhook", "alert")[0].entry_config).toEqual(config);
    expect(
      registry.match("jira", "issue.created")[0].entry_config,
    ).toBeUndefined();
    close();
  });

  it("entry_config 持久化：close 重开后读出一致", () => {
    const dbPath = join(tmpDir, "entry-config.db");
    const db1 = openDatabase(dbPath);
    const r1 = createBusinessRegistry(db1);
    const id = r1.create({
      business_name: "入口配置业务",
      creator_id: "user-1",
      source: "jira",
      event_type: "issue.created",
    });
    r1.addMatch(id, "webhook", "alert", { token_hint: "h1" });
    db1.close();

    const db2 = openDatabase(dbPath);
    const r2 = createBusinessRegistry(db2);
    const webhookRow = r2.get(id).find((r) => r.source === "webhook");
    expect(webhookRow?.entry_config).toEqual({ token_hint: "h1" });
    db2.close();
  });
});
