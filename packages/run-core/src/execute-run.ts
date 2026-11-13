import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import type {
  AgentService,
  RunningAgentService,
} from "@asteriskzuo/agent-service";
import type {
  RunOutcome,
  WorkflowRunner,
} from "@asteriskzuo/agent-workflow-runner";
import type { RunContext } from "./context.js";

export interface ExecuteRunRequest {
  /** 已装配完成的运行上下文；执行核不再查询注册表或本地资产。 */
  context: RunContext;

  /** 已校验的完整业务事件；原样传给 WorkflowRunner。 */
  event: EventEnvelope;

  /** 调用方生成的 run_ + 26 位 ULID；同一次执行不得重新生成。 */
  run_id: string;

  /** 已创建的 run 工作目录绝对路径，同时供 Pi 与业务进程使用。 */
  workspace: string;

  /** 已创建的通道级 Agent 会话目录绝对路径。 */
  session_dir: string;

  /** run 级模型请求审计文件绝对路径；父目录由调用方创建。 */
  audit_log_path: string;
}

export interface ExecuteRunDeps {
  /** 每 run 启动并关闭 per-run socket 服务。 */
  agentService: AgentService;

  /** 执行 check-input → main → check-output 的共享 WorkflowRunner。 */
  runner: WorkflowRunner;
}

export interface ExecuteRunHooks {
  /** serve 失败时同步调用；用于平台状态与日志，不替代原错误上抛。 */
  onServeError?(error: unknown): void;

  /** runner 抛错时、close 前同步调用；业务 failed/timeout 返回值不触发。 */
  onRunnerError?(error: unknown): void;
}

/** 平台无关的单次 run 执行核：serve → runner → finally close。 */
export async function executeRun(
  request: ExecuteRunRequest,
  deps: ExecuteRunDeps,
  hooks?: ExecuteRunHooks,
): Promise<RunOutcome> {
  const { context } = request;
  let handle: RunningAgentService;
  try {
    handle = await deps.agentService.serve({
      run_id: request.run_id,
      channel_id: context.channel_id,
      workspace: request.workspace,
      prompt: context.prompt,
      skills: context.skills,
      model: context.model,
      session_dir: request.session_dir,
      audit_log_path: request.audit_log_path,
      quota: { max_agent_calls: context.quota.max_agent_calls },
      ...(context.pi_agent_dir !== undefined
        ? { pi_agent_dir: context.pi_agent_dir }
        : {}),
      // pi 内置工具白名单：声明时透传给 serve（装配 --tools + 路径守卫）；缺省不带 = --no-tools
      ...(context.pi_tools !== undefined ? { pi_tools: context.pi_tools } : {}),
    });
  } catch (error) {
    hooks?.onServeError?.(error);
    throw error;
  }

  try {
    try {
      return await deps.runner.run({
        program: context.program,
        programs: context.programs,
        event: request.event,
        business_id: context.business_id,
        config: context.vars,
        secrets: context.secrets,
        endpoint: handle.endpoint,
        quota: { timeout_minutes: context.quota.timeout_minutes },
        run_id: request.run_id,
      });
    } catch (error) {
      hooks?.onRunnerError?.(error);
      throw error;
    }
  } finally {
    await handle.close();
  }
}
