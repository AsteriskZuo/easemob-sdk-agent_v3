import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBusinessChannelId, newUlid } from "@easemob/agent-contracts";
import type { Database } from "@easemob/agent-database";
import { logger } from "@easemob/agent-logger";
import type { AgentService, RunningAgentService } from "@easemob/agent-service";
import type {
  RunOutcome,
  WorkflowRunner,
} from "@easemob/agent-workflow-runner";
import type { EntryDriver } from "@easemob/agent-scheduler";
import type { ContextLoader, RunContext } from "./context-loader.js";
import { createLifecycleStore } from "./lifecycle-store.js";

export interface LifecycleDeps {
  loader: ContextLoader; // 第①步：组装 RunContext
  runner: WorkflowRunner; // 第③步：spawn 业务流程程序
  agentService: AgentService; // 第②/④步：per-run socket 服务（serve / close）
  workspaceRoot: string; // 平台工作目录 {workspace}（其下 runs/ cache/ logs/ 布局与 runner 对齐）
  db: Database; // 打标表（lifecycles，迁移 module 'runtime'）
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

      // 路径组齐（与 runner 的三维布局对齐）；步骤 1–4 失败 = 配置/基础设施问题：
      // 打标 failed 后原样抛错（归 scheduler 兜底合成 failed + error 日志）
      const workspace = join(
        deps.workspaceRoot,
        "runs",
        source,
        session_id,
        business_id,
        run_id,
      );
      const session_dir = join(
        deps.workspaceRoot,
        "cache",
        "agent-sessions",
        source,
        session_id,
        business_id,
      );
      const audit_log_path = join(workspace, "audit", "llm-requests.jsonl");
      let ctx: RunContext;
      let handle: RunningAgentService;
      try {
        mkdirSync(workspace, { recursive: true });
        mkdirSync(session_dir, { recursive: true });
        mkdirSync(dirname(audit_log_path), { recursive: true }); // serve 内还会兜底
        // ① 组装静态上下文（此时尚无 endpoint）
        ctx = deps.loader.load(business_id, channel_id);
        // ② per-run socket 服务：监听就绪后返回 endpoint
        handle = await deps.agentService.serve({
          run_id,
          channel_id,
          workspace,
          prompt: ctx.prompt,
          skills: ctx.skills,
          model: ctx.model,
          session_dir,
          audit_log_path,
          quota: { max_agent_calls: ctx.quota.max_agent_calls },
        });
      } catch (err) {
        store.markTerminal(run_id, "failed");
        log.error("run 失败：上下文组装或 serve 失败", {
          event_id: task.event.event_id,
          error: errorMessage(err),
        });
        throw err;
      }

      // ③ 执行业务流程程序（endpoint 注入）；close 必须无条件执行（含 runner 抛错路径）
      let outcome: RunOutcome;
      try {
        outcome = await deps.runner.run({
          program: ctx.program,
          event: task.event,
          business_id,
          config: ctx.vars,
          secrets: ctx.secrets,
          endpoint: handle.endpoint,
          quota: { timeout_minutes: ctx.quota.timeout_minutes },
          run_id,
        });
      } catch (err) {
        // runner 抛错 = 平台自身错误：打标 failed → 原样抛
        store.markTerminal(run_id, "failed");
        log.error("run 失败：runner 平台错误", {
          event_id: task.event.event_id,
          error: errorMessage(err),
        });
        throw err;
      } finally {
        // ④ 进程退出后 serve 关闭（杀在飞 pi、删 socket、token 失效）
        await handle.close();
      }

      // runner 返回 failed/timeout 不抛错（EntryDriver 契约：业务失败返回而非抛）
      store.markTerminal(run_id, outcome.status);
      if (outcome.status === "success") {
        log.info("run 终态", { status: outcome.status });
      } else {
        log.warn("run 终态", {
          status: outcome.status,
          reason: outcome.reason,
        });
      }
      return { status: outcome.status, output: outcome.output }; // usage 暂不填
    },
  };
}
