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

// 造数用的两个本地日历日（早于今天，避开缺省区间）
const D1 = "2026-11-03";
const D2 = "2026-11-04";

/** 本地某日正午的 UTC ISO：date(...,'localtime') 分日恒落在该日（正午 ±14h 不出界），与时区无关 */
function localNoonIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

/** rows → 查询表：key = `${date}|${metric}|${bucket}` */
function indexRows(rows: StatsRow[]): Map<string, number> {
  return new Map(
    rows.map((r) => [`${r.date}|${r.metric}|${r.bucket}`, r.value]),
  );
}

// wired：装配了 run_metrics 的服务（biz.* 正常路径）；plain：未装配（降级路径）
let wired: TestServer;
let plain: TestServer;
let token: string;
let plainToken: string;
let businessId: string;
let plainBusinessId: string;

beforeAll(async () => {
  wired = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
    run_metrics: true,
  });
  token = await loginToken(wired, "admin", "admin-pass");
  businessId = wired.registry.create({
    business_name: "biz 统计业务",
    creator_id: "usr_stats",
    source: "manual",
    event_type: "test.ping",
  });

  // D1：字符串指标 decision（approve×2 / reject×1）+ 数值指标 score（90, 80）；
  // 同日再造 run.* 与 llm.* 各一，供混排行序断言
  wired.runMetrics.record("run_m1", businessId, localNoonIso(D1), {
    decision: "approve",
    score: 90,
  });
  wired.runMetrics.record("run_m2", businessId, localNoonIso(D1), {
    decision: "approve",
    score: 80,
  });
  wired.runMetrics.record("run_m3", businessId, localNoonIso(D1), {
    decision: "reject",
  });
  wired.lifecycle.markRunning({
    lifecycle_id: "run_s1",
    business_id: businessId,
    event_id: "evt_s1",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D1),
  });
  wired.lifecycle.markTerminal("run_s1", "success");
  wired.llmCalls.record({
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
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 15,
      cost_total: 0.01,
    },
  });

  // D2 护栏：tag 共 21 个 distinct 桶——z_high 计数 5（字典序最末但应保留），a00~a19 各 1
  // → 前 20 = z_high + a00~a18，a19 合并进 __other__（计数 1）
  for (let i = 0; i < 5; i += 1) {
    wired.runMetrics.record(`run_gz${i}`, businessId, localNoonIso(D2), {
      tag: "z_high",
    });
  }
  for (let i = 0; i < 20; i += 1) {
    wired.runMetrics.record(`run_ga${i}`, businessId, localNoonIso(D2), {
      tag: `a${String(i).padStart(2, "0")}`,
    });
  }
  // D2 边界：tag20 恰好 20 个 distinct 桶 → 全部保留，不出 __other__
  for (let i = 0; i < 20; i += 1) {
    wired.runMetrics.record(`run_gb${i}`, businessId, localNoonIso(D2), {
      tag20: `b${String(i).padStart(2, "0")}`,
    });
  }

  // plain：未装配 run_metrics，但直接往同一个 db 落 metrics（数据存在而 API 降级）
  plain = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  plainToken = await loginToken(plain, "admin", "admin-pass");
  plainBusinessId = plain.registry.create({
    business_name: "降级业务",
    creator_id: "usr_stats",
    source: "manual",
    event_type: "test.ping",
  });
  plain.runMetrics.record("run_p1", plainBusinessId, localNoonIso(D1), {
    decision: "approve",
  });
  plain.lifecycle.markRunning({
    lifecycle_id: "run_p2",
    business_id: plainBusinessId,
    event_id: "evt_p2",
    channel_id: "manual/S-1",
    created_at: localNoonIso(D1),
  });
  plain.lifecycle.markTerminal("run_p2", "success");
});

afterAll(async () => {
  await wired.stop();
  await plain.stop();
  resetTestLogger();
});

describe("GET /api/stats/daily biz.* 映射（契约 F）", () => {
  let body: DailyStatsResponse;
  let byKey: Map<string, number>;

  beforeAll(async () => {
    const res = await api(
      wired,
      "GET",
      `/api/stats/daily?business_id=${businessId}&from=${D1}&to=${D2}`,
      { token },
    );
    expect(res.status).toBe(200);
    body = res.body as DailyStatsResponse;
    byKey = indexRows(body.rows);
  });

  it("字符串桶：逐值出行，bucket = 值原样，value = 次数", () => {
    expect(byKey.get(`${D1}|biz.decision|approve`)).toBe(2);
    expect(byKey.get(`${D1}|biz.decision|reject`)).toBe(1);
    // 纯字符串指标不出数值行
    expect(byKey.has(`${D1}|biz.decision.sum|`)).toBe(false);
    expect(byKey.has(`${D1}|biz.decision.avg|`)).toBe(false);
    expect(byKey.has(`${D1}|biz.decision.count|`)).toBe(false);
  });

  it("数值：sum/avg/count 三行（bucket 均为空串）", () => {
    expect(byKey.get(`${D1}|biz.score.sum|`)).toBe(170);
    expect(byKey.get(`${D1}|biz.score.avg|`)).toBe(85);
    expect(byKey.get(`${D1}|biz.score.count|`)).toBe(2);
    // 纯数值指标不出字符串桶行
    expect(
      body.rows.some((r) => r.date === D1 && r.metric === "biz.score"),
    ).toBe(false);
  });

  it("护栏：21 个 distinct 桶 → 计数降序取前 20（计数相同按值字典序），其余合并 __other__", () => {
    // z_high 字典序最末但计数最高 → 保留（计数优先于字典序）
    expect(byKey.get(`${D2}|biz.tag|z_high`)).toBe(5);
    // a00~a19 计数全 1 并列 → 按值字典序取前 19（连同 z_high 共 20），a19 被合并
    expect(byKey.get(`${D2}|biz.tag|a00`)).toBe(1);
    expect(byKey.get(`${D2}|biz.tag|a18`)).toBe(1);
    expect(byKey.has(`${D2}|biz.tag|a19`)).toBe(false);
    expect(byKey.get(`${D2}|biz.tag|__other__`)).toBe(1);
    // biz.tag 当日总行数 = 20 保留 + 1 合并
    const tagRows = body.rows.filter(
      (r) => r.date === D2 && r.metric === "biz.tag",
    );
    expect(tagRows).toHaveLength(21);
  });

  it("边界：恰好 20 个 distinct 桶不触发护栏", () => {
    const tag20Rows = body.rows.filter(
      (r) => r.date === D2 && r.metric === "biz.tag20",
    );
    expect(tag20Rows).toHaveLength(20);
    expect(byKey.get(`${D2}|biz.tag20|b00`)).toBe(1);
    expect(byKey.get(`${D2}|biz.tag20|b19`)).toBe(1);
    expect(byKey.has(`${D2}|biz.tag20|__other__`)).toBe(false);
  });

  it("与 run.*/llm.* 混排时行序契约不变：(date, metric, bucket) 字典序", () => {
    const sorted = [...body.rows].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
      if (a.bucket !== b.bucket) return a.bucket < b.bucket ? -1 : 1;
      return 0;
    });
    expect(body.rows).toEqual(sorted);
    // 抽样：D1 上 biz.* < llm.* < run.*
    const d1Metrics = body.rows
      .filter((r) => r.date === D1)
      .map((r) => `${r.metric}|${r.bucket}`);
    expect(d1Metrics.indexOf("biz.decision|approve")).toBeLessThan(
      d1Metrics.indexOf("llm.calls|"),
    );
    expect(d1Metrics.indexOf("llm.calls|")).toBeLessThan(
      d1Metrics.indexOf("run.total|"),
    );
  });
});

describe("GET /api/stats/daily biz.* 降级（runMetrics 缺省）", () => {
  it("数据存在但未装配 run_metrics → 不出 biz.* 行，run.* 照常", async () => {
    const res = await api(
      plain,
      "GET",
      `/api/stats/daily?business_id=${plainBusinessId}&from=${D1}&to=${D1}`,
      { token: plainToken },
    );
    expect(res.status).toBe(200);
    const body = res.body as DailyStatsResponse;
    expect(body.rows.some((r) => r.metric.startsWith("biz."))).toBe(false);
    const byKey = indexRows(body.rows);
    expect(byKey.get(`${D1}|run.total|`)).toBe(1);
  });
});
