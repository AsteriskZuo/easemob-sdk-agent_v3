# 调度循环契约

> 日期：2026-09-15（2026-09-26 修订：双循环、结果扇出、出口契约；移除 ResultDisposition。2026-09-27 修订：代码即流程——BusinessContext 面向流程程序 + agent 服务，Lifecycle = spawn 业务流程程序）
> 状态：定稿
> 范围：**只覆盖两个调度循环（入口事件循环 / 出口事件循环）直接使用的契约**。入口内部、业务语义去重（后续单独设计）、控制台 UI、日志接口不在本文档。
> 依据：`design/glossary.md`、`design/scheduler.md`、`design/processing-chain.md`、`design/lifecycle.md`、`design/event-contract.md`（v1）、`design/channel-model.md`。
> 定位：调度循环就是这些契约的串联（见 §9）。

---

## 1. 事件（Event）

循环的输入。TS 镜像 `design/event-contract.md` v1，字段语义以该文档为准，此处不重复解释。

```ts
/** 事件信封，契约 v1。唯一权威定义见 design/event-contract.md */
interface Event {
  contract_version: 'v1';
  event_id: string;        // 全局唯一锚点；执行实例的第四维（追溯/幂等/日志），不参与串行判定
  source: EventSource;     // 入口写入；新来源 = 枚举新增
  event_type: string;      // 关注匹配的键（定义见 glossary 事件类型词条）
  timestamp: string;       // ISO 8601 带时区，入口包装时间
  session_id: string;      // 必填；源生会话标识，入口按来源规则提取（design/channel-model.md §4）
  correlation_id: string;  // 首个任务的 event_id，派生继承
  hop_count: number;       // 派生 +1，超阈值进死信（只管入口事件循环；出口循环不派生）
  payload: unknown;        // 来源自定义；大产物走引用。派生事件的 payload = 业务产出，出口循环投递的就是它
  producer_business_id?: string; // 可选，仅 internal 派生事件填写 = 产出方业务 id；
                                 // 出口事件循环的归属匹配键（不从 event_type 字符串解析）
}

type EventSource = 'wecom' | 'jira' | 'github' | 'webhook' | 'cron' | 'manual' | 'internal';

/** 通道标识。业务通道 = source__session_id__business_id（三维，双下划线）；
 *  出口通道 = exit__destination_id（destination_id 由出口工具从绑定配置提取）。
 *  同通道串行，跨通道并行。唯一定义见 glossary 通道词条 */
type ChannelId = string;
```

**webhook 来源**：内置通用 webhook 入口——接收任意外部系统的 HTTP 推送（平台可以是别家的中间组件：入口收 webhook、出口发 webhook）；session_id 由入口配置指定从 payload 提取的字段，未配置则以业务标识兜底（业务级串行，见 `design/channel-model.md` §4）。

**event_type 契约约束**：概念定义（类别标签、匹配键、与 event_id 的区别）见 `design/glossary.md` 事件类型词条——唯一定义处；此处只列契约约束：

- 自定义字段，由业务创建者/管理者确定，**一旦创建不可修改**；
- **全平台唯一**，不得与现有标识符冲突；名字要有意义；
- internal 事件：`对象.动作` = `业务id.产出类型`（如 `b01J8xk.review.completed`），业务创建时声明产出类型，供下游关注；**依赖关系的唯一表达方式 = 关注上游的产出事件类型**（见 `design/processing-chain.md` §2）。

---

## 2. 任务队列（TaskQueue）

循环的摄取口。**平台有两条队列——入口队列与出口队列，共用本契约、两个实例**。事件进来即持久化；取出不删、完结才标记，崩溃可恢复。

```ts
/** 队列中的任务 = 事件 + 消化状态 */
interface Task {
  task_id: string;
  event: Event;
  status: TaskStatus;
  enqueued_at: string;   // ISO 8601
  finished_at?: string;
}

type TaskStatus = 'pending' | 'processing' | 'done' | 'dead';

interface TaskQueue {
  /** 入口侧/扇出侧调用：校验之后落库，落库才算收到 */
  enqueue(event: Event): Task;

  /** 心脏调用：FIFO 取下一个 pending，置为 processing。无任务时阻塞/空转由实现定 */
  take(): Task | null;

  /** 消化完结：全部关注者执行完结后触发（含"无关注者/无出口绑定"的正常完结）；按 task 计数 */
  complete(task_id: string): void;

  /** 死信：hop_count 超阈值、投递重试耗尽等不可消化情形，告警由调用方触发 */
  deadLetter(task_id: string, reason: string): void;

  /** 控制台查询面（最小集，按需增补） */
  query(filter: TaskFilter): Task[];
}

interface TaskFilter {
  status?: TaskStatus;
  event_id?: string;
  correlation_id?: string;
}
```

---

## 3. 业务注册表（BusinessRegistry）与处理链（ProcessingChain）

**匹配只用轻数据**——控制台预先设置的匹配字段，不含任何执行所需的重组件。匹配不上（无关注者 / 未识别来源 / 无出口绑定）→ `complete` + 日志，不进入链。

```ts
/** 业务注册表：匹配视图 + 业务配置（含出口绑定）的统一读写口。
 *  原则：业务配置在控制台设置、数据库保存，
 *  查询与修改只有这一个接口，内部模块与控制台共用，没有第二套。 */
interface BusinessRegistry {
  /** 入口循环匹配：返回关注 (source, event_type) 的业务匹配视图（关注者集合，无顺序语义） */
  match(source: EventSource, event_type: string): BusinessMatch[];

  /** 出口循环匹配：返回产出方业务的全部出口绑定（归属匹配；空集 = 丢弃，无害） */
  exitBindings(business_id: string): ExitBinding[];

  /** 业务配置读写：控制台与内部同一个接口。
   *  一个业务 = 其全部匹配行（一对多：多入口/多关注时每个 (source, event_type) 一行，
   *  常规一行）；行业务级字段（business_id/name/creator_id/on_failure/出口绑定）各行一致 */
  get(business_id: string): BusinessMatch[];
  /** 更新业务级字段（business_name / on_failure / 出口绑定等）；
   *  匹配行的增删不用 patch——新增入口/关注 = 新增一行，取消 = 删除一行 */
  update(business_id: string, patch: Partial<BusinessMatch>): void;
}

/** 匹配视图：注册表执行视图的一行，常驻内存。
 *  业务与匹配行一对多：一个业务可配多个入口（每个 (source, event_type) 组合一行，
 *  channel-model §5）；常规场景一个业务一行 */
interface BusinessMatch {
  business_id: string;        // 业务 id：创建时自动生成、不可修改，一切内部引用的锚
  business_name: string;      // 展示名：用户设置、可修改；不参与任何匹配与引用
  creator_id: string;         // 创建者：业务设置的权限归属判定（见设置模块契约）
  source: EventSource;        // 关注的来源
  event_type: string;         // 关注的事件类型（依赖关系由此表达：关注上游的产出类型）
  on_failure?: boolean;       // 失败也扇出（派生事件带失败状态，下游门禁验收）；
                              // 默认 false = 失败不扇出：下游天然不触发、出口无投递
  // 无 order / depends_on / gate 字段：链内并行（glossary 处理链词条）；
  // 顺序靠事件订阅表达，门禁/检查由业务流程程序内部完成（glossary 门禁词条）
}

/** 处理链 = 一个事件的关注者集合；链内并行消化——每个关注者按自己的 channel_id 挂通道。
 *  入口循环的关注者 = BusinessMatch；出口循环的关注者 = ExitBinding（§6） */
type ProcessingChain = BusinessMatch[];
```

---

## 4. 业务上下文（BusinessContext）

**仅入口事件循环**——出口循环没有 BusinessContext（出口绑定配置即投递所需的全部）。匹配成功、通道轮到、闸门通过之后才组装。各成员只给最小视图——循环只需要"能执行任务"的形状，成员自身的完整设计各归其文档。

```ts
/** 可执行任务的完整上下文 = 业务资料 + 环境配置 + 运行端点 + 配额。
 *  两个消费方：流程执行器注入业务进程（env/workspace/endpoint）；
 *  agent 调用服务执行 sdk.agent()（prompt/skills/model/channel/quota） */
interface BusinessContext {
  business_id: string;
  prompt: PromptObject;       // 总纲：agent 调用时由平台注入，业务代码无需传入
  skills: SkillObject[];      // 本业务选用的 skill：sdk.agent() 的白名单校验依据
  agent: AgentCliObject;      // agent 内核引用 + 配置（MVP 仅 pi）
  model: ModelObject;         // 大模型选择
  env: EnvConfig;             // 普通/安全两桶 key-value，按业务隔离注入业务进程
  channel: ChannelRef;        // 通道映射引用：agent 服务据此恢复/绑定会话
  workspace: string;          // run 隔离目录 runs/{source}/{session_id}/{business_id}/{run_id}/
  endpoint: ServiceEndpoint;  // agent 调用服务端点：unix socket + 一次性 token
  quota: RunQuota;            // 按 run 计：agent 调用次数上限 + wall-clock 超时
}

/** 提示词对象（大纲）。循环只透传，不解析 */
interface PromptObject {
  content: string;
}

/** skill 最小视图（完整模型见 design/asset-model.md §5.2/§6） */
interface SkillObject {
  skill_id: string;           // 所属 skill 资产的 asset_id + 资产内路径（名解析规则见 asset-model §6）
  name: string;               // sdk.agent 请求里的引用名（白名单校验键；= 集合内目录名）
  path: string;               // 物化后的 skill 目录绝对路径：agent 调用时经 --skill 白名单注入（机制见 asset-model §10）
}

/** agent 内核最小视图（pi 为唯一内核，见 design/lifecycle.md §5） */
interface AgentCliObject {
  kind: 'pi';                 // MVP 仅 pi；新内核 = 枚举新增 + 调研决策
  config: Record<string, unknown>;
}

/** 大模型最小视图 */
interface ModelObject {
  name: string;               // provider/id 形式（如 'qwen/qwen3.8max'）；可选集合 = 部署侧
                              // models.json 解析所得（console-design §4），平台代码不内置具体模型名
  params?: Record<string, unknown>;
}

/** 环境配置对象：控制台 key-value 的运行时读取面——普通/安全两桶（github/jira 等账号凭证本质也是 key-value，不设第三类） */
interface EnvConfig {
  vars: Record<string, string>;          // 普通桶：环境变量
  secrets: Record<string, string>;       // 安全桶：运行时注入，不落盘不进日志
}

/** 通道映射引用（四操作归通道模块，循环只持有引用并注入 agent 调用） */
interface ChannelRef {
  channel_id: ChannelId;      // 业务通道：同通道上下文连续的唯一依据
  agent_session_id?: string;  // 首次执行为空，由首次执行建立并绑定
}

/** agent 调用服务端点：每 run 一个 unix socket + 一次性 token，run 结束失效 */
interface ServiceEndpoint {
  socket_path: string;
  token: string;
}

/** run 配额：防失控循环的机械防线（design/business-workflow.md §6） */
interface RunQuota {
  max_agent_calls: number;
  timeout_minutes: number;    // 业务配置优先，缺省取全局 task_timeout_minutes（60）
}
```

---

## 5. 执行（Lifecycle）与结果扇出

生命周期 = 一次完整执行，跑完即销毁。平台视角一次性；调用几次大模型是业务内部细节。

```ts
/** 业务标记：生命周期状态机的控制台投影，与生命周期状态同内容两视角 */
type LifecycleStatus = 'created' | 'running' | 'success' | 'failed' | 'timeout';

interface Lifecycle {
  lifecycle_id: string;
  business_id: string;
  status: LifecycleStatus;

  /** 单次执行 = spawn 业务流程程序（子进程契约：stdin 信封+上下文 / stdout 唯一结果 /
   *  进程退出即完结；design/business-workflow.md §2）。分钟级长耗时，必须 await。
   *  失败语义：程序内任一步失败 = 整体 failed，不重跑（business-workflow §6） */
  run(event: Event, context: BusinessContext): Promise<ExecutionResult>;
}

interface ExecutionResult {
  status: Extract<LifecycleStatus, 'success' | 'failed' | 'timeout'>;
  output: unknown;            // 业务产出；大产物走引用；出口投递的就是它
  usage?: { tokens: number; duration_ms: number };
}

/** 结果扇出：业务完结即派生——成功，或失败且 on_failure=true。
 *  同一份派生事件无脑投入口队列与出口队列，各循环自行过滤：
 *  入口队列无关注者则丢弃，出口队列无出口绑定则丢弃，互不影响。
 *  派生事件：hop_count+1、correlation_id 继承、source='internal'、
 *  session_id 继承上游源生标识、producer_business_id=产出方业务 id、
 *  event_type=业务id.产出类型（channel-model §4.1、glossary event_type 词条） */

/** 门禁/检查：不设平台契约、没有平台挂接点——它们是业务流程程序内部的环节，
 *  业务代码实现（唯一定义见 design/glossary.md 门禁词条；机制见 business-workflow §5）。
 *  验收未通过 = 本次执行 failed（输入未就绪），不扇出、下游自然不触发 */
```

---

## 6. 出口（ExitTool / Exit / ExitBinding / ExitRegistry）

出口事件循环的执行单元。**出口工具是平台内置模块，不是 skill**（skill 服务于业务执行中的 LLM 调用，出口工具由平台直接调用）；一个通知目的地一个实现，新目的地 = 新增一个实现，不动循环——与入口适配器对称。

```ts
/** 出口工具：内置投递器菜单的一项 */
interface ExitTool {
  readonly kind: string;          // 标识，全平台唯一（如 'wecom-webhook'）
  readonly name: string;          // 展示名（如「企业微信群机器人」），控制台按它选用
  readonly configSchema: unknown; // 配置项声明，控制台据此渲染表单

  /** 投递目标标识：从配置提取（webhook URL、群 id、邮箱地址…）——出口 channel_id 的第二维 */
  destinationOf(config: Record<string, string>): string;

  /** 用绑定配置实例化出口；配置（含已解析凭证）由实例持有，deliver 不再传 */
  bind(config: Record<string, string>): Exit;
}

/** 出口实例：已持有配置 */
interface Exit {
  /** 投递业务产出。失败抛错，由出口循环按有界重试策略处置（design/failure-handling.md） */
  deliver(result: unknown): Promise<void>;
}

/** 出口绑定：业务在控制台配置的一份出口实例（业务配置的一部分，归 BusinessRegistry）。
 *  多业务可绑同一工具 = 多条绑定，按 business_id 隔离路由——A 的结果永远触发不了 B 的出口 */
interface ExitBinding {
  business_id: string;            // 归属业务 = 出口循环的归属匹配键
  tool: string;                   // ExitTool.kind
  config: Record<string, string>; // 非机密配置；机密项（webhook 密钥、账号 token）
                                  // 走 EnvProvider 专用配置，bind 前解析注入
}

/** 出口工具注册表：内置菜单的登记与取用 */
interface ExitRegistry {
  get(kind: string): ExitTool;
  list(): ExitTool[];             // 控制台菜单
}
```

内置菜单（随平台发布）：企微智能机器人、企微群 webhook、邮件、自定义 webhook、jira / confluence / github 操作。

---

## 7. 通道（Channel）、并发闸门（Semaphore）与平台配置

两个薄契约 + 配置视图，两个循环共用；是循环的调度步骤而非业务配置。

```ts
/** 通道：同通道严格串行、跨通道自然并行；创建即落库，完成只做状态变更。
 *  两个循环共用本契约；出口通道不映射 agent 会话（channel-model §1） */
interface Channel {
  key: ChannelId;
  /** 挂入 (task, 关注者)，按序消化；同通道上一次消化未完结则排队。
   *  关注者类型各循环自定：入口循环 = BusinessMatch，出口循环 = ExitBinding */
  enqueue(task: Task, watcher: unknown): void;
}

/** 通道池：按 channel_id 取或建通道（创建即落库） */
interface ChannelPool {
  get(key: ChannelId): Channel;
  /** 通道激活回调：空闲通道挂入任务时触发，由调度循环注册以启动 drain */
  onActivate(cb: (channel: Channel) => void): void;
}

/** 并发闸门：每个循环一道——业务闸门保执行进程（量级几十），出口闸门管投递（可宽） */
interface Semaphore {
  acquire(): Promise<void>;   // 取不到令牌就等
  release(): void;
  readonly limit: number;
}

/** 平台配置：调度循环/生命周期对全局设置的类型化读取视图。
 *  底层数据来自设置模块（ConfigStore 的 global 作用域），循环不直接摸 key-value 字符串。 */
interface PlatformConfig {
  hop_limit: number;            // hop_count 阈值，超限判循环进死信（只管入口循环）
  task_concurrency: number;     // 业务闸门值：执行任务的并发上限（入口循环），控制台可调
  result_concurrency: number;   // 出口闸门值：结果通知投递的并发上限（出口循环），控制台可调
  task_timeout_minutes: number; // run wall-clock 超时（分钟），默认 60；业务可覆盖，业务优先
  max_agent_calls: number;      // run 级 agent 调用次数配额，超限强杀；业务可覆盖，业务优先
}
```

---

## 8. 调度循环：步骤与契约对应表

**入口事件循环**：

| 步骤 | 使用的契约 | 关键语义 |
|------|-----------|---------|
| 取任务 | `TaskQueue.take()`（入口队列） | FIFO；取出置 processing，崩溃可恢复 |
| 匹配 | `BusinessRegistry.match()` | 订阅匹配，只用轻数据；空链 → `complete()` + 日志 |
| 成链 | `ProcessingChain` | 关注者集合，无顺序语义，链内并行 |
| 挂通道 | `ChannelPool.get()` → `Channel.enqueue()` | 每个关注者按自己的 channel_id 挂通道 |
| 顺序与依赖 | 无平台机制 | 由事件订阅表达（关注上游产出类型），见 processing-chain §2 |
| 门禁/检查 | 无平台契约、无平台挂接点（业务流程程序内部环节，见 glossary） | 验收未通过 = failed（输入未就绪），不扇出 |
| 过闸门 | `Semaphore.acquire()`（业务闸门） | 按业务执行粒度获取，非按任务 |
| 组装上下文 | `BusinessContext` | 此刻才加载重数据；被拦掉的不加载 |
| 执行 | `Lifecycle.run()` | spawn 业务流程程序；单次执行、进程退出即完结、打标 |
| 结果扇出 | `deriveEvent()` → 两个队列 `enqueue()` | 无脑扇出：hop+1、correlation 继承、源生标识继承、producer_business_id 补入 |
| 完结 | `TaskQueue.complete()` / `deadLetter()` | 状态变更非删除；全部关注者完结后 complete |

**出口事件循环**：

| 步骤 | 使用的契约 | 关键语义 |
|------|-----------|---------|
| 取任务 | `TaskQueue.take()`（出口队列） | 队列里只有派生事件（`producer_business_id` 必在） |
| 匹配 | `BusinessRegistry.exitBindings()` | 归属匹配；无绑定 → `complete()` + 日志（丢弃无害） |
| 挂通道 | `ChannelPool.get('exit__' + destination)` | 同目标串行：保序 + 天然限流 |
| 过闸门 | `Semaphore.acquire()`（出口闸门） | 毫秒级投递，取值可宽 |
| 投递 | `ExitTool.bind()` → `Exit.deliver()` | 不过 LLM；失败有界重试（指数退避），耗尽 `deadLetter` + 告警 |
| 完结 | `TaskQueue.complete()` / `deadLetter()` | 不派生、不参与 hop_count |

---

## 9. 调度循环本体

### 9.1 两层循环（先讲结构，再看代码）

每个调度循环实例内部都是**两层**，职责完全不同：

| 层 | 干什么 | 不干什么 |
|----|--------|---------|
| **摄取循环 `run()`** | 从自己的任务队列取任务 → 轻数据匹配出关注者 → 逐个挂进各自通道 | **绝不执行任何业务/投递**——摄取永远轻快，背压天然成立 |
| **消化循环 `drain()`** | 在一条通道上把排队的 (task, 关注者) 按序消化 | 不碰任务队列的摄取 |

**`drain` 由通道触发，不由 `run` 调用**：通道挂入第一个任务时启动；通道消化空了即退出（通道"用完即焚"，只做状态变更落库）。一条通道同一时刻最多一个 drain 在跑——这就是「同通道严格串行」的实现方式；十条通道 = 十个 drain 并行——这就是「跨通道自然并行」。同一事件的多个关注者各挂各的通道——这就是「链内并行」。

两个循环实例 = 同一副机械 + 不同注册表与执行器：入口循环的"订阅匹配 / 生命周期执行"换成"归属匹配 / 出口投递"，就是出口循环。

### 9.2 入口事件循环代码

```ts
/** 入口事件循环：摄取循环 + 各业务通道消化循环。
 *  两条队列是它的私有对象——摄取（take）与消化（complete、扇出回队）都在本类内闭环。 */
class SchedulerLoop {
  constructor(
    private queue: TaskQueue,        // 入口队列
    private exitQueue: TaskQueue,    // 出口队列（结果扇出的另一半）
    private registry: BusinessRegistry,
    private channels: ChannelPool,
    private semaphore: Semaphore,    // 业务闸门
    private config: PlatformConfig,
    private loadContext: (business_id: string, channel_id: ChannelId) => BusinessContext, // 重数据加载口
  ) {
    // drain 的触发点：空闲通道挂入任务时，通道池回调这里启动消化循环
    this.channels.onActivate((channel) => void this.drain(channel));
  }

  /** 摄取循环：取任务 → 匹配关注者 → 逐个挂通道。绝不执行任何业务，摄取永远轻快。 */
  async run(): Promise<void> {
    for (;;) {
      const task = this.queue.take();        // FIFO；取出置 processing，崩溃可恢复
      if (!task) continue;

      const e = task.event;
      const watchers = this.registry.match(e.source, e.event_type); // 轻数据订阅匹配
      if (watchers.length === 0) {
        this.queue.complete(task.task_id);   // 未识别来源：忽略 + 日志（不创建通道、不扩散）；
        continue;                            // 无关注者：正常完结 + 日志
      }

      // 链内并行：每个关注者挂自己的通道（channel_id 含执行业务 id）
      for (const bm of watchers) {
        const key: ChannelId = `${e.source}__${e.session_id}__${bm.business_id}`;
        this.channels.get(key).enqueue(task, bm); // 空闲通道触发 onActivate → drain 启动
      }
    }
  }

  /** 消化循环：一条通道一个 drain 实例 = 同通道严格串行；消化空即退出（用完即焚）。
   *  同通道的后续 (task, 业务) 被这个 await 挡住——同通道严格串行就体现在这里。 */
  private async drain(channel: Channel): Promise<void> {
    for await (const { task, watcher: bm } of channel) {
      // 闸门：按业务执行粒度获取（一个执行 = 一个流程进程，可再拉起 agent 子进程）
      await this.semaphore.acquire();
      try {
        // 通过闸门才组装重数据（含通道映射引用：channel_id ↔ agent 会话）
        const context = this.loadContext(bm.business_id, channel.key);
        const lifecycle = createLifecycle(bm.business_id, task); // 打标：创建→进行中
        // 【耗时串行】分钟级长调用，await 到完结才轮到本通道下一个
        const result = await lifecycle.run(task.event, context);

        // 结果扇出：成功即派生；失败仅在 on_failure=true 时派生（带失败状态，下游门禁验收）。
        // 无脑投入两个队列，各循环自行过滤（无关注者/无出口绑定即丢弃）
        if (result.status === 'success' || bm.on_failure === true) {
          const next = deriveEvent(task.event, bm, result); // hop+1、correlation 继承、
                                                            // source='internal'、session_id 继承源生标识、
                                                            // producer_business_id=bm.business_id、
                                                            // event_type=业务id.产出类型
          if (next.hop_count > this.config.hop_limit) {
            // 判循环：派生事件在两个队列照常落库（留痕、有 event_id 可追溯）随即置 dead——
            // 不消化、error 日志 + 告警；当前任务不受影响，正常完结
            const deadEntry = this.queue.enqueue(next);
            this.queue.deadLetter(deadEntry.task_id, 'hop_limit');
            const deadExit = this.exitQueue.enqueue(next);
            this.exitQueue.deadLetter(deadExit.task_id, 'hop_limit');
          } else {
            this.queue.enqueue(next);      // 入口队列：关注者消化（下游业务）
            this.exitQueue.enqueue(next);  // 出口队列：出口绑定投递（企微通知等）
          }
        }
      } finally {
        this.semaphore.release();
      }
      // 任务级 complete：全部关注者执行完结后触发（按 task 计数），状态变更非删除
    }
  }
}
```

### 9.3 出口事件循环代码

```ts
/** 出口事件循环：与入口循环同一副机械——两层结构、队列/通道/闸门契约全同，
 *  只有匹配规则（归属匹配）与执行器（出口工具投递）不同。 */
class ExitSchedulerLoop {
  constructor(
    private queue: TaskQueue,           // 出口队列
    private registry: BusinessRegistry, // 出口绑定随业务配置，同一个读写口
    private exits: ExitRegistry,        // 出口工具菜单
    private channels: ChannelPool,
    private semaphore: Semaphore,       // 出口闸门
    private config: PlatformConfig,
  ) {
    this.channels.onActivate((channel) => void this.drain(channel));
  }

  /** 摄取循环：取任务 → 归属匹配出口绑定 → 逐绑定挂出口通道。同样绝不执行、永远轻快。 */
  async run(): Promise<void> {
    for (;;) {
      const task = this.queue.take();
      if (!task) continue;

      // 出口队列只装派生事件，producer_business_id 必在（契约 §1）
      const bindings = this.registry.exitBindings(task.event.producer_business_id!);
      if (bindings.length === 0) {
        this.queue.complete(task.task_id); // 无出口绑定：丢弃 + 日志（无害）
        continue;
      }

      // 链内并行：每条绑定挂自己的出口通道（同目标串行）
      for (const b of bindings) {
        const key: ChannelId = `exit__${this.exits.get(b.tool).destinationOf(b.config)}`;
        this.channels.get(key).enqueue(task, b); // 空闲通道触发 onActivate → drain 启动
      }
    }
  }

  /** 消化循环：同通道串行投递——入队序 = 投递序。
   *  投递失败有界重试（指数退避，参数属实现期配置；重试在通道内原地进行，
   *  同目标本就该排队等待），耗尽 deadLetter + error 告警（design/failure-handling.md）。 */
  private async drain(channel: Channel): Promise<void> {
    for await (const { task, watcher: binding } of channel) {
      await this.semaphore.acquire();
      try {
        // 配置（含凭证）bind 时注入并由实例持有；机密项经 EnvProvider 解析
        const exit = this.exits.get(binding.tool).bind(resolveExitConfig(binding));
        // 业务产出即投递内容，出口不做内容加工
        await exit.deliver(task.event.payload);
      } finally {
        this.semaphore.release();
      }
    }
  }
}
```

### 9.4 一个场景串起来

企微两个用户各发一条消息（同业务）：两个信封入入口队列 → `run` 各匹配出关注者 → 挂进**两条业务通道**（群不同）→ 两个 drain **并行**消化，互不等待。

同一用户连发两条消息：两个信封挂进**同一条通道**（channel_id 全同）→ 第二个排在通道里，等第一个消化完才轮到——同会话同业务严格有序。

`R.2 → B.2 →p B.3 →p B.4`（B.2/B.3/B.4 均配企微群 W 的 webhook 出口）：B.2 跑完即扇出——派生事件投入口队列（B.3 关注并消化）、投出口队列（按 B.2 的出口绑定发「审查完成」，通道 `exit__W`）；B.3 完成同样扇出（触发 B.4 + 发「crash完成」，同通道 `exit__W` 串行，序不乱）。通知与下游分析互不等待，通知也不被分析的长耗时阻塞。

**辅助函数（签名即契约，实现归各模块）**：

```ts
/** 派生事件：hop_count+1、correlation_id 继承、source='internal'、
 *  event_type=业务id.产出类型、session_id 继承上游源生标识（channel-model §4.1）、
 *  producer_business_id=产出方业务 id（出口循环归属匹配键） */
declare function deriveEvent(e: Event, bm: BusinessMatch, result: ExecutionResult): Event;

/** 生命周期创建：生成 lifecycle_id，打标 created（归生命周期模块） */
declare function createLifecycle(business_id: string, task: Task): Lifecycle;

/** 出口配置解析：绑定配置与 EnvProvider 安全桶中对应机密项（`exit.{tool}.` 前缀 key）合并（实现归环境配置模块） */
declare function resolveExitConfig(binding: ExitBinding): Record<string, string>;
```

---

## 10. 待定项（本稿不解决，列出备忘）

| 项 | 说明 | 归属 |
|----|------|------|
| 业务语义去重 | **已定**：归业务流程程序自行处理——平台不了解业务细节，不定规范、不提供字段（业务可在流程内调子程序按业务字段过滤，如同一工单只审一次）；第一层入口幂等由 `event_id` 承担（入口识别源生事件重推并丢弃）。`dedupe_key` 预留字段已移除（event-contract changelog 2026-09-28） | 已定 |
| `EventSource` / agent / model / 出口工具枚举扩展 | 枚举新增属向后兼容 | 各文档 |
| 死信告警渠道 | 死信 = 任务状态 + error 日志（已定）；是否再通知管理员（如企微告警） | 待定 |
| 死信事件的消化 | 第一阶段：死信不消化，仅留痕 + 告警；未来若允许业务关注死信事件做善后，属业务规则扩展 | 后续再议 |
| 出口重试参数 | 重试次数上限、退避间隔 | 实现期配置 |
