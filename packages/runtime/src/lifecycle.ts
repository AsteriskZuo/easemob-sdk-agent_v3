import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBusinessChannelId, newUlid } from "@asteriskzuo/agent-contracts";
import type { Database } from "@asteriskzuo/agent-database";
import { logger } from "@asteriskzuo/agent-logger";
import { executeRun } from "@asteriskzuo/agent-run-core";
import type { AgentService } from "@asteriskzuo/agent-service";
import type { WorkflowRunner } from "@asteriskzuo/agent-workflow-runner";
import type { EntryDriver } from "@asteriskzuo/agent-scheduler";
import type { ContextLoader, RunContext } from "./context-loader.js";
import { createLifecycleStore } from "./lifecycle-store.js";
import { createRunMetricsStore } from "./run-metrics-store.js";

export interface LifecycleDeps {
  loader: ContextLoader; // 第①步：组装 RunContext
  runner: WorkflowRunner; // 第③步：spawn 业务流程程序
  agentService: AgentService; // 第②/④步：per-run socket 服务（serve / close）
  workspaceRoot: string; // 平台工作目录 {workspace}（业务三类在 businesses/{business_id}/ 下，布局与 runner 对齐）
  db: Database; // 打标表（lifecycles，迁移 module 'runtime'）
  /** 上下文快照调试开关（AGENT_CONTEXT_SNAPSHOT，装配根注入；缺省 = 关）：
   *  开启时 load 成功后把 RunContext 落盘 {businessRoot}/logs/context-snapshots/{run_id}.json，
   *  供本地运行上下文 diff 作基准；写失败仅 warn，不影响 run */
  contextSnapshotEnabled?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 创建 Lifecycle：实现 scheduler 的 EntryDriver 契约（结构对齐，显式 import type 标注）。
 *  四步时序：① ContextLoader 组装静态上下文 → ② AgentService.serve 得 endpoint →
 *  ③ WorkflowRunner.run（endpoint 注入）→ ④ serve 关闭、结果出炉；
 *  业务标记（created → running → success/failed/timeout）全程落库 */
export function createLifecycle(deps: LifecycleDeps): EntryDriver {
  const store = createLifecycleStore(deps.db);
  const runMetricsStore = createRunMetricsStore(deps.db);

  return {
    async execute(task, watcher) {
      const business_id = watcher.business_id;
      const source = task.event.source;
      const session_id = task.event.session_id;
      const channel_id = buildBusinessChannelId(
        source,
        session_id,
        business_id,
      );
      const run_id = `run_${newUlid()}`;
      const log = logger.for({
        module: "entry-loop",
        business_id,
        channel_id,
        run_id,
      });

      // 打标：一行插入即 running（created 是瞬时态，不落中间行）
      store.markRunning({
        lifecycle_id: run_id,
        business_id,
        event_id: task.event.event_id,
        channel_id,
        created_at: new Date().toISOString(),
      });
      log.info("run 开始", { event_id: task.event.event_id });

      // 路径组齐（与 runner 的业务根布局对齐：businesses/{business_id}/ 下分 runs/cache/data/logs）；
      // 步骤 1–4 失败 = 配置/基础设施问题：
      // 打标 failed 后原样抛错（归 scheduler 兜底合成 failed + error 日志）
      const businessRoot = join(deps.workspaceRoot, "businesses", business_id);
      const workspace = join(businessRoot, "runs", source, session_id, run_id);
      const session_dir = join(
        businessRoot,
        "cache",
        "agent-sessions",
        source,
        session_id,
      );
      const audit_log_path = join(workspace, "audit", "llm-requests.jsonl");
      const onSetupError = (err: unknown): void => {
        store.markTerminal(run_id, "failed");
        log.error("run 失败：上下文组装或 serve 失败", {
          event_id: task.event.event_id,
          error: errorMessage(err),
        });
      };

      let ctx: RunContext;
      try {
        mkdirSync(workspace, { recursive: true });
        mkdirSync(session_dir, { recursive: true });
        mkdirSync(dirname(audit_log_path), { recursive: true }); // serve 内还会兜底
        // ① 组装静态上下文（此时尚无 endpoint）
        ctx = deps.loader.load(business_id, channel_id);
      } catch (err) {
        onSetupError(err);
        throw err;
      }

      // 上下文快照调试钩子（默认关）：load 成功后落盘 RunContext 供本地运行 diff 基准；
      // 独立 try/catch——写失败只 warn，绝不改变 run 行为
      if (deps.contextSnapshotEnabled === true) {
        try {
          const snapshotPath = join(
            businessRoot,
            "logs",
            "context-snapshots",
            `${run_id}.json`,
          );
          mkdirSync(dirname(snapshotPath), { recursive: true });
          writeFileSync(snapshotPath, JSON.stringify(ctx, null, 2));
        } catch (err) {
          log.warn("上下文快照写入失败（忽略，不影响本次 run）", {
            error: errorMessage(err),
          });
        }
      }

      // ②–④ 共用平台无关执行核；hook 只接入平台状态与日志，不改变错误语义。
      const outcome = await executeRun(
        {
          context: ctx,
          event: task.event,
          run_id,
          workspace,
          session_dir,
          audit_log_path,
        },
        { agentService: deps.agentService, runner: deps.runner },
        {
          onServeError: onSetupError,
          onRunnerError: (err) => {
            // runner 抛错 = 平台自身错误：close 前打标 failed 并记录日志。
            store.markTerminal(run_id, "failed");
            log.error("run 失败：runner 平台错误", {
              event_id: task.event.event_id,
              error: errorMessage(err),
            });
          },
        },
      );

      // runner 返回 failed/timeout 不抛错（EntryDriver 契约：业务失败返回而非抛）
      store.markTerminal(run_id, outcome.status, outcome.failed_at);
      // 业务 metrics 落库（契约 D：仅 success 且形状合法时 outcome.metrics 有值）；
      // fail-open 归 store 内部消化，调用点不包 try/catch
      if (
        outcome.metrics !== undefined &&
        Object.keys(outcome.metrics).length > 0
      ) {
        runMetricsStore.record(
          run_id,
          business_id,
          new Date().toISOString(),
          outcome.metrics,
        );
      }
      if (outcome.status === "success") {
        log.info("run 终态", {
          status: outcome.status,
          event_id: task.event.event_id,
        });
      } else {
        log.warn("run 终态", {
          status: outcome.status,
          reason: outcome.reason,
          ...(outcome.failed_at !== undefined
            ? { failed_at: outcome.failed_at }
            : {}),
          event_id: task.event.event_id,
        });
      }
      return { status: outcome.status, output: outcome.output }; // usage 暂不填
    },
  };
}
