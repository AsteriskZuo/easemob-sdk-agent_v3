import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLogger, resetForTests } from "@asterisk/agent-logger";
import { JiraPollingEntryAdapter } from "../src/jira-polling.js";
import { ENTRY_ADAPTERS } from "../src/index.js";
import type { EntryDeps } from "../src/types.js";
import { FakeEnv, FakeQueue, FakeRegistry } from "./fakes.js";

let tmpDir: string;
let fakeQueue: FakeQueue;
let fakeRegistry: FakeRegistry;
let fakeEnv: FakeEnv;
let deps: EntryDeps;
let adapter: JiraPollingEntryAdapter;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-entry-adapters-jira-test-"));
  initLogger({ logsDir: tmpDir });
});

afterAll(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fakeQueue = new FakeQueue();
  fakeRegistry = new FakeRegistry();
  fakeEnv = new FakeEnv();
  deps = {
    queue: fakeQueue.queue,
    registry: fakeRegistry.registry,
    env: fakeEnv.env,
  };
  adapter = new JiraPollingEntryAdapter();
  // start 即对账一次 + 起周期对账（10s 间隔、unref，测试期间不会真触发）
  adapter.start(deps);
});

afterEach(async () => {
  await adapter.stop();
  await adapter.stop(); // 幂等：二次调用不报错
});

/** 加一条 source='jira' 的 match 行，返回 business_id */
function addJiraRow(
  eventType: string,
  entryConfig: Record<string, unknown>,
  businessId?: string,
): string {
  const id = businessId ?? fakeRegistry.createBusiness();
  fakeRegistry.registry.addMatch(id, "jira", eventType, entryConfig);
  return id;
}

describe("jira-polling 适配器：轮询器随 match 行增删", () => {
  it("初始无行 → 无轮询器；加行 → syncTick 后出现对应轮询器", () => {
    expect(adapter.pollerKeys()).toEqual([]);

    const bid = addJiraRow("jira.issue.updated", {
      jira_url: "http://jira.local",
      username_key: "u",
      password_key: "p",
      project: "PRJ",
    });

    // 周期对账未到时手动触发（等效于 10s tick）
    adapter.syncTick();
    expect(adapter.pollerKeys()).toEqual([`${bid}::jira.issue.updated`]);
  });

  it("删行 → 轮询器移除；删业务 → 其全部轮询器移除", () => {
    const bid = addJiraRow("jira.issue.updated", { project: "PRJ" });
    adapter.syncTick();
    expect(adapter.pollerKeys()).toHaveLength(1);

    fakeRegistry.registry.removeMatch(bid, "jira", "jira.issue.updated");
    adapter.syncTick();
    expect(adapter.pollerKeys()).toEqual([]);

    // 整业务删除
    const bid2 = addJiraRow("jira.issue.updated", { project: "PRJ" });
    addJiraRow("jira.comment.created", { project: "PRJ" }, bid2);
    adapter.syncTick();
    expect(adapter.pollerKeys()).toHaveLength(2);
    fakeRegistry.registry.remove(bid2);
    adapter.syncTick();
    expect(adapter.pollerKeys()).toEqual([]);
  });

  it("同一业务多条 jira 行 → 各一个独立轮询器；配置变化 → 重建（轮询器仍存在）", () => {
    const bid = addJiraRow("jira.issue.updated", {
      jira_url: "http://jira.local",
      username_key: "u",
      password_key: "p",
      project: "PRJ",
      interval_seconds: 30,
    });
    addJiraRow(
      "jira.comment.created",
      {
        jira_url: "http://jira.local",
        username_key: "u",
        password_key: "p",
        project: "PRJ",
      },
      bid,
    );
    adapter.syncTick();
    expect(adapter.pollerKeys()).toEqual([
      `${bid}::jira.comment.created`,
      `${bid}::jira.issue.updated`,
    ]);

    // 配置变化（换 project）：removeMatch + addMatch（registry 行配置不可原地改）
    fakeRegistry.registry.removeMatch(bid, "jira", "jira.issue.updated");
    fakeRegistry.registry.addMatch(bid, "jira", "jira.issue.updated", {
      jira_url: "http://jira.local",
      username_key: "u",
      password_key: "p",
      project: "OTHER",
      interval_seconds: 120,
    });
    adapter.syncTick();
    expect(adapter.pollerKeys()).toEqual([
      `${bid}::jira.comment.created`,
      `${bid}::jira.issue.updated`,
    ]);
  });

  it("行配置非法（缺必填）不建轮询器失败——轮询器照常建、run 内自闭环跳过", async () => {
    // 非法行也建轮询器（防重入/日志自闭环），不影响其他行；此处验证不影响对账
    addJiraRow("jira.issue.updated", { project: "PRJ" }); // 缺 jira_url 等
    adapter.syncTick();
    expect(adapter.pollerKeys()).toHaveLength(1);
    // 无凭据无网络：立刻触发的那轮 run 记 warn 跳过，队列无事件
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeQueue.tasks).toHaveLength(0);
  });
});

describe("ENTRY_ADAPTERS 内置清单", () => {
  it("含 webhook 与 jira-polling 两个工厂，spec 形状完整", () => {
    expect(ENTRY_ADAPTERS).toHaveLength(2);
    const webhook = ENTRY_ADAPTERS.find((f) => f.spec.id === "webhook");
    const jira = ENTRY_ADAPTERS.find((f) => f.spec.id === "jira-polling");
    expect(webhook?.spec.kind).toBe("webhook");
    expect(webhook?.spec.defaultEnabled).toBe(true);
    expect(jira?.spec.kind).toBe("jira");
    expect(jira?.spec.defaultEnabled).toBe(false);
    for (const factory of ENTRY_ADAPTERS) {
      expect(factory.spec.name.length).toBeGreaterThan(0);
      expect(factory.spec.configSchema.length).toBeGreaterThan(0);
      expect(factory.spec.eventDoc.length).toBeGreaterThan(0);
    }
  });
});
