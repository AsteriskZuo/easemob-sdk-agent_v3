import type { Task } from "@asterisk/agent-queue";
import type { BusinessMatch, ExitBinding } from "@asterisk/agent-registry";

/** 平台运行参数：装配根从环境/设置读好后注入；本包不读 process.env */
export interface PlatformConfig {
  hop_limit: number; // 派生事件 hop_count 超此值 → 落库即死信（只判入口循环的扇出）
  task_concurrency: number; // 入口业务闸门
  result_concurrency: number; // 出口闸门
}

/** 执行结果（Lifecycle 的返回形状；本包只消费不生产） */
export interface ExecutionResult {
  status: "success" | "failed" | "timeout"; // 执行状态；timeout 在扇出时归 failed（event_type = xxx.failed）
  output: unknown; // 业务产出；派生事件的 payload（成功时）
  usage?: { tokens: number; duration_ms: number }; // 执行计量（可选）：仅留痕，不进任何判定
}

/** 入口执行器（注入）：一个 (任务, 关注者) 的一次完整业务执行。
 *  实现方负责：闸门通过后组装 BusinessContext → spawn 业务流程程序 → 返回结果。
 *  分钟级长调用。约定：业务失败应返回 {status:'failed'|'timeout'} 而非抛错；
 *  抛错 = 基础设施异常，本包按入口循环纪律兜底合成 failed。 */
export interface EntryDriver {
  /** 一个 (任务, 关注者) 的一次完整业务执行（分钟级长调用） */
  execute(task: Task, watcher: BusinessMatch): Promise<ExecutionResult>;
}

/** 出口执行器（注入）。实现方负责 ExitRegistry 取用、凭证解析、bind/deliver */
export interface ExitDriver {
  /** 投递目标标识（从绑定配置提取，纯函数）——出口 channel_id 的第二维 */
  destinationOf(binding: ExitBinding): string;
  /** 投递业务产出。失败抛错，由本包按有界重试处置 */
  deliver(binding: ExitBinding, payload: unknown): Promise<void>;
}

/** 实现期可调参数（均有默认值，测试注入小值） */
export interface SchedulerOptions {
  pollIntervalMs?: number; // 摄取空转轮询间隔，默认 50
  exitRetry?: {
    maxAttempts?: number; // 默认 3（含首次）
    baseDelayMs?: number; // 默认 1000
    maxDelayMs?: number; // 默认 10000；第 n 次重试前等待 min(base*2^(n-1), max)
  };
}

/** 循环句柄 */
export interface SchedulerLoop {
  start(): void; // 启动摄取循环与 drain 触发；幂等（重复调不重复启动）
  stop(): Promise<void>; // 优雅停：摄取循环退出 + 等在飞的 drain 消化完通道存量；不打断在飞的 execute/deliver
}
