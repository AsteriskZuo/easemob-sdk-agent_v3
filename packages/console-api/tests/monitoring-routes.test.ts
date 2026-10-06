import { jest } from "@jest/globals";
import type {
  ExitToolMenuItem,
  LifecycleRecord,
  QueuesStatus,
  Task,
} from "../src/index.js";
import {
  TEST_CONFIG_VIEW,
  api,
  envelope,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

let server: TestServer;
let token: string;
let businessId: string;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  token = await loginToken(server, "admin", "admin-pass");
  businessId = server.registry.create({
    business_name: "监控业务",
    creator_id: "usr_monitor",
    source: "manual",
    event_type: "test.ping",
  });
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("GET /api/monitor/queues", () => {
  it("两队列四状态计数（手工造数：pending/processing/done/dead）", async () => {
    const t1 = server.entryQueue.enqueue(envelope("evt_q1"));
    server.entryQueue.enqueue(envelope("evt_q2"));
    const taken = server.entryQueue.take();
    expect(taken?.task_id).toBe(t1.task_id);
    const t3 = server.entryQueue.enqueue(envelope("evt_q3"));
    server.entryQueue.complete(t3.task_id);
    const t4 = server.entryQueue.enqueue(envelope("evt_q4"));
    server.entryQueue.deadLetter(t4.task_id, "测试死信");
    server.exitQueue.enqueue(envelope("evt_q5"));

    const res = await api(server, "GET", "/api/monitor/queues", { token });
    expect(res.status).toBe(200);
    const counts = res.body as QueuesStatus;
    expect(counts.entry).toEqual({
      pending: 1,
      processing: 1,
      done: 1,
      dead: 1,
    });
    expect(counts.exit).toEqual({
      pending: 1,
      processing: 0,
      done: 0,
      dead: 0,
    });
  });
});

describe("GET /api/monitor/tasks", () => {
  it("queue 参数缺失/非法 → 400；status/event_id/correlation_id 过滤生效；返回含 event 信封", async () => {
    const missing = await api(server, "GET", "/api/monitor/tasks", { token });
    expect(missing.status).toBe(400);
    const badQueue = await api(
      server,
      "GET",
      "/api/monitor/tasks?queue=middle",
      {
        token,
      },
    );
    expect(badQueue.status).toBe(400);
    const badStatus = await api(
      server,
      "GET",
      "/api/monitor/tasks?queue=entry&status=weird",
      { token },
    );
    expect(badStatus.status).toBe(400);

    const dead = await api(
      server,
      "GET",
      "/api/monitor/tasks?queue=entry&status=dead",
      { token },
    );
    expect(dead.status).toBe(200);
    const deadTasks = dead.body as Task[];
    expect(deadTasks).toHaveLength(1);
    expect(deadTasks[0].event.event_id).toBe("evt_q4");

    const byEvent = await api(
      server,
      "GET",
      "/api/monitor/tasks?queue=entry&event_id=evt_q2",
      { token },
    );
    expect((byEvent.body as Task[]).map((t) => t.event.event_id)).toEqual([
      "evt_q2",
    ]);

    const byCorrelation = await api(
      server,
      "GET",
      "/api/monitor/tasks?queue=exit&correlation_id=evt_q5",
      { token },
    );
    expect((byCorrelation.body as Task[]).map((t) => t.event.event_id)).toEqual(
      ["evt_q5"],
    );
  });
});

describe("GET /api/businesses/:id/runs 与 GET /api/runs/:id", () => {
  it("列表按 created_at 倒序、limit 缺省 50/上限 500；单条 200；不存在 404", async () => {
    server.lifecycle.markRunning({
      lifecycle_id: "run_001",
      business_id: businessId,
      event_id: "evt_r1",
      channel_id: "manual/S-1",
      created_at: "2026-10-01T00:00:00.000Z",
    });
    server.lifecycle.markRunning({
      lifecycle_id: "run_002",
      business_id: businessId,
      event_id: "evt_r2",
      channel_id: "manual/S-1",
      created_at: "2026-10-02T00:00:00.000Z",
    });
    server.lifecycle.markTerminal("run_001", "success");

    const list = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs`,
      { token },
    );
    expect(list.status).toBe(200);
    const runs = list.body as LifecycleRecord[];
    expect(runs.map((r) => r.lifecycle_id)).toEqual(["run_002", "run_001"]);
    expect(runs[1].status).toBe("success");
    expect(runs[1].finished_at).toBeDefined();

    const limited = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs?limit=1`,
      { token },
    );
    expect(
      (limited.body as LifecycleRecord[]).map((r) => r.lifecycle_id),
    ).toEqual(["run_002"]);

    const badLimit = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs?limit=0`,
      { token },
    );
    expect(badLimit.status).toBe(400);

    const one = await api(server, "GET", "/api/runs/run_001", { token });
    expect(one.status).toBe(200);
    expect((one.body as LifecycleRecord).business_id).toBe(businessId);

    const missing = await api(server, "GET", "/api/runs/run_nope", { token });
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/config 与 GET /api/exit-tools", () => {
  it("配置回显 = 注入的生效配置（非敏感子集，不含 pi_env）", async () => {
    const res = await api(server, "GET", "/api/config", { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(TEST_CONFIG_VIEW);
    expect("pi_env" in (res.body as Record<string, unknown>)).toBe(false);
  });

  it("出口工具菜单 = 注册表原样映射（kind/name/implemented/configSchema）", async () => {
    const res = await api(server, "GET", "/api/exit-tools", { token });
    expect(res.status).toBe(200);
    const menu = res.body as ExitToolMenuItem[];
    expect(menu.length).toBe(7);
    for (const item of menu) {
      expect(typeof item.kind).toBe("string");
      expect(typeof item.name).toBe("string");
      expect(typeof item.implemented).toBe("boolean");
      expect(Array.isArray(item.configSchema)).toBe(true);
    }
    expect(menu.map((m) => m.kind)).toContain("webhook");
  });
});
