import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildBusinessChannelId,
  newEventId,
  newUlid,
} from "@asteriskzuo/agent-contracts";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import type {
  AssetRegistry,
  ScheduledTaskDecl,
} from "@asteriskzuo/agent-asset-registry";
import type { Database } from "@asteriskzuo/agent-database";
import { logger } from "@asteriskzuo/agent-logger";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import { executeRun } from "@asteriskzuo/agent-run-core";
import type { RunGate } from "@asteriskzuo/agent-scheduler";
import type { AgentService } from "@asteriskzuo/agent-service";
import type { WorkflowRunner } from "@asteriskzuo/agent-workflow-runner";
import type { ContextLoader } from "./context-loader.js";
import type { EnvProvider } from "./env-provider.js";
import type { LifecycleStore, LifecycleWriter } from "./lifecycle-store.js";
import { createRunMetricsStore } from "./run-metrics-store.js";

/** 定时任务最近一次 run 视图（cron/manual 两通道取最新一条打标） */
export interface TaskLastRun {
  run_id: string;
  status: string;
  created_at: string;
  finished_at?: string;
  reason?: string;
}

/** 定时任务视图（console-api 列表数据源）：清单声明 + 最近 run 状态 */
export interface TaskView {
  name: string;
  program: string;
  every_minutes: number;
  timeout_minutes?: number;
  /** 最近一次 run（任意触发源）；无记录 = undefined（= 立即到期） */
  last_run?: TaskLastRun;
}

export interface TaskSchedulerDeps {
  registry: BusinessRegistry; // 枚举业务（list）与 profile（getProfile/package_asset_id）
  assets: AssetRegistry; // 读包清单 scheduled_tasks（凭据解析纪律同 context-loader：私有资产 secrets 优先 vars 兜底）
  env: EnvProvider; // 两桶配置：凭据解析用（复用 context-loader 的 credentialFor 模式）
  loader: ContextLoader; // 复用：定时 run 的 RunContext 与事件 run 同源（vars/secrets/skills/quota/pi 配置全一致）
  runner: WorkflowRunner; // 复用 executeRun 执行核
  agentService: AgentService; // 复用 executeRun 执行核
  lifecycle: LifecycleStore & LifecycleWriter; // 打标（createLifecycle 同款 store，bootstrap 另建实例即可）
  workspaceRoot: string; // 目录布局根（businesses/{bid}/ 下 runs/cache，与 lifecycle.ts 同构）
  db: Database; // 到期查询（lifecycles 表，零新表）
  gate?: RunGate; // updates 屏障；缺省直通
  tickIntervalMs?: number; // 到期扫描间隔，缺省 60_000；测试注入小值
  now?: () => Date; // 测试注入时钟
}

export interface TaskScheduler {
  /** 幂等：启动 tick 循环 */
  start(): void;
  /** 停 tick、等在飞任务落定（不打断执行中的 run） */
  stop(): Promise<void>;
  /** 手动立即执行一次（console-api 用）。成功返回 run_id（202 语义：发起即返回，执行在后台）；
   *  任务不存在抛 scheduled_task_not_found；同任务在跑抛 scheduled_task_running（调用方映射 409） */
  runNow(
    business_id: string,
    task_name: string,
    trigger: "manual",
  ): Promise<{ run_id: string }>;
  /** 任务清单 + 各自最近 run 状态（console-api 用）；业务不存在/包无声明 → 空数组 */
  describeTasks(business_id: string): Promise<TaskView[]>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** lifecycles 到期查询行（只取判定与展示所需列） */
interface LastRunRow {
  lifecycle_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  reason: string | null;
}

/** 创建定时任务调度器（spec 2026-11-13：平台第三条触发路径）。
 *  无事件、跳过 check 阶段（runner phases="main-only"）、不入队不扇出；
 *  到期状态复用 lifecycles 表（D2），并发纪律 = 同任务 in-flight 内存集合 + updates RunGate（D5） */
export function createTaskScheduler(deps: TaskSchedulerDeps): TaskScheduler {
  const log = logger.for({ module: "task-scheduler" });
  const gate: RunGate = deps.gate ?? { run: (_id, fn) => fn() };
  const tickIntervalMs = deps.tickIntervalMs ?? 60_000;
  const now = deps.now ?? (() => new Date());
  const runMetricsStore = createRunMetricsStore(deps.db); // 内部自建，与 createLifecycle 同款
  /** 同任务在飞集合（防重叠：上一次没跑完，tick/手动都不发起新的） */
  const inFlight = new Set<string>();
  /** 在飞执行 promise 集合：stop() 等全部落定（不打断执行中的 run） */
  const inFlightRuns = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const inFlightKey = (business_id: string, task_name: string): string =>
    `${business_id}/${task_name}`;

  /** 读业务包清单的 scheduled_tasks（读取方式与 context-loader 第 3 步同模式：
   *  遍历前快照 list({}) 元数据表 + get(id, credentialFor)；私有资产 secrets 优先 vars 兜底）。
   *  读取异常（如凭据缺失）原样上抛，调用方处置（tick = warn + 跳过该业务） */
  const readTasks = (business_id: string): ScheduledTaskDecl[] => {
    const profile = deps.registry.getProfile(business_id);
    if (profile?.package_asset_id === undefined) return [];
    const { vars, secrets } = deps.env.getFor(business_id);
    const metas = new Map(
      deps.assets.list({}).map((meta) => [meta.asset_id, meta]),
    );
    const meta = metas.get(profile.package_asset_id);
    const credential = ((): { credential: string } | undefined => {
      if (!meta?.is_private || !meta.credential_key) return undefined;
      const value = secrets[meta.credential_key] ?? vars[meta.credential_key];
      // 仍无 → 不传：asset-registry 自己抛 credential_required（原样上抛）
      return value !== undefined ? { credential: value } : undefined;
    })();
    const obj = deps.assets.get(profile.package_asset_id, credential);
    return obj.manifest.kind === "package"
      ? (obj.manifest.scheduled_tasks ?? [])
      : [];
  };

  /** 最近一次 run（D2：cron/manual 同任务两通道取最新一条；手动执行也刷新到期基准） */
  const lastRun = (
    business_id: string,
    task_name: string,
  ): LastRunRow | undefined =>
    deps.db.get<LastRunRow>(
      `SELECT lifecycle_id, status, created_at, finished_at, reason FROM lifecycles
       WHERE business_id = ? AND channel_id IN (?, ?)
       ORDER BY created_at DESC LIMIT 1`,
      [
        business_id,
        buildBusinessChannelId("cron", task_name, business_id),
        buildBusinessChannelId("manual", task_name, business_id),
      ],
    );

  /** 到期判定（D2）：无记录 = 到期；最近一次仍 running（crash 残留）= 跳过不堆积；
   *  否则 now ≥ 最近 created_at + every_minutes */
  const isDue = (business_id: string, decl: ScheduledTaskDecl): boolean => {
    const last = lastRun(business_id, decl.name);
    if (last === undefined) return true;
    if (last.status === "running") {
      log.warn("上次运行未完结（可能为 crash 残留），本次跳过", {
        business_id,
        task: decl.name,
        run_id: last.lifecycle_id,
      });
      return false;
    }
    const dueAt = Date.parse(last.created_at) + decl.every_minutes * 60_000;
    return now().getTime() >= dueAt;
  };

  /** 发起一次定时 run（D3 合成事件 + executeRun 执行核，与 lifecycle.execute 同构）。
   *  不扇出：无 queue、无派生事件。平台自身错误（runner 抛错）打标 failed 后原样上抛 */
  const execute = async (
    business_id: string,
    decl: ScheduledTaskDecl,
    trigger: "cron" | "manual",
    run_id: string,
  ): Promise<void> => {
    const source = trigger;
    const channel_id = buildBusinessChannelId(source, decl.name, business_id);
    const event_id = newEventId();
    // 合成事件（D3）：复用 EventSource 既有枚举；event_id 仅留痕，不入队不当幂等键
    const event: EventEnvelope = {
      contract_version: "v1",
      source,
      event_id,
      event_type: `scheduled.${decl.name}`,
      timestamp: now().toISOString(),
      session_id: decl.name,
      correlation_id: event_id,
      hop_count: 0,
      payload: { task_name: decl.name, trigger },
    };
    const runLog = logger.for({
      module: "task-scheduler",
      business_id,
      channel_id,
      run_id,
    });

    // 打标：一行插入即 running（created 是瞬时态，不落中间行）
    deps.lifecycle.markRunning({
      lifecycle_id: run_id,
      business_id,
      event_id,
      channel_id,
      created_at: now().toISOString(),
    });
    runLog.info("定时 run 开始", { task: decl.name, trigger });

    // 目录组齐（与 lifecycle.ts 布局同构：source/session 两级键换成 cron/manual + 任务名）；
    // 上下文组装失败 = 配置/基础设施问题：打标 failed 后原样抛错
    const businessRoot = join(deps.workspaceRoot, "businesses", business_id);
    const workspace = join(businessRoot, "runs", source, decl.name, run_id);
    const session_dir = join(
      businessRoot,
      "cache",
      "agent-sessions",
      source,
      decl.name,
    );
    const audit_log_path = join(workspace, "audit", "llm-requests.jsonl");
    const onSetupError = (err: unknown): void => {
      deps.lifecycle.markTerminal(
        run_id,
        "failed",
        undefined,
        errorMessage(err),
      );
      runLog.error("定时 run 失败：上下文组装或 serve 失败", {
        task: decl.name,
        error: errorMessage(err),
      });
    };

    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(session_dir, { recursive: true });
      mkdirSync(dirname(audit_log_path), { recursive: true });
    } catch (err) {
      onSetupError(err);
      throw err;
    }
    const ctx = (() => {
      try {
        return deps.loader.load(business_id, channel_id);
      } catch (err) {
        onSetupError(err);
        throw err;
      }
    })();

    // 程序名未物化：登记期已拦，运行期兜底——打 failed 并返回（不抛穿）
    const program = ctx.programs[decl.program];
    if (program === undefined) {
      const reason = `定时任务程序未物化: ${decl.program}`;
      deps.lifecycle.markTerminal(run_id, "failed", undefined, reason);
      runLog.error("定时 run 失败", { task: decl.name, error: reason });
      return;
    }

    const outcome = await executeRun(
      {
        context: {
          ...ctx,
          program,
          quota: {
            ...ctx.quota,
            ...(decl.timeout_minutes !== undefined
              ? { timeout_minutes: decl.timeout_minutes }
              : {}),
          },
        },
        event,
        run_id,
        workspace,
        session_dir,
        audit_log_path,
        // 定时 run 跳过契约探测与 check-input/check-output（D4：无事件契约可言）
        phases: "main-only",
      },
      { agentService: deps.agentService, runner: deps.runner },
      {
        onServeError: onSetupError,
        onRunnerError: (err) => {
          // runner 抛错 = 平台自身错误：close 前打标 failed 并记录日志
          deps.lifecycle.markTerminal(
            run_id,
            "failed",
            undefined,
            errorMessage(err),
          );
          runLog.error("定时 run 失败：runner 平台错误", {
            task: decl.name,
            error: errorMessage(err),
          });
        },
      },
    );

    // runner 返回 failed/timeout 不抛错（业务失败返回而非抛）
    deps.lifecycle.markTerminal(
      run_id,
      outcome.status,
      outcome.failed_at,
      outcome.reason,
    );
    // 业务 metrics 落库（fail-open 归 store 内部消化；预热耗时等指标进统计）
    if (
      outcome.metrics !== undefined &&
      Object.keys(outcome.metrics).length > 0
    ) {
      runMetricsStore.record(
        run_id,
        business_id,
        now().toISOString(),
        outcome.metrics,
      );
    }
    if (outcome.status === "success") {
      runLog.info("定时 run 终态", { task: decl.name, status: outcome.status });
    } else {
      runLog.warn("定时 run 终态", {
        task: decl.name,
        status: outcome.status,
        reason: outcome.reason,
        ...(outcome.failed_at !== undefined
          ? { failed_at: outcome.failed_at }
          : {}),
      });
    }
  };

  /** 发起一次执行（tick 与 runNow 共用）：in-flight 加入/移除用 finally；
   *  发起即返回 run_id（202 语义），执行在后台过 updates RunGate 屏障（D5） */
  const launch = (
    business_id: string,
    decl: ScheduledTaskDecl,
    trigger: "cron" | "manual",
  ): { run_id: string } => {
    const run_id = `run_${newUlid()}`;
    const key = inFlightKey(business_id, decl.name);
    inFlight.add(key);
    const promise: Promise<void> = gate
      .run(business_id, () => execute(business_id, decl, trigger, run_id))
      .catch((err: unknown) => {
        // 平台自身错误（execute 内已打 failed 标）：只记日志，绝不打穿 tick/调用方
        log.error("定时 run 平台错误", {
          business_id,
          task: decl.name,
          run_id,
          error: errorMessage(err),
        });
      })
      .finally(() => {
        inFlight.delete(key);
        inFlightRuns.delete(promise);
      });
    inFlightRuns.add(promise);
    return { run_id };
  };

  /** 单轮扫描：遍历业务 → 读清单 → 到期且不在飞 → 发起。
   *  任一业务/任务异常只 warn + 跳过，绝不让 tick 崩溃 */
  const tick = (): void => {
    for (const profile of deps.registry.list()) {
      const business_id = profile.business_id;
      let decls: ScheduledTaskDecl[];
      try {
        decls = readTasks(business_id);
      } catch (err) {
        log.warn("定时任务清单读取失败，跳过该业务", {
          business_id,
          error: errorMessage(err),
        });
        continue;
      }
      for (const decl of decls) {
        try {
          if (inFlight.has(inFlightKey(business_id, decl.name))) continue;
          if (!isDue(business_id, decl)) continue;
          launch(business_id, decl, "cron");
        } catch (err) {
          log.warn("定时任务到期处理失败，跳过该任务", {
            business_id,
            task: decl.name,
            error: errorMessage(err),
          });
        }
      }
    }
  };

  return {
    start(): void {
      if (timer !== null) return; // 幂等：重复调不重复启动
      timer = setInterval(tick, tickIntervalMs);
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // 等在飞任务落定（不打断执行中的 run；launch 内已 catch，promise 绝不 reject）
      await Promise.all([...inFlightRuns]);
    },

    async runNow(
      business_id: string,
      task_name: string,
      trigger: "manual",
    ): Promise<{ run_id: string }> {
      const decl = readTasks(business_id).find((d) => d.name === task_name);
      if (decl === undefined) {
        throw new Error(
          `scheduled_task_not_found: ${business_id}/${task_name}`,
        );
      }
      if (inFlight.has(inFlightKey(business_id, task_name))) {
        throw new Error(`scheduled_task_running: ${business_id}/${task_name}`);
      }
      return launch(business_id, decl, trigger);
    },

    describeTasks(business_id: string): Promise<TaskView[]> {
      const views = readTasks(business_id).map((decl): TaskView => {
        const last = lastRun(business_id, decl.name);
        return {
          name: decl.name,
          program: decl.program,
          every_minutes: decl.every_minutes,
          ...(decl.timeout_minutes !== undefined
            ? { timeout_minutes: decl.timeout_minutes }
            : {}),
          ...(last !== undefined
            ? {
                last_run: {
                  run_id: last.lifecycle_id,
                  status: last.status,
                  created_at: last.created_at,
                  ...(last.finished_at !== null
                    ? { finished_at: last.finished_at }
                    : {}),
                  ...(last.reason !== null ? { reason: last.reason } : {}),
                },
              }
            : {}),
        };
      });
      return Promise.resolve(views);
    },
  };
}
