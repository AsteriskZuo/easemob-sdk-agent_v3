import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { WebhookEntryAdapter } from "../src/webhook.js";
import type { EntryDeps } from "../src/types.js";
import { FakeEnv, FakeQueue, FakeRegistry } from "./fakes.js";

let tmpDir: string;
let fakeQueue: FakeQueue;
let fakeRegistry: FakeRegistry;
let fakeEnv: FakeEnv;
let deps: EntryDeps;
let adapter: WebhookEntryAdapter;
let baseUrl: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-entry-adapters-webhook-test-"));
  initLogger({ logsDir: tmpDir });
});

afterAll(() => {
  resetForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  fakeQueue = new FakeQueue();
  fakeRegistry = new FakeRegistry();
  fakeEnv = new FakeEnv();
  deps = {
    queue: fakeQueue.queue,
    registry: fakeRegistry.registry,
    env: fakeEnv.env,
  };
  // 随机端口起真服务
  adapter = new WebhookEntryAdapter({ webhook_port: 0 });
  adapter.start(deps);
  await adapter.ready();
  baseUrl = `http://127.0.0.1:${adapter.port()}`;
});

afterEach(async () => {
  await adapter.stop();
  await adapter.stop(); // 幂等：二次调用不报错
});

/** 注册一个 webhook match 行，返回 business_id */
function addWebhookRow(
  eventType: string,
  entryConfig: Record<string, unknown>,
): string {
  const businessId = fakeRegistry.createBusiness();
  fakeRegistry.registry.addMatch(businessId, "webhook", eventType, entryConfig);
  return businessId;
}

async function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe("webhook 入口适配器", () => {
  it("200 落队：信封字段逐项断言（payload = body 原样，event_type 取 match 行）", async () => {
    addWebhookRow("jira.issue.updated", {
      path: "jira-listener",
      session_id_key: "issue.key",
    });
    const body = { issue: { key: "PRJ-1" }, action: "updated", n: 1 };

    const res = await post("/hooks/jira-listener", JSON.stringify(body));

    expect(res.status).toBe(200);
    const eventId = res.json.event_id as string;
    expect(eventId).toMatch(/^evt_/);
    expect(fakeQueue.tasks).toHaveLength(1);
    const event = fakeQueue.tasks[0]?.event;
    expect(event?.contract_version).toBe("v1");
    expect(event?.source).toBe("webhook");
    expect(event?.event_id).toBe(eventId);
    expect(event?.event_type).toBe("jira.issue.updated");
    expect(event?.session_id).toBe("PRJ-1");
    expect(event?.correlation_id).toBe(eventId);
    expect(event?.hop_count).toBe(0);
    expect(event?.payload).toEqual(body);
    expect(typeof event?.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(event?.timestamp ?? ""))).toBe(false);
    expect(event?.timestamp.endsWith("Z")).toBe(true);
  });

  it("event_id 重推幂等：同 event_id 两次投递均 200，队列只进一条", async () => {
    addWebhookRow("github.events", {
      path: "gh",
      session_id_key: "repo",
      event_id_key: "delivery_id",
    });
    const body = JSON.stringify({ repo: "r1", delivery_id: "d-001" });

    const first = await post("/hooks/gh", body);
    const second = await post("/hooks/gh", body);

    expect(first.status).toBe(200);
    expect(first.json.event_id).toBe("d-001");
    expect(second.status).toBe(200);
    expect(second.json.event_id).toBe("d-001");
    expect(fakeQueue.tasks).toHaveLength(1);
  });

  it("event_id_key 配置了但字段缺失 → 平台生成 evt_ id", async () => {
    addWebhookRow("github.events", {
      path: "gh",
      session_id_key: "repo",
      event_id_key: "delivery_id",
    });

    const res = await post("/hooks/gh", JSON.stringify({ repo: "r1" }));

    expect(res.status).toBe(200);
    expect(res.json.event_id).toMatch(/^evt_/);
  });

  it("验签：token_key 配置后，无头/错值 → 401；等值 → 200（值取自业务 secrets 桶）", async () => {
    const businessId = addWebhookRow("secure.event", {
      path: "secure",
      session_id_key: "id",
      token_key: "webhook_token",
    });
    fakeEnv.setSecret(businessId, "webhook_token", "s3cret");

    expect(
      await post("/hooks/secure", JSON.stringify({ id: "S1" })),
    ).toMatchObject({ status: 401 });
    expect(
      await post("/hooks/secure", JSON.stringify({ id: "S1" }), {
        "x-webhook-token": "wrong",
      }),
    ).toMatchObject({ status: 401 });
    const okRes = await post("/hooks/secure", JSON.stringify({ id: "S1" }), {
      "x-webhook-token": "s3cret",
    });
    expect(okRes.status).toBe(200);
    expect(fakeQueue.tasks[0]?.event.session_id).toBe("S1");
  });

  it("验签：secrets 桶缺该键 → 401（无法比对视为失败）", async () => {
    addWebhookRow("secure.event", {
      path: "secure",
      session_id_key: "id",
      token_key: "webhook_token",
    });

    const res = await post("/hooks/secure", JSON.stringify({ id: "S1" }), {
      "x-webhook-token": "whatever",
    });
    expect(res.status).toBe(401);
  });

  it("400：非法 JSON / 非 object body / session_id 取不到 / event_id 值非法", async () => {
    addWebhookRow("e.t", {
      path: "p1",
      session_id_key: "issue.key",
      event_id_key: "eid",
    });

    expect((await post("/hooks/p1", "{ not json")).status).toBe(400);
    expect((await post("/hooks/p1", JSON.stringify([1, 2]))).status).toBe(400);
    // session_id_key 取不到
    expect((await post("/hooks/p1", JSON.stringify({ x: 1 }))).status).toBe(
      400,
    );
    // session_id 取到空串/非字符串
    expect(
      (await post("/hooks/p1", JSON.stringify({ issue: { key: "" } }))).status,
    ).toBe(400);
    expect(
      (await post("/hooks/p1", JSON.stringify({ issue: { key: 42 } }))).status,
    ).toBe(400);
    // event_id_key 取到非字符串 → 400
    expect(
      (
        await post(
          "/hooks/p1",
          JSON.stringify({ issue: { key: "K" }, eid: 123 }),
        )
      ).status,
    ).toBe(400);
    expect(fakeQueue.tasks).toHaveLength(0);
  });

  it("404：未知 path；非 POST 方法", async () => {
    addWebhookRow("e.t", { path: "known", session_id_key: "id" });

    expect(
      (await post("/hooks/unknown", JSON.stringify({ id: "x" }))).status,
    ).toBe(404);
    const getRes = await fetch(`${baseUrl}/hooks/known`);
    expect(getRes.status).toBe(404);
  });

  it("点分提取：多级嵌套 session_id_key（a.b.c）", async () => {
    addWebhookRow("e.t", { path: "deep", session_id_key: "a.b.c" });

    const res = await post(
      "/hooks/deep",
      JSON.stringify({ a: { b: { c: "S-deep" } } }),
    );

    expect(res.status).toBe(200);
    expect(fakeQueue.tasks[0]?.event.session_id).toBe("S-deep");
  });

  it("registry 变更即时生效：加行后新 path 立即可投（无需重启适配器）", async () => {
    expect(
      (await post("/hooks/late", JSON.stringify({ id: "x" }))).status,
    ).toBe(404);

    addWebhookRow("e.t", { path: "late", session_id_key: "id" });

    const res = await post("/hooks/late", JSON.stringify({ id: "S-late" }));
    expect(res.status).toBe(200);
    expect(fakeQueue.tasks[0]?.event.session_id).toBe("S-late");
  });
});
