import { jest } from "@jest/globals";
import type { BusinessProfile, TaskScheduler, TaskView } from "../src/index.js";
import {
  api,
  createMemberAndLogin,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

/** runNow 调用记录（断言路由 → 调度器的参数映射） */
interface RunNowCall {
  business_id: string;
  task_name: string;
  trigger: string;
}

const TASK_VIEW: TaskView = {
  name: "warmup",
  program: "warmup",
  every_minutes: 720,
  timeout_minutes: 60,
  last_run: {
    run_id: "run_0123456789ABCDEFGHJKMNPQRS",
    status: "success",
    created_at: "2026-11-13T00:00:00.000Z",
    finished_at: "2026-11-13T00:00:05.000Z",
  },
};

/** 可控定时任务调度器桩：describeTasks 恒出一项；runNow 行为按 behavior 注入 */
function makeSchedulerStub(behavior: "ok" | "not_found" | "running" = "ok"): {
  scheduler: TaskScheduler;
  calls: RunNowCall[];
} {
  const calls: RunNowCall[] = [];
  const scheduler: TaskScheduler = {
    start: () => {},
    stop: () => Promise.resolve(),
    describeTasks: () => Promise.resolve([TASK_VIEW]),
    runNow: (business_id, task_name, trigger) => {
      calls.push({ business_id, task_name, trigger });
      if (behavior === "not_found") {
        return Promise.reject(
          new Error(`scheduled_task_not_found: ${business_id}/${task_name}`),
        );
      }
      if (behavior === "running") {
        return Promise.reject(
          new Error(`scheduled_task_running: ${business_id}/${task_name}`),
        );
      }
      return Promise.resolve({ run_id: "run_0123456789ABCDEFGHJKMNPQRS" });
    },
  };
  return { scheduler, calls };
}

let server: TestServer;
let adminToken: string;
let owner: { user_id: string; token: string };
let other: { user_id: string; token: string };

afterEach(async () => {
  await server.stop();
  resetTestLogger();
});

/** 每个用例独立服务（调度器桩行为不同）；返回 { stub calls, owner 的业务 } */
async function setup(behavior: "ok" | "not_found" | "running" = "ok") {
  const { scheduler, calls } = makeSchedulerStub(behavior);
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
    task_scheduler: scheduler,
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  owner = await createMemberAndLogin(server, adminToken, "owner");
  other = await createMemberAndLogin(server, adminToken, "other");
  const res = await api(server, "POST", "/api/businesses", {
    token: owner.token,
    body: { business_name: "定时任务业务", source: "manual", event_type: "" },
  });
  expect(res.status).toBe(201);
  const profile = res.body as BusinessProfile;
  return { calls, businessId: profile.business_id };
}

describe("GET /api/businesses/:id/scheduled-tasks", () => {
  it("200：任务清单 + 最近 run 状态（TaskView 形状）", async () => {
    const { businessId } = await setup();
    const res = await api(
      server,
      "GET",
      `/api/businesses/${businessId}/scheduled-tasks`,
      { token: other.token }, // 读不设限：登录即可
    );
    expect(res.status).toBe(200);
    const body = res.body as { tasks: TaskView[] };
    expect(body.tasks).toEqual([TASK_VIEW]);
    expect(body.tasks[0].last_run?.run_id).toBe(
      "run_0123456789ABCDEFGHJKMNPQRS",
    );
  });

  it("业务不存在 → 404", async () => {
    await setup();
    const res = await api(
      server,
      "GET",
      "/api/businesses/b_no_such/scheduled-tasks",
      { token: owner.token },
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });
});

describe("POST /api/businesses/:id/scheduled-tasks/:name/run", () => {
  it("202 { run_id }；参数映射 business_id/name/trigger=manual", async () => {
    const { calls, businessId } = await setup();
    const res = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/scheduled-tasks/warmup/run`,
      { token: owner.token },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ run_id: "run_0123456789ABCDEFGHJKMNPQRS" });
    expect(calls).toEqual([
      { business_id: businessId, task_name: "warmup", trigger: "manual" },
    ]);
  });

  it("业务不存在 → 404", async () => {
    await setup();
    const res = await api(
      server,
      "POST",
      "/api/businesses/b_no_such/scheduled-tasks/warmup/run",
      { token: owner.token },
    );
    expect(res.status).toBe(404);
  });

  it("任务不存在 → 404", async () => {
    const { businessId } = await setup("not_found");
    const res = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/scheduled-tasks/no-such/run`,
      { token: owner.token },
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("任务在跑 → 409", async () => {
    const { businessId } = await setup("running");
    const res = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/scheduled-tasks/warmup/run`,
      { token: owner.token },
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "conflict",
    );
  });

  it("非 creator 非 admin → 403；admin → 202", async () => {
    const { businessId } = await setup();
    const forbidden = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/scheduled-tasks/warmup/run`,
      { token: other.token },
    );
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { error: { code: string } }).error.code).toBe(
      "forbidden",
    );
    const allowed = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/scheduled-tasks/warmup/run`,
      { token: adminToken },
    );
    expect(allowed.status).toBe(202);
  });
});
