import type { EventSource } from "@asteriskzuo/agent-contracts";
import type { ConfigField } from "@asteriskzuo/agent-exit-tools";
import type { TaskQueue } from "@asteriskzuo/agent-queue";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";

/** 入口适配器契约：每个事件源一个实现。
 *  职责链：验签 → 包装信封（含 session_id）→ 落队，立即返回（落库才算收到，event_id 兼任入口幂等键）。
 *  各入口自管理自己的监听资源（webhook 自起 HTTP 服务、jira-polling 自持定时器），
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
 *  日志由全局外观承担，故不在此列 */
export interface EntryDeps {
  /** 入口队列（落队是唯一本质动作；event_id 重复 → 幂等返回已有任务） */
  queue: TaskQueue;
  /** 业务注册表（入口配置 = match 行 entry_config 读取；平台不解析，消费方是本适配层） */
  registry: BusinessRegistry;
  /** 两桶环境配置（入口验签/登录凭据取 secrets 桶：env.getFor(business_id).secrets） */
  env: EnvProvider;
}

/** 入口适配器描述：控制台「看了就懂」的数据源自描述（控制台展示与 API 暴露用） */
export interface EntryAdapterSpec {
  /** 适配器唯一标识（如 'webhook' | 'jira-polling'），开关键按它派生：
   *  AGENT_ENTRY_{id 大写、'-' 转 '_'}_ENABLED */
  id: string;
  /** = 适配器产出事件的 source（'webhook' | 'jira' | ...）；
   *  多个适配器可共享同一 source（如 jira-polling 与将来的 jira-webhook 都是 'jira'） */
  kind: EventSource;
  /** 展示名（如「自定义 Webhook」「Jira 定时轮询」） */
  name: string;
  /** 缺省开关（jira-polling = false，其余 true）；装配根 config 键可覆盖 */
  defaultEnabled: boolean;
  /** entry_config 的字段声明（复用 exit-tools 的 ConfigField；控制台据此渲染表单） */
  configSchema: ConfigField[];
  /** markdown：事件类型清单 + payload 形状 + 示例 JSON（业务开发者对接依据） */
  eventDoc: string;
}

/** 适配器创建参数：装配根按适配器需要注入的运行参数（非 entry_config——那是业务级行配置）。
 *  全部可选；不适配某适配器的键被忽略 */
export interface EntryAdapterCreateOptions {
  /** webhook 适配器监听端口（来自 AGENT_WEBHOOK_PORT；缺省 6200，0 = 随机端口） */
  webhook_port?: number;
}

/** 适配器工厂：描述 + 运行实例创建。装配根按开关过滤后调 create 拿实例再 start */
export interface EntryAdapterFactory {
  /** 自描述元数据（控制台展示、开关键派生、entry_config 表单渲染） */
  spec: EntryAdapterSpec;
  /** 创建运行实例（未启动）；opts 为装配根注入的运行参数 */
  create(opts?: EntryAdapterCreateOptions): EntryAdapter;
}
