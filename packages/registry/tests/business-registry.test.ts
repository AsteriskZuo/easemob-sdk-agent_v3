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
