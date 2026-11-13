import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssetObject,
  AssetRegistry,
  ScheduledTaskDecl,
} from "@asteriskzuo/agent-asset-registry";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createBusinessRegistry } from "@asteriskzuo/agent-registry";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type {
  AgentService,
  RunningAgentService,
} from "@asteriskzuo/agent-service";
import type {
  RunOutcome,
  RunRequest,
  WorkflowRunner,
} from "@asteriskzuo/agent-workflow-runner";
import {
  createEnvProvider,
  createLifecycleStore,
  createRunMetricsStore,
  createTaskScheduler,
} from "../src/index.js";
import type {
  ContextLoader,
  EnvProvider,
  RunContext,
  TaskScheduler,
} from "../src/index.js";

let tmpDir: string;
let workspaceRoot: string;
let db: Database;
let registry: BusinessRegistry;
let env: EnvProvider;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runtime-task-scheduler-test-"));
  workspaceRoot = join(tmpDir, "workspace");
  db = openDatabase(":memory:");
  registry = createBusinessRegistry(db);
  env = createEnvProvider(db);
  initLogger({ logsDir: join(tmpDir, "logs"), enabled: false });
});

afterEach(() => {
  resetForTests();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const PKG_ASSET_ID = "ast_pkg1";
const TASK: ScheduledTaskDecl = {
  name: "warmup",
  program: "warmup",
  every_minutes: 60,
  timeout_minutes: 90,
};

/** 注入时钟：固定时刻（到期判定全按它推） */
const NOW = new Date("2026-11-13T08:00:00.000Z");

/** 轮询等待条件成立（tick 驱动为真定时器，小步等待） */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 造一个绑定包资产的业务，返回 business_id */
function createBusiness(over: Record<string, unknown> = {}): string {
  return registry.create({
    business_name: "定时任务业务",
    creator_id: "user-1",
    source: "manual",
    event_type: "",
    package_asset_id: PKG_ASSET_ID,
    entry_program: "main",
    ...over,
  });
}

/** 资产注册表 stub：list 空（PKG 非私有，credentialFor 短路）；get 返回带 scheduled_tasks 的包清单 */
function makeAssetsStub(
  tasks: ScheduledTaskDecl[] | undefined,
  opts: { getImpl?: () => AssetObject } = {},
): AssetRegistry {
  const manifest = {
    kind: "package" as const,
    name: "demo",
    programs: { main: "src/main.js", warmup: "src/warmup.js" },
    requires: { tools: [], skills: [] },
    ...(tasks !== undefined ? { scheduled_tasks: tasks } : {}),
  };
  const stub = {
    list: () => [],
    get: () => {
      if (opts.getImpl) return opts.getImpl();
      return {
        meta: { asset_id: PKG_ASSET_ID },
        manifest,
      } as AssetObject;
    },
  };
  return stub as unknown as AssetRegistry;
}

function makeRunContext(businessId: string): RunContext {
  return {
    business_id: businessId,
    channel_id: "",
    program: "/fake/main.js",
    programs: { main: "/fake/main.js", warmup: "/fake/warmup.js" },
    prompt: "",
    skills: [],
    model: "test/model",
    vars: {},
    secrets: {},
    quota: { timeout_minutes: 12, max_agent_calls: 3 },
  };
}

/** 结构 stub 三件套 + 调用记录仪；runner 可注入阻塞实现（in-flight/stop 用例） */
function makeStubs(
  businessId: string,
  over: {
    /** 包清单的 scheduled_tasks；null = 不声明该字段（区别于缺省 [TASK]） */
    tasks?: ScheduledTaskDecl[] | null;
    assetsImpl?: () => AssetObject;
    ctx?: RunContext;
    outcome?: RunOutcome;
    runImpl?: (req: RunRequest) => Promise<RunOutcome>;
  } = {},
) {
  const ctx = over.ctx ?? makeRunContext(businessId);
  const outcome: RunOutcome = over.outcome ?? {
    status: "success",
    output: { ok: 1 },
  };
  const recorder: {
    runArg?: RunRequest;
    loadArgs: Array<{ business_id: string; channel_id: string }>;
  } = { loadArgs: [] };
  const loader: ContextLoader = {
    load: (business_id, channel_id) => {
      recorder.loadArgs.push({ business_id, channel_id });
      return { ...ctx, business_id, channel_id };
    },
  };
  const agentService: AgentService = {
    serve: () => {
      const handle: RunningAgentService = {
        endpoint: { socket_path: "/tmp/fake-agent.sock", token: "tok-1" },
        close: () => Promise.resolve(),
      };
      return Promise.resolve(handle);
    },
  };
  const runner: WorkflowRunner = {
    run: (req) => {
      recorder.runArg = req;
      if (over.runImpl) return over.runImpl(req);
      return Promise.resolve(outcome);
    },
  };
  const assets = makeAssetsStub(
    over.tasks === null ? undefined : (over.tasks ?? [TASK]),
    {
      ...(over.assetsImpl !== undefined ? { getImpl: over.assetsImpl } : {}),
    },
  );
  const lifecycle = createLifecycleStore(db);
  const scheduler = createTaskScheduler({
    registry,
    assets,
    env,
    loader,
    runner,
    agentService,
    lifecycle,
    workspaceRoot,
    db,
    tickIntervalMs: 10,
    now: () => NOW,
  });
  return { scheduler, recorder, lifecycle };
}

/** 预插一条打标行（到期判定基准造数） */
function seedLifecycle(
  businessId: string,
  taskName: string,
  source: "cron" | "manual",
  createdAt: string,
  terminal: "success" | "failed" | "running" = "success",
): string {
  const store = createLifecycleStore(db);
  const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  store.markRunning({
    lifecycle_id: runId,
    business_id: businessId,
    event_id: "evt_seed",
    channel_id: `${source}__${taskName}__${businessId}`,
    created_at: createdAt,
  });
  if (terminal !== "running") {
    store.markTerminal(runId, terminal);
  }
  return runId;
}

describe("到期判定与 tick（D2）", () => {
  it("无记录 = 立即到期：tick 触发 run，合成事件形状与 cron channel_id 正确，main-only 透传", async () => {
    const businessId = createBusiness();
    const { scheduler, recorder, lifecycle } = makeStubs(businessId, {
      outcome: {
        status: "success",
        output: { repo: "sdk" },
        metrics: { fetched: 1, duration_ms: 1234 },
      },
    });
    scheduler.start();
    await waitFor(() => lifecycle.listByBusiness(businessId).length === 1);
    await scheduler.stop();

    const rows = lifecycle.listByBusiness(businessId);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe(`cron__warmup__${businessId}`);
    expect(rows[0].status).toBe("success");

    // 合成事件（D3）：source=cron、event_type=scheduled.<任务名>、session_id=任务名、
    // correlation_id = event_id、hop_count=0、payload 含 task_name/trigger
    const event = recorder.runArg!.event;
    expect(event.contract_version).toBe("v1");
    expect(event.source).toBe("cron");
    expect(event.event_id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.event_type).toBe("scheduled.warmup");
    expect(event.timestamp).toBe(NOW.toISOString());
    expect(event.session_id).toBe("warmup");
    expect(event.correlation_id).toBe(event.event_id);
    expect(event.hop_count).toBe(0);
    expect(event.payload).toEqual({ task_name: "warmup", trigger: "cron" });

    // main-only 透传 + 目录键 = cron/warmup
    expect(recorder.runArg!.phases).toBe("main-only");
    expect(recorder.runArg!.run_id).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(recorder.loadArgs[0].channel_id).toBe(`cron__warmup__${businessId}`);

    // metrics 落库（预热耗时等指标进统计）
    const metrics = createRunMetricsStore(db).listByRun(
      recorder.runArg!.run_id!,
    );
    expect(metrics).toEqual([
      { key: "duration_ms", value: 1234 },
      { key: "fetched", value: 1 },
    ]);
  });

  it("未到期（上次 run 在间隔内）→ tick 不发起新 run", async () => {
    const businessId = createBusiness();
    seedLifecycle(businessId, "warmup", "cron", NOW.toISOString());
    const { scheduler, lifecycle } = makeStubs(businessId);
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();
    expect(lifecycle.listByBusiness(businessId)).toHaveLength(1);
  });

  it("已超间隔 → tick 发起新 run", async () => {
    const businessId = createBusiness();
    seedLifecycle(
      businessId,
      "warmup",
      "cron",
      new Date(NOW.getTime() - 61 * 60_000).toISOString(),
    );
    const { scheduler, lifecycle } = makeStubs(businessId);
    scheduler.start();
    await waitFor(() => lifecycle.listByBusiness(businessId).length === 2);
    await scheduler.stop();
  });

  it("上次 run 仍 running（crash 残留）→ 跳过不堆积", async () => {
    const businessId = createBusiness();
    seedLifecycle(
      businessId,
      "warmup",
      "cron",
      new Date(NOW.getTime() - 61 * 60_000).toISOString(),
      "running",
    );
    const { scheduler, recorder, lifecycle } = makeStubs(businessId);
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();
    expect(lifecycle.listByBusiness(businessId)).toHaveLength(1);
    expect(recorder.runArg).toBeUndefined();
  });

  it("清单读取异常（凭据缺失）→ 跳过该业务、tick 存活；恢复后正常触发", async () => {
    const businessId = createBusiness();
    let broken = true;
    const { scheduler, lifecycle } = makeStubs(businessId, {
      assetsImpl: () => {
        if (broken) throw new Error("credential_required: repo_key");
        return {
          meta: { asset_id: PKG_ASSET_ID },
          manifest: {
            kind: "package",
            name: "demo",
            programs: { main: "src/main.js", warmup: "src/warmup.js" },
            requires: { tools: [], skills: [] },
            scheduled_tasks: [TASK],
          },
        } as AssetObject;
      },
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 异常期间：无 run、tick 未崩溃
    expect(lifecycle.listByBusiness(businessId)).toHaveLength(0);
    broken = false;
    await waitFor(() => lifecycle.listByBusiness(businessId).length === 1);
    await scheduler.stop();
  });
});

describe("手动触发（runNow）", () => {
  it("manual 通道与事件形状正确；手动执行刷新 cron 到期基准（IN 两 channel 查询）", async () => {
    const businessId = createBusiness();
    const { scheduler, recorder, lifecycle } = makeStubs(businessId);
    scheduler.start();
    const { run_id } = await scheduler.runNow(businessId, "warmup", "manual");
    expect(run_id).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    await waitFor(
      () =>
        lifecycle.listByBusiness(businessId).length === 1 &&
        lifecycle.listByBusiness(businessId)[0].status !== "running",
    );
    // 等数个 tick：manual 行也是到期基准，未达 60 分钟不再触发 cron
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();

    const rows = lifecycle.listByBusiness(businessId);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe(`manual__warmup__${businessId}`);
    expect(rows[0].status).toBe("success");
    const event = recorder.runArg!.event;
    expect(event.source).toBe("manual");
    expect(event.event_type).toBe("scheduled.warmup");
    expect(event.payload).toEqual({ task_name: "warmup", trigger: "manual" });
  });

  it("任务不存在 → scheduled_task_not_found；业务无包/无声明 → 同样 not_found", async () => {
    const businessId = createBusiness();
    const { scheduler } = makeStubs(businessId);
    await expect(
      scheduler.runNow(businessId, "no-such-task", "manual"),
    ).rejects.toThrow(/^scheduled_task_not_found:/);

    // 包清单无 scheduled_tasks 声明
    const bare = createBusiness({ business_name: "无声明业务" });
    const { scheduler: scheduler2 } = makeStubs(bare, { tasks: null });
    await expect(scheduler2.runNow(bare, "warmup", "manual")).rejects.toThrow(
      /^scheduled_task_not_found:/,
    );
  });

  it("in-flight 防重叠：同任务执行中再触发（runNow 与 tick 双路径）→ 不重叠", async () => {
    const businessId = createBusiness();
    let release: (() => void) | null = null;
    const { scheduler, lifecycle } = makeStubs(businessId, {
      runImpl: () =>
        new Promise<RunOutcome>((resolve) => {
          release = () => resolve({ status: "success", output: null });
        }),
    });
    scheduler.start();
    // tick 发起首个 run（阻塞中）
    await waitFor(() => lifecycle.listByBusiness(businessId).length === 1);
    // 路径一：runNow 同任务 → 409 语义错误
    await expect(
      scheduler.runNow(businessId, "warmup", "manual"),
    ).rejects.toThrow(/^scheduled_task_running:/);
    // 路径二：继续 tick 不再发起（仍 1 行）
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lifecycle.listByBusiness(businessId)).toHaveLength(1);
    release!();
    await scheduler.stop();
    expect(lifecycle.listByBusiness(businessId)).toHaveLength(1);
  });
});

describe("执行细节", () => {
  it("程序名未物化 → 打 failed（reason 含程序名）不抛穿", async () => {
    const businessId = createBusiness();
    const ctx = makeRunContext(businessId);
    ctx.programs = { main: "/fake/main.js" }; // warmup 未物化
    const { scheduler, lifecycle } = makeStubs(businessId, { ctx });
    scheduler.start();
    const { run_id } = await scheduler.runNow(businessId, "warmup", "manual");
    await scheduler.stop();
    const record = createLifecycleStore(db).get(run_id);
    expect(record?.status).toBe("failed");
    expect(record?.reason).toBe("定时任务程序未物化: warmup");
  });

  it("timeout_minutes 覆盖 quota 生效（runner 收到覆盖值）；未声明用上下文 quota", async () => {
    const businessId = createBusiness();
    const { scheduler, recorder } = makeStubs(businessId, {
      tasks: [{ ...TASK, timeout_minutes: 90 }],
    });
    await scheduler.runNow(businessId, "warmup", "manual");
    await scheduler.stop();
    expect(recorder.runArg!.quota).toEqual({ timeout_minutes: 90 });

    const businessId2 = createBusiness({ business_name: "缺省超时业务" });
    const noTimeout: ScheduledTaskDecl = {
      name: "warmup",
      program: "warmup",
      every_minutes: 60,
    };
    const { scheduler: scheduler2, recorder: recorder2 } = makeStubs(
      businessId2,
      { tasks: [noTimeout] },
    );
    await scheduler2.runNow(businessId2, "warmup", "manual");
    await scheduler2.stop();
    // 缺省 = 业务/全局 quota（makeRunContext 的 12）
    expect(recorder2.runArg!.quota).toEqual({ timeout_minutes: 12 });
  });

  it("stop() 等在飞任务落定（不打断执行中的 run）", async () => {
    const businessId = createBusiness();
    let release: (() => void) | null = null;
    const { scheduler, lifecycle } = makeStubs(businessId, {
      runImpl: () =>
        new Promise<RunOutcome>((resolve) => {
          release = () => resolve({ status: "success", output: null });
        }),
    });
    scheduler.start();
    await waitFor(() => lifecycle.listByBusiness(businessId).length === 1);

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });
    // 在飞未落定：stop 不返回（也不打断）
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopped).toBe(false);
    expect(lifecycle.listByBusiness(businessId)[0].status).toBe("running");
    release!();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(lifecycle.listByBusiness(businessId)[0].status).toBe("success");
  });
});

describe("describeTasks", () => {
  it("清单 + 最近 run 状态（TaskView 形状）；无 run 记录 → 无 last_run", async () => {
    const businessId = createBusiness();
    const seeded = seedLifecycle(
      businessId,
      "warmup",
      "cron",
      new Date(NOW.getTime() - 61 * 60_000).toISOString(),
      "failed",
    );
    const { scheduler } = makeStubs(businessId);
    const views = await scheduler.describeTasks(businessId);
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("warmup");
    expect(views[0].program).toBe("warmup");
    expect(views[0].every_minutes).toBe(60);
    expect(views[0].timeout_minutes).toBe(90);
    expect(views[0].last_run?.run_id).toBe(seeded);
    expect(views[0].last_run?.status).toBe("failed");
    expect(views[0].last_run?.finished_at).toBeDefined();

    // 无记录任务：last_run 缺省
    const bare = createBusiness({ business_name: "无记录业务" });
    const { scheduler: scheduler2 } = makeStubs(bare);
    const views2 = await scheduler2.describeTasks(bare);
    expect(views2).toHaveLength(1);
    expect(views2[0].last_run).toBeUndefined();
    expect("timeout_minutes" in views2[0]).toBe(true); // TASK 带 timeout_minutes
  });

  it("包无 scheduled_tasks 声明 / 业务未绑包 → 空数组", async () => {
    const businessId = createBusiness();
    const { scheduler } = makeStubs(businessId, { tasks: null });
    await expect(scheduler.describeTasks(businessId)).resolves.toEqual([]);

    const unbound = registry.create({
      business_name: "未绑包业务",
      creator_id: "user-1",
      source: "manual",
      event_type: "",
    });
    const { scheduler: scheduler2 } = makeStubs(unbound);
    await expect(scheduler2.describeTasks(unbound)).resolves.toEqual([]);
  });
});
