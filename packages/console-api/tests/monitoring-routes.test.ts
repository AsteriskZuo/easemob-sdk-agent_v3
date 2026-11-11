import { jest } from "@jest/globals";
import type {
  ExitToolMenuItem,
  LifecycleRecord,
  QueuesStatus,
  RunDetailResponse,
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

/** created_at（UTC ISO）→ 服务器本地日历日（与 date(created_at,'localtime') 同口径） */
function localDateOf(iso: string): string {
  const d = new Date(iso);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("GET /api/businesses/:id/runs?date=", () => {
  it("date 按本地日历日过滤、忽略 limit；非法日历日 → 400", async () => {
    server.lifecycle.markRunning({
      lifecycle_id: "run_d1",
      business_id: businessId,
      event_id: "evt_d1",
      channel_id: "manual/S-1",
      created_at: "2026-10-10T10:00:00.000Z",
    });
    server.lifecycle.markRunning({
      lifecycle_id: "run_d2",
      business_id: businessId,
      event_id: "evt_d2",
      channel_id: "manual/S-1",
      created_at: "2026-10-10T11:00:00.000Z",
    });
    server.lifecycle.markRunning({
      lifecycle_id: "run_d3",
      business_id: businessId,
      event_id: "evt_d3",
      channel_id: "manual/S-1",
      created_at: "2026-10-11T10:00:00.000Z",
    });
    const day1 = localDateOf("2026-10-10T10:00:00.000Z");
    const day2 = localDateOf("2026-10-11T10:00:00.000Z");

    const filtered = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs?date=${day1}`,
      { token },
    );
    expect(filtered.status).toBe(200);
    expect(
      (filtered.body as LifecycleRecord[]).map((r) => r.lifecycle_id),
    ).toEqual(["run_d2", "run_d1"]);

    // date 提供时忽略 limit（读口自身 500 行上限）
    const ignoreLimit = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs?date=${day1}&limit=1`,
      { token },
    );
    expect((ignoreLimit.body as LifecycleRecord[]).length).toBe(2);

    const other = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs?date=${day2}`,
      { token },
    );
    expect(
      (other.body as LifecycleRecord[]).map((r) => r.lifecycle_id),
    ).toEqual(["run_d3"]);

    const empty = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/runs?date=2000-01-01`,
      { token },
    );
    expect((empty.body as LifecycleRecord[]).length).toBe(0);

    for (const bad of ["abc", "2026-13-01", "2026-02-30", "2026-1-1"]) {
      const res = await api(
        server,
        "GET",
        `/api/businesses/${businessId}/runs?date=${bad}`,
        { token },
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        "invalid_input",
      );
    }
  });
});

describe("GET /api/runs/:id/detail（run_metrics 未装配降级）", () => {
  it("聚合形状：record 含 reason + llm_calls 命中 + metrics 恒 []；run 不存在 → 404", async () => {
    server.lifecycle.markTerminal("run_d1", "failed", "main", "boom reason");
    server.llmCalls.record({
      run_id: "run_d1",
      business_id: businessId,
      ts: "2026-10-10T10:00:05.000Z",
      op: "agent",
      model: "test/model-a",
      skills: ["s1"],
      mode: "channel",
      ok: true,
      duration_ms: 120,
    });

    const res = await api(server, "GET", "/api/runs/run_d1/detail", { token });
    expect(res.status).toBe(200);
    const detail = res.body as RunDetailResponse;
    expect(detail.record.lifecycle_id).toBe("run_d1");
    expect(detail.record.reason).toBe("boom reason");
    expect(detail.record.failed_at).toBe("main");
    expect(detail.llm_calls.length).toBe(1);
    expect(detail.llm_calls[0].model).toBe("test/model-a");
    expect(detail.llm_calls[0].skills).toEqual(["s1"]);
    // run_metrics 未装配 → 恒 []
    expect(detail.metrics).toEqual([]);

    const missing = await api(server, "GET", "/api/runs/run_nope/detail", {
      token,
    });
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/runs/:id/log（workspace_root 未装配降级）", () => {
  it("一律 404 且 message 含「未装配」语义", async () => {
    const res = await api(server, "GET", "/api/runs/run_d1/log", { token });
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("未装配");
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
