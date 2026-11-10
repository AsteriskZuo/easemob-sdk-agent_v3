import { jest } from "@jest/globals";
import type { DailyStatsResponse, StatsRow } from "../src/index.js";
import {
  api,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

let server: TestServer;
let token: string;
let businessId: string;
let emptyBusinessId: string;

// 造数用的三个本地日历日（早于今天，避免与缺省区间测试互相污染断言）
const D1 = "2026-11-03";
const D2 = "2026-11-04";
const D3 = "2026-11-05";

/** 本地某日正午的 UTC ISO：date(...,'localtime') 分日恒落在该日（正午 ±14h 不出界），与时区无关 */
function localNoonIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

/** 与实现同逻辑的本地日历日（缺省区间回显断言用） */
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** rows → 查询表：key = `${date}|${metric}|${bucket}` */
function indexRows(rows: StatsRow[]): Map<string, number> {
  return new Map(
    rows.map((r) => [`${r.date}|${r.metric}|${r.bucket}`, r.value]),
  );
}

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  token = await loginToken(server, "admin", "admin-pass");
  businessId = server.registry.create({
    business_name: "统计业务",
    creator_id: "usr_stats",
    source: "manual",
    event_type: "test.ping",
  });
  emptyBusinessId = server.registry.create({
    business_name: "空业务",
    creator_id: "usr_stats",
    source: "manual",
    event_type: "test.ping",
  });

  // D1：success 1 + failed 2（main / 无 failed_at→unknown）；
  // llm：2 次成功带 usage + 1 次失败（agent_failed，无 usage）
  server.lifecycle.markRunning({
    lifecycle_id: "run_s1",
    business_id: businessId,
    event_id: "evt_s1",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D1),
  });
  server.lifecycle.markTerminal("run_s1", "success");
  server.lifecycle.markRunning({
    lifecycle_id: "run_f1",
    business_id: businessId,
    event_id: "evt_f1",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D1),
  });
  server.lifecycle.markTerminal("run_f1", "failed", "main");
  server.lifecycle.markRunning({
    lifecycle_id: "run_f2",
    business_id: businessId,
    event_id: "evt_f2",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D1),
  });
  server.lifecycle.markTerminal("run_f2", "failed");
  server.llmCalls.record({
    run_id: "run_s1",
    business_id: businessId,
    ts: localNoonIso(D1),
    op: "agent",
    model: "test/model-a",
    skills: [],
    mode: "channel",
    ok: true,
    duration_ms: 1000,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      total_tokens: 165,
      cost_total: 0.01,
    },
  });
  server.llmCalls.record({
    run_id: "run_s1",
    business_id: businessId,
    ts: localNoonIso(D1),
    op: "agent",
    model: "test/model-a",
    skills: [],
    mode: "channel",
    ok: true,
    duration_ms: 3000,
    usage: {
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 300,
      cost_total: 0.02,
    },
  });
  server.llmCalls.record({
    run_id: "run_f1",
    business_id: businessId,
    ts: localNoonIso(D1),
    op: "agent",
    model: "test/model-a",
    skills: [],
    mode: "channel",
    ok: false,
    error: "agent_failed",
    duration_ms: 500,
  });

  // D2：timeout 1；llm：1 次成功但无 usage（calls_without_usage = 1，token 不计入）
  server.lifecycle.markRunning({
    lifecycle_id: "run_t1",
    business_id: businessId,
    event_id: "evt_t1",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D2),
  });
  server.lifecycle.markTerminal("run_t1", "timeout");
  server.llmCalls.record({
    run_id: "run_t1",
    business_id: businessId,
    ts: localNoonIso(D2),
    op: "agent",
    model: "test/model-a",
    skills: [],
    mode: "fresh",
    ok: true,
    duration_ms: 2000,
  });

  // D3：仅 1 条仍 running（当日无已完结 run → avg_duration_ms 为 null 不出行）
  server.lifecycle.markRunning({
    lifecycle_id: "run_r1",
    business_id: businessId,
    event_id: "evt_r1",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D3),
  });
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("GET /api/stats/daily 参数校验（spec §6）", () => {
  it("未登录 → 401", async () => {
    const res = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${businessId}`,
    );
    expect(res.status).toBe(401);
  });

  it("business_id 缺失 → 400 invalid_input；不存在 → 404 not_found", async () => {
    const missing = await api(server, "GET", "/api/stats/daily", { token });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: { code: string } }).error.code).toBe(
      "invalid_input",
    );

    const unknown = await api(
      server,
      "GET",
      "/api/stats/daily?business_id=biz_nope",
      { token },
    );
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("日期形非法 → 400（含不存在的日历日）", async () => {
    for (const q of [
      "from=abc",
      "from=2026-1-1",
      "from=2026-13-01",
      "to=2026-02-30",
    ]) {
      const res = await api(
        server,
        "GET",
        `/api/stats/daily?business_id=${businessId}&${q}`,
        { token },
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        "invalid_input",
      );
    }
  });

  it("from > to → 400", async () => {
    const res = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${businessId}&from=${D2}&to=${D1}`,
      { token },
    );
    expect(res.status).toBe(400);
  });

  it("区间上限 92 天：92 天放行、93 天 400", async () => {
    // 2026-01-01 ~ 2026-04-02 = 92 天（含端点）
    const ok = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${businessId}&from=2026-01-01&to=2026-04-02`,
      { token },
    );
    expect(ok.status).toBe(200);
    // 2026-01-01 ~ 2026-04-03 = 93 天
    const tooLong = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${businessId}&from=2026-01-01&to=2026-04-03`,
      { token },
    );
    expect(tooLong.status).toBe(400);
  });

  it("from/to 缺省：回显 to=今天、from=13 天前", async () => {
    const res = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${emptyBusinessId}`,
      { token },
    );
    expect(res.status).toBe(200);
    const body = res.body as DailyStatsResponse;
    expect(body.to).toBe(localDate(0));
    expect(body.from).toBe(localDate(-13));
  });

  it("零数据：rows 为空", async () => {
    const res = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${emptyBusinessId}&from=${D1}&to=${D3}`,
      { token },
    );
    expect(res.status).toBe(200);
    const body = res.body as DailyStatsResponse;
    expect(body.from).toBe(D1);
    expect(body.to).toBe(D3);
    expect(body.rows).toEqual([]);
  });
});

describe("GET /api/stats/daily 聚合映射（契约 C）", () => {
  let body: DailyStatsResponse;
  let byKey: Map<string, number>;

  beforeAll(async () => {
    const res = await api(
      server,
      "GET",
      `/api/stats/daily?business_id=${businessId}&from=${D1}&to=${D3}`,
      { token },
    );
    expect(res.status).toBe(200);
    body = res.body as DailyStatsResponse;
    byKey = indexRows(body.rows);
  });

  it("回显 business_id 与生效区间", () => {
    expect(body.business_id).toBe(businessId);
    expect(body.from).toBe(D1);
    expect(body.to).toBe(D3);
  });

  it("run.* 计数与分日归属正确", () => {
    expect(byKey.get(`${D1}|run.total|`)).toBe(3);
    expect(byKey.get(`${D1}|run.success|`)).toBe(1);
    expect(byKey.get(`${D1}|run.failed|`)).toBe(2);
    expect(byKey.get(`${D1}|run.timeout|`)).toBe(0);
    expect(byKey.get(`${D1}|run.running|`)).toBe(0);
    expect(byKey.get(`${D2}|run.total|`)).toBe(1);
    expect(byKey.get(`${D2}|run.timeout|`)).toBe(1);
    expect(byKey.get(`${D3}|run.total|`)).toBe(1);
    expect(byKey.get(`${D3}|run.running|`)).toBe(1);
  });

  it("run.failed_phase 四桶 0 值也出行（二维表列稳定）", () => {
    expect(byKey.get(`${D1}|run.failed_phase|main`)).toBe(1);
    expect(byKey.get(`${D1}|run.failed_phase|unknown`)).toBe(1);
    expect(byKey.get(`${D1}|run.failed_phase|check-input`)).toBe(0);
    expect(byKey.get(`${D1}|run.failed_phase|check-output`)).toBe(0);
    // 无失败的 D2/D3 同样出四条 0 值行
    for (const date of [D2, D3]) {
      for (const phase of ["check-input", "main", "check-output", "unknown"]) {
        expect(byKey.get(`${date}|run.failed_phase|${phase}`)).toBe(0);
      }
    }
  });

  it("avg_duration_ms：有已完结 run 出行、全 running 日不出行（null 不出行）", () => {
    expect(typeof byKey.get(`${D1}|run.avg_duration_ms|`)).toBe("number");
    expect(byKey.get(`${D1}|run.avg_duration_ms|`)).toBeGreaterThan(0);
    expect(typeof byKey.get(`${D2}|run.avg_duration_ms|`)).toBe("number");
    expect(byKey.has(`${D3}|run.avg_duration_ms|`)).toBe(false);
  });

  it("llm.* 映射：调用次/token 求和/成本/无 usage 计数/失败分桶/平均耗时", () => {
    expect(byKey.get(`${D1}|llm.calls|`)).toBe(3);
    expect(byKey.get(`${D1}|llm.tokens.input|`)).toBe(300);
    expect(byKey.get(`${D1}|llm.tokens.output|`)).toBe(150);
    expect(byKey.get(`${D1}|llm.tokens.cache_read|`)).toBe(10);
    expect(byKey.get(`${D1}|llm.tokens.cache_write|`)).toBe(5);
    expect(byKey.get(`${D1}|llm.tokens.total|`)).toBe(465);
    expect(byKey.get(`${D1}|llm.cost|`)).toBeCloseTo(0.03, 10);
    // 失败行不带 usage 是设计使然，不计入 calls_without_usage（该指标只盯成功但缺 usage 的行，见 runtime 契约）
    expect(byKey.get(`${D1}|llm.calls_without_usage|`)).toBe(0);
    expect(byKey.get(`${D1}|llm.errors|agent_failed`)).toBe(1);
    expect(byKey.get(`${D1}|llm.avg_duration_ms|`)).toBe(1500);

    // D2：唯一一行无 usage → token 全 0、不计入求和；无错误 → 无 llm.errors 行
    expect(byKey.get(`${D2}|llm.calls|`)).toBe(1);
    expect(byKey.get(`${D2}|llm.tokens.total|`)).toBe(0);
    expect(byKey.get(`${D2}|llm.calls_without_usage|`)).toBe(1);
    expect(byKey.get(`${D2}|llm.avg_duration_ms|`)).toBe(2000);
    expect(
      body.rows.some((r) => r.date === D2 && r.metric === "llm.errors"),
    ).toBe(false);

    // D3：无 llm 行 → 零数据日不出行
    expect(
      body.rows.some((r) => r.date === D3 && r.metric.startsWith("llm.")),
    ).toBe(false);
  });

  it("行排序 = (date, metric, bucket) 字典序", () => {
    const sorted = [...body.rows].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
      if (a.bucket !== b.bucket) return a.bucket < b.bucket ? -1 : 1;
      return 0;
    });
    expect(body.rows).toEqual(sorted);
    // 抽样确认字典序边界：llm.calls < llm.calls_without_usage < llm.cost（前缀与字符序）
    const d1Metrics = body.rows
      .filter((r) => r.date === D1)
      .map((r) => `${r.metric}|${r.bucket}`);
    expect(d1Metrics.indexOf("llm.calls|")).toBeLessThan(
      d1Metrics.indexOf("llm.calls_without_usage|"),
    );
    expect(d1Metrics.indexOf("llm.calls_without_usage|")).toBeLessThan(
      d1Metrics.indexOf("llm.cost|"),
    );
  });
});
