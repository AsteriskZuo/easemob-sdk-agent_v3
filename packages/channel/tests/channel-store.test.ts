import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import { createChannelPool, createChannelStore } from "../src/index.js";
import type { ChannelStore } from "../src/index.js";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: ChannelStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-channel-store-test-"));
  dbPath = join(tmpDir, "channel.db");
  db = openDatabase(dbPath);
  store = createChannelStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bind / getAgentSession / clear", () => {
  it("bind 后 getAgentSession 命中", () => {
    store.bindAgentSession("src__sess__biz", "agent_sess_1");
    expect(store.getAgentSession("src__sess__biz")).toBe("agent_sess_1");
  });

  it("rebind 覆盖旧映射", () => {
    store.bindAgentSession("src__sess__biz", "agent_sess_1");
    store.bindAgentSession("src__sess__biz", "agent_sess_2");
    expect(store.getAgentSession("src__sess__biz")).toBe("agent_sess_2");
  });

  it("clear 后未命中", () => {
    store.bindAgentSession("src__sess__biz", "agent_sess_1");
    store.clear("src__sess__biz");
    expect(store.getAgentSession("src__sess__biz")).toBeUndefined();
  });

  it("未命中返回 undefined", () => {
    expect(store.getAgentSession("src__sess__never_bound")).toBeUndefined();
  });

  it("clear 不存在的键幂等（不抛错）", () => {
    expect(() => store.clear("src__sess__never_bound")).not.toThrow();
  });
});

describe("exit 通道防护", () => {
  it("exit__ 前缀的键三个方法都抛错", () => {
    expect(() => store.bindAgentSession("exit__webhook", "s")).toThrow(
      /出口通道/,
    );
    expect(() => store.getAgentSession("exit__webhook")).toThrow(/出口通道/);
    expect(() => store.clear("exit__webhook")).toThrow(/出口通道/);
  });
});

describe("持久化", () => {
  it("bind 后 close 重开，映射仍在", () => {
    store.bindAgentSession("src__sess__biz", "agent_sess_1");
    db.close();

    db = openDatabase(dbPath);
    store = createChannelStore(db); // 重跑迁移不报错

    expect(store.getAgentSession("src__sess__biz")).toBe("agent_sess_1");
  });
});

describe("与 ChannelPool 共存", () => {
  it("同库创建 pool 与 store，迁移幂等、互不干扰", () => {
    const pool = createChannelPool(db);
    pool.get("src__sess__biz");
    store.bindAgentSession("src__sess__biz", "agent_sess_1");

    expect(store.getAgentSession("src__sess__biz")).toBe("agent_sess_1");
    const row = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM channels WHERE channel_id = ?",
      ["src__sess__biz"],
    );
    expect(row?.n).toBe(1);
  });
});
