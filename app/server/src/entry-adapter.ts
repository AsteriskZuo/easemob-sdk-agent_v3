import type { EventSource } from "@asterisk/agent-contracts";
import type { TaskQueue } from "@asterisk/agent-queue";
import type { BusinessRegistry } from "@asterisk/agent-registry";
import type { EnvProvider } from "@asterisk/agent-runtime";

/** 入口适配器契约：每个事件源一个实现（T18 webhook 起，后续 wecom/jira/github/cron/manual 各归其任务）。
 *  职责链：验签 → 包装信封（含 session_id）→ 落队，立即返回（落库才算收到，event_id 兼任入口幂等键）。
 *  各入口自管理自己的监听资源（webhook 自起 HTTP 服务、企微自持 SDK 连接、cron 自持定时器），
 *  装配根只管注入依赖与调 start/stop */
export interface EntryAdapter {
  /** 本适配器负责的事件来源 */
  readonly source: EventSource;
  /** 装配根在循环启动后调用；deps 为装配产物（入口与内部模块共用同一套公开接口） */
  start(deps: EntryDeps): void;
  /** 优雅停（停止接收、释放监听资源）；幂等 */
  stop(): Promise<void>;
}

/** 装配根注入给入口适配器的依赖（装配产物子集）。
 *  id 生成与时间戳由 contracts 纯函数（newEventId）与 new Date().toISOString() 承担，
 *  日志由全局外观承担，故不在此列（决策点 1） */
export interface EntryDeps {
  /** 入口队列（落队是唯一本质动作） */
  queue: TaskQueue;
  /** 业务注册表（入口配置 = match 行 entry_config 读取；平台不解析，消费方是本适配层） */
  registry: BusinessRegistry;
  /** 两桶环境配置（入口验签凭据取 secrets 桶） */
  env: EnvProvider;
}
