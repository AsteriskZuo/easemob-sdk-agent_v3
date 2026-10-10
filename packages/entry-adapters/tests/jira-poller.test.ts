import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import type {
  JiraClientConfig,
  JiraIssueLite,
  JiraResult,
} from "@asteriskzuo/agent-jira-client";
import { createJiraPoller, parseJiraEntryConfig } from "../src/jira-poller.js";
import type { JiraPoller, JiraSearchClient } from "../src/jira-poller.js";
import { FakeEnv, FakeQueue } from "./fakes.js";

let tmpDir: string;
let fakeQueue: FakeQueue;
let fakeEnv: FakeEnv;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-entry-adapters-poller-test-"));
  initLogger({ logsDir: tmpDir });
});

afterAll(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fakeQueue = new FakeQueue();
  fakeEnv = new FakeEnv();
});

const VALID_CONFIG: Record<string, unknown> = {
  jira_url: "http://jira.local",
  username: "{{jira_user}}",
  password: "{{jira_pass}}",
  project: "PRJ",
};

function makePoller(overrides?: {
  businessId?: string;
  entryConfig?: Record<string, unknown>;
  client?: JiraSearchClient;
  clientFactory?: (config: JiraClientConfig) => JiraSearchClient;
  withSecrets?: boolean;
}): JiraPoller {
  const businessId = overrides?.businessId ?? "b1";
  if (overrides?.withSecrets !== false) {
    fakeEnv.setSecret(businessId, "jira_user", "bot");
    fakeEnv.setSecret(businessId, "jira_pass", "pw");
  }
  const client: JiraSearchClient = overrides?.client ?? {
    searchIssues: (): Promise<JiraResult<JiraIssueLite[]>> =>
      Promise.resolve({ status: "success", data: [] }),
  };
  return createJiraPoller({
    business_id: businessId,
    event_type: "jira.issue.updated",
    entry_config: overrides?.entryConfig ?? VALID_CONFIG,
    deps: { queue: fakeQueue.queue, env: fakeEnv.env },
    clientFactory: overrides?.clientFactory ?? (() => client),
  });
}

describe("jira-poller", () => {
  it("事件产出形状：event_id/jira:{key}:{updated}、session_id=key、payload 轻量字段", async () => {
    const client: JiraSearchClient = {
      searchIssues: () =>
        Promise.resolve({
          status: "success",
          data: [
            {
              key: "PRJ-1",
              summary: "摘要",
              status: "Open",
              priority: "Major",
              issue_type: "Bug",
              assignee: "zhangsan",
              reporter: null,
              updated: "2026-10-08T10:00:00.000+0800",
            },
          ],
        }),
    };
    const poller = makePoller({ client });

    await poller.run();

    expect(fakeQueue.tasks).toHaveLength(1);
    const event = fakeQueue.tasks[0]?.event;
    expect(event?.contract_version).toBe("v1");
    expect(event?.source).toBe("jira");
    expect(event?.event_id).toBe("jira:PRJ-1:2026-10-08T10:00:00.000+0800");
    expect(event?.event_type).toBe("jira.issue.updated");
    expect(event?.session_id).toBe("PRJ-1");
    expect(event?.correlation_id).toBe(event?.event_id);
    expect(event?.hop_count).toBe(0);
    expect(event?.payload).toEqual({
      issue_key: "PRJ-1",
      summary: "摘要",
      status: "Open",
      priority: "Major",
      issue_type: "Bug",
      assignee: "zhangsan",
      reporter: null,
      updated: "2026-10-08T10:00:00.000+0800",
    });
  });

  it("同 updated 重推被队列幂等丢弃；updated 变化 = 新事件", async () => {
    let updated = "t1";
    const client: JiraSearchClient = {
      searchIssues: () =>
        Promise.resolve({
          status: "success",
          data: [
            {
              key: "PRJ-1",
              summary: "s",
              status: "Open",
              priority: "Major",
              issue_type: "Bug",
              assignee: null,
              reporter: null,
              updated,
            },
          ],
        }),
    };
    const poller = makePoller({ client });

    await poller.run();
    await poller.run(); // 同 updated → 幂等
    expect(fakeQueue.tasks).toHaveLength(1);

    updated = "t2";
    await poller.run();
    expect(fakeQueue.tasks).toHaveLength(2);
    expect(fakeQueue.tasks[1]?.event.event_id).toBe("jira:PRJ-1:t2");
  });

  it("防重入：上一轮未完，本轮跳过（search 只调一次）", async () => {
    let resolveSearch: ((result: JiraResult<JiraIssueLite[]>) => void) | null =
      null;
    let searchCalls = 0;
    const client: JiraSearchClient = {
      searchIssues: () => {
        searchCalls += 1;
        return new Promise<JiraResult<JiraIssueLite[]>>((resolve) => {
          resolveSearch = resolve;
        });
      },
    };
    const poller = makePoller({ client });

    const first = poller.run();
    expect(poller.running).toBe(true);
    await poller.run(); // 进行中再调 → 直接返回
    expect(searchCalls).toBe(1);

    (resolveSearch as unknown as (r: JiraResult<JiraIssueLite[]>) => void)({
      status: "success",
      data: [],
    });
    await first;
    expect(poller.running).toBe(false);
  });

  it("占位解析：username/password 用 {{}} 占位，真值传入 clientFactory", async () => {
    const seen: JiraClientConfig[] = [];
    const poller = makePoller({
      clientFactory: (config) => {
        seen.push(config);
        return {
          searchIssues: () => Promise.resolve({ status: "success", data: [] }),
        };
      },
    });

    await poller.run();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      baseUrl: "http://jira.local",
      username: "bot",
      password: "pw",
    });
  });

  it("redirect 网关凭据：占位解析并传入 clientFactory；不配则不传", async () => {
    fakeEnv.setSecret("b1", "gw_user", "gateway-bot");
    fakeEnv.setSecret("b1", "gw_pass", "gateway-pw");
    const seen: JiraClientConfig[] = [];
    const factory = (config: JiraClientConfig): JiraSearchClient => {
      seen.push(config);
      return {
        searchIssues: () => Promise.resolve({ status: "success", data: [] }),
      };
    };

    const withRedirect = makePoller({
      entryConfig: {
        ...VALID_CONFIG,
        redirect_username: "{{gw_user}}",
        redirect_password: "{{gw_pass}}",
      },
      clientFactory: factory,
    });
    await withRedirect.run();
    expect(seen[0]).toMatchObject({
      redirectUsername: "gateway-bot",
      redirectPassword: "gateway-pw",
    });

    seen.length = 0;
    const withoutRedirect = makePoller({ clientFactory: factory });
    await withoutRedirect.run();
    expect(seen[0]).not.toHaveProperty("redirectUsername");
    expect(seen[0]).not.toHaveProperty("redirectPassword");
  });

  it("占位键缺失（环境配置无该键）→ 记 warn 跳过本轮，不产事件不抛错", async () => {
    const poller = makePoller({ withSecrets: false });
    await expect(poller.run()).resolves.toBeUndefined();
    expect(fakeQueue.tasks).toHaveLength(0);
  });

  it("两业务同名占位 key 隔离：各取各业务桶的值", async () => {
    fakeEnv.setSecret("b2", "jira_user", "bot-b2");
    fakeEnv.setSecret("b2", "jira_pass", "pw-b2");
    const seenByBusiness = new Map<string, JiraClientConfig[]>();
    const factoryFor =
      (businessId: string) =>
      (config: JiraClientConfig): JiraSearchClient => {
        const list = seenByBusiness.get(businessId) ?? [];
        list.push(config);
        seenByBusiness.set(businessId, list);
        return {
          searchIssues: () => Promise.resolve({ status: "success", data: [] }),
        };
      };

    await makePoller({ clientFactory: factoryFor("b1") }).run();
    await makePoller({
      businessId: "b2",
      clientFactory: factoryFor("b2"),
      withSecrets: false, // 上面已手写 b2 的桶值，避免被缺省值覆盖
    }).run();

    expect(seenByBusiness.get("b1")?.[0]?.username).toBe("bot");
    expect(seenByBusiness.get("b1")?.[0]?.password).toBe("pw");
    expect(seenByBusiness.get("b2")?.[0]?.username).toBe("bot-b2");
    expect(seenByBusiness.get("b2")?.[0]?.password).toBe("pw-b2");
  });

  it("行配置非法（缺 project）→ 跳过本轮，不产事件不抛错", async () => {
    const badConfig = { ...VALID_CONFIG };
    delete badConfig.project;
    const poller = makePoller({ entryConfig: badConfig });
    await expect(poller.run()).resolves.toBeUndefined();
    expect(fakeQueue.tasks).toHaveLength(0);
  });

  it("jira 侧失败（客户端 error）→ 记错误跳过，不产事件不抛错", async () => {
    const client: JiraSearchClient = {
      searchIssues: () =>
        Promise.resolve({
          status: "error",
          code: "network_error",
          message: "jira 连接失败",
        }),
    };
    const poller = makePoller({ client });
    await expect(poller.run()).resolves.toBeUndefined();
    expect(fakeQueue.tasks).toHaveLength(0);
  });
});

describe("parseJiraEntryConfig", () => {
  it("必填缺失逐项列出", () => {
    const result = parseJiraEntryConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContain("缺 jira_url");
    expect(result.problems).toContain("缺 username");
    expect(result.problems).toContain("缺 password");
    expect(result.problems).toContain("缺 project");
  });

  it("默认与下限：days_back 默认 7；interval 默认 60、下限 30", () => {
    const parsed = parseJiraEntryConfig(VALID_CONFIG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.days_back).toBe(7);
    expect(parsed.config.interval_seconds).toBe(60);
    expect(parsed.config.assignees).toBeUndefined();

    const low = parseJiraEntryConfig({ ...VALID_CONFIG, interval_seconds: 5 });
    expect(low.ok && low.config.interval_seconds).toBe(30);
  });

  it("assignees：* 与缺省 = 不过滤；逗号分隔解析", () => {
    const star = parseJiraEntryConfig({ ...VALID_CONFIG, assignees: "*" });
    expect(star.ok && star.config.assignees).toBeUndefined();
    const list = parseJiraEntryConfig({
      ...VALID_CONFIG,
      assignees: " a , b ",
    });
    expect(list.ok && list.config.assignees).toEqual(["a", "b"]);
  });

  it("redirect_username/redirect_password 可选：缺省不带出，配置则收敛进 config", () => {
    const none = parseJiraEntryConfig(VALID_CONFIG);
    expect(none.ok && none.config.redirect_username).toBeUndefined();
    expect(none.ok && none.config.redirect_password).toBeUndefined();
    const withRedirect = parseJiraEntryConfig({
      ...VALID_CONFIG,
      redirect_username: "gw-bot",
      redirect_password: "gw-pw",
    });
    expect(withRedirect.ok && withRedirect.config.redirect_username).toBe(
      "gw-bot",
    );
    expect(withRedirect.ok && withRedirect.config.redirect_password).toBe(
      "gw-pw",
    );
  });
});
