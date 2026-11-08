import type { SkillRef } from "@asteriskzuo/agent-service";

/** 已装配完成的单次 run 上下文；平台与本地装配方共用同一契约。 */
export interface RunContext {
  /** 当前业务标识；由上下文装配方提供，并传给 WorkflowRunner。 */
  business_id: string;

  /** 业务通道标识；AgentService 用作会话映射键。 */
  channel_id: string;

  /** 主业务程序入口 JS 的绝对路径。 */
  program: string;

  /** 程序名到可执行 JS 绝对路径的完整映射，含 main、check 与工具。 */
  programs: Record<string, string>;

  /** 业务提示词总纲；允许空字符串，由 AgentService 原样消费。 */
  prompt: string;

  /** 当前 run 可使用的 skill 白名单，路径由装配方完成解析。 */
  skills: SkillRef[];

  /** 默认模型 provider/id；空字符串表示未配置模型。 */
  model: string;

  /** 含生效 models.json 的 Pi 配置目录；undefined 表示未配置模型。 */
  pi_agent_dir?: string;

  /** 注入业务进程的非机密配置。 */
  vars: Record<string, string>;

  /** 注入业务进程的机密配置；执行核不得记录其值。 */
  secrets: Record<string, string>;

  /** main 超时分钟数与每 run agent 调用上限。 */
  quota: { timeout_minutes: number; max_agent_calls: number };
}
