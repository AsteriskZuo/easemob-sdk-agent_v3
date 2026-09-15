# 调度循环契约

> 日期：2026-09-15
> 状态：定稿
> 范围：**只覆盖调度循环直接使用的契约**。入口内部、业务语义去重（后续单独设计）、控制台 UI、日志接口不在本文档。
> 依据：`design/scheduler.md`、`design/processing-chain.md`、`design/lifecycle.md`、`design/event-contract.md`（v1）。
> 定位：调度循环就是这些契约的串联（见 §8）。

---

## 1. 事件（Event）

循环的输入。TS 镜像 `design/event-contract.md` v1，字段语义以该文档为准，此处不重复解释。

```ts
/** 事件信封，契约 v1。唯一权威定义见 design/event-contract.md */
interface Event {
  contract_version: 'v1';
  event_id: string;        // 全局唯一锚点
  source: EventSource;     // 入口写入；新来源 = 枚举新增
  event_type: string;      // 关注匹配的键（规则见下）
  timestamp: string;       // ISO 8601 带时区，入口包装时间
  session_id: string;      // 必填；通道键的组成
  dedupe_key?: string;     // 第二层业务语义去重的预留字段（本版不实现）；第一层入口幂等由 event_id 承担；循环不使用
  correlation_id: string;  // 首个任务的 event_id，派生继承
  hop_count: number;       // 派生 +1，超阈值进死信
  payload: unknown;        // 来源自定义；大产物走引用
}

type EventSource = 'wecom' | 'jira' | 'github' | 'cron' | 'manual' | 'internal';

/** 通道键 = source__session_id（双下划线） */
type ChannelKey = string;
```

**event_type 规则（已定）**：

- 自定义字段，由业务创建者/管理者确定，**一旦创建不可修改**；
- **全平台唯一**，不得与现有标识符冲突；名字要有意义；
- internal 事件：`对象.动作` = `业务id.产出类型`（如 `b01J8xk.review.completed`），业务创建时声明产出类型，供下游关注。

---

## 2. 任务队列（TaskQueue）

循环的摄取口。事件进来即持久化；取出不删、完结才标记，崩溃可恢复。

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
  /** 入口侧调用：校验之后落库，落库才算收到 */
  enqueue(event: Event): Task;

  /** 心脏调用：FIFO 取下一个 pending，置为 processing。无任务时阻塞/空转由实现定 */
  take(): Task | null;

  /** 消化完结（含"无关注者"的正常完结） */
  complete(task_id: string): void;

  /** 死信：hop_count 超阈值等不可消化情形，告警由调用方触发 */
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

**匹配只用轻数据**——控制台预先设置的匹配字段，不含任何执行所需的重组件。匹配不上（无关注者 / 未识别来源）→ `complete` + 日志，不进入链。

```ts
/** 业务注册表：匹配视图 + 业务配置的统一读写口。
 *  原则：业务配置（依赖、结果处置等）在控制台设置、数据库保存，
 *  查询与修改只有这一个接口，内部模块与控制台共用，没有第二套。 */
interface BusinessRegistry {
  /** 匹配：返回关注 (source, event_type) 的业务匹配视图，按全局序排列 */
  match(source: EventSource, event_type: string): BusinessMatch[];

  /** 业务配置读写：控制台与内部同一个接口 */
  get(business_id: string): BusinessMatch;
  update(business_id: string, patch: Partial<BusinessMatch>): void;
}

/** 匹配视图：注册表执行视图的一行，常驻内存 */
interface BusinessMatch {
  business_id: string;        // 业务 id，创建时生成不可改
  creator_id: string;         // 创建者：业务设置的权限归属判定（见设置模块契约）
  source: EventSource;        // 关注的来源
  event_type: string;         // 关注的事件类型
  order: number;              // 全局序：链内顺序的唯一真相源
  depends_on?: Dependency[];  // 依赖声明（失败传播语义）
  disposition: ResultDisposition; // 结果处置：回队 or 终结（§5）
  gate?: Gate;                // 门禁：判输入就绪（§5）
}

interface Dependency {
  business_id: string;        // 前置业务
  on_failure: 'skip' | 'run'; // 前置失败时本业务是否执行；默认 skip
}

/** 处理链 = 关注该事件的业务按全局序排列的数组，链内串行（完成序） */
type ProcessingChain = BusinessMatch[];
```

---

## 4. 业务上下文（BusinessContext）

**匹配成功、通道轮到、闸门通过之后才组装**。各成员只给最小视图——循环只需要"能执行任务"的形状，成员自身的完整设计各归其文档。

```ts
/** 可执行任务的完整上下文 = 提示词 + skill 组 + agent-cli + 大模型 + 环境配置 */
interface BusinessContext {
  business_id: string;
  prompt: PromptObject;       // 总纲：规则、边界、要求、不可做
  skills: SkillObject[];      // 本业务选用的 skill（内置/公开/私有）
  agent: AgentCliObject;      // agent-cli 适配器引用 + 配置
  model: ModelObject;         // 大模型选择
  env: EnvConfig;             // 环境/安全/专用配置，按业务隔离注入
  session: SessionRef;        // 会话映射引用：session_id ↔ agent-cli 会话
}

/** 提示词对象（大纲）。循环只透传，不解析 */
interface PromptObject {
  content: string;
}

/** skill 最小视图（完整模型见 design/skill-package.md） */
interface SkillObject {
  skill_id: string;           // 整包 hash（兼任内部编号）
  schema: unknown;            // 注入 agent 上下文的简式 schema
}

/** agent-cli 最小视图（适配槽纪律见 design/lifecycle.md §5：适配器要薄） */
interface AgentCliObject {
  kind: 'pi';                 // MVP 仅 pi；新 agent = 枚举新增 + 适配器
  config: Record<string, unknown>;
}

/** 大模型最小视图 */
interface ModelObject {
  name: 'qwen3.8max';         // MVP 仅 qwen3.8max
  params?: Record<string, unknown>;
}

/** 环境配置对象：控制台 key-value 的运行时读取面 */
interface EnvConfig {
  vars: Record<string, string>;          // 环境变量
  secrets: Record<string, string>;       // 安全变量：运行时注入，不落盘不进日志
  services: Record<string, Record<string, string>>; // 专用配置：github / wecom / jira
}

/** 会话映射引用（四操作归会话模块，循环只持有引用并注入 agent 调用） */
interface SessionRef {
  session_id: string;
  agent_session_id?: string;  // 新建会话时为空，由首次执行建立
}
```

---

## 5. 执行（Lifecycle）与结果处置

生命周期 = 一次完整执行，跑完即销毁。平台视角一次性；调用几次大模型是业务内部细节。

```ts
/** 业务标记：生命周期状态机的控制台投影，与生命周期状态同内容两视角 */
type LifecycleStatus = 'created' | 'running' | 'success' | 'failed' | 'timeout';

interface Lifecycle {
  lifecycle_id: string;
  business_id: string;
  status: LifecycleStatus;

  /** 单次执行。分钟级长耗时（agent 沙箱进程，超时默认 60 分钟），必须 await。
   *  内部经适配槽 invoke，统一埋点（token/耗时/成本） */
  run(event: Event, context: BusinessContext): Promise<ExecutionResult>;
}

interface ExecutionResult {
  status: Extract<LifecycleStatus, 'success' | 'failed' | 'timeout'>;
  output: unknown;            // 业务产出；大产物走引用
  usage?: { tokens: number; duration_ms: number };
}

/** 结果处置：由业务定义（控制台配置），二选一 */
type ResultDisposition =
  | { kind: 'requeue' }    // 派生新事件回队：hop_count+1、correlation_id 继承、source='internal'
  | { kind: 'terminate' }; // 出口型业务（如企微通知）：处理完不再回队

/** 门禁：判输入就绪（含对上游产出/外部业务系统的验证），未就绪跳过、不阻塞链上后续 */
type Gate = (event: Event, prior: ChainContext) => boolean;

/** 链执行上下文：门禁与依赖判定所需的最小信息 */
interface ChainContext {
  prior_results: Record<string, ExecutionResult>; // 按 business_id 索引的链内已执行结果
}
```

---

## 6. 通道（Channel）、并发闸门（Semaphore）与平台配置

两个薄契约，是循环的调度步骤而非业务配置。

```ts
/** 会话通道：同通道严格串行、跨通道自然并行；创建即落库，完成只做状态变更 */
interface Channel {
  key: ChannelKey;
  /** 挂入 (task, chain)，按序消化；同通道上一次消化未完结则排队 */
  enqueue(task: Task, chain: ProcessingChain): void;
}

/** 通道池：按通道键取或建通道（创建即落库） */
interface ChannelPool {
  get(key: ChannelKey): Channel;
  /** 通道激活回调：空闲通道挂入任务时触发，由调度循环注册以启动 drain */
  onActivate(cb: (channel: Channel) => void): void;
}

/** 并发闸门 = 最大通道并发数（同一概念）：全局信号量，保本机沙箱 */
interface Semaphore {
  acquire(): Promise<void>;   // 取不到令牌就等
  release(): void;
  readonly limit: number;
}

/** 平台配置：调度循环/生命周期对全局设置的类型化读取视图。
 *  底层数据来自设置模块（ConfigStore 的 global 作用域），循环不直接摸 key-value 字符串。 */
interface PlatformConfig {
  hop_limit: number;           // hop_count 阈值，超限判循环进死信
  channel_concurrency: number; // 闸门值，控制台可调
  task_timeout_minutes: number; // Lifecycle.run 超时（分钟），默认 60
}
```

---

## 7. 调度循环：步骤与契约对应表

| 步骤 | 使用的契约 | 关键语义 |
|------|-----------|---------|
| 取任务 | `TaskQueue.take()` | FIFO；取出置 processing，崩溃可恢复 |
| 匹配 | `BusinessRegistry.match()` | 只用轻数据；空链 → `complete()` + 日志 |
| 成链 | `ProcessingChain` | 全局序排列，链内串行（完成序） |
| 挂通道 | `ChannelPool.get()` → `Channel.enqueue()` | 通道键 = `source__session_id`；同通道排队 |
| 依赖判定 | `Dependency` + `ChainContext` | 前置失败按 `on_failure`（默认 skip） |
| 门禁 | `Gate` | 输入未就绪跳过，不阻塞后续 |
| 过闸门 | `Semaphore.acquire()` | 按业务执行粒度获取，非按任务 |
| 组装上下文 | `BusinessContext` | 此刻才加载重数据；被拦掉的不加载 |
| 执行 | `Lifecycle.run()` | 单次执行、跑完即销毁、打标 |
| 结果处置 | `ResultDisposition` | 回队（hop+1、correlation 继承）或终结 |
| 完结 | `TaskQueue.complete()` / `deadLetter()` | 状态变更非删除 |

---

## 8. 调度循环本体

### 8.1 两层循环（先讲结构，再看代码）

调度循环不是一层循环，是**两层**，职责完全不同：

| 层 | 干什么 | 不干什么 |
|----|--------|---------|
| **摄取循环 `run()`** | 从任务队列取任务 → 轻数据匹配成链 → 挂进通道 | **绝不执行任何业务**——摄取永远轻快，背压天然成立 |
| **消化循环 `drain()`** | 在一条通道上把排队的 (task, chain) 按序消化：**逐业务**执行 | 不碰任务队列的摄取 |

**`drain` 由通道触发，不由 `run` 调用**：通道挂入第一个任务时启动；通道消化空了即退出（通道"用完即焚"，只做状态变更落库）。一条通道同一时刻最多一个 drain 在跑——这就是「同通道严格串行」的实现方式；十条通道 = 十个 drain 并行——这就是「跨通道自然并行」。所以 `run` 里看不到逐业务处理是对的：成链之后，执行权就移交给了通道。

### 8.2 代码

```ts
/** 调度循环（心脏）：全平台唯一摄取循环，同时持有各通道的消化循环。
 *  任务队列是它的私有对象——摄取（take）与消化（complete、派生回队）都在本类内闭环。 */
class SchedulerLoop {
  constructor(
    private queue: TaskQueue,
    private registry: BusinessRegistry,
    private channels: ChannelPool,
    private semaphore: Semaphore,
    private config: PlatformConfig,
    private loadContext: (business_id: string) => BusinessContext, // 重数据加载口
  ) {
    // drain 的触发点：空闲通道挂入任务时，通道池回调这里启动消化循环
    this.channels.onActivate((channel) => void this.drain(channel));
  }

  /** 摄取循环：取任务 → 匹配成链 → 挂通道。绝不执行任何业务，摄取永远轻快。 */
  async run(): Promise<void> {
    for (;;) {
      const task = this.queue.take();        // FIFO；取出置 processing，崩溃可恢复
      if (!task) continue;

      const e = task.event;
      const chain = this.registry.match(e.source, e.event_type); // 轻数据匹配
      if (chain.length === 0) {
        this.queue.complete(task.task_id);   // 无关注者/未识别来源：完结 + 日志
        continue;
      }

      const key: ChannelKey = `${e.source}__${e.session_id}`;
      this.channels.get(key).enqueue(task, chain); // 空闲通道触发 onActivate → drain 启动
    }
  }

  /** 消化循环：一条通道一个 drain 实例 = 同通道严格串行；链内完成序；消化空即退出（用完即焚）。 */
  private async drain(channel: Channel): Promise<void> {
    for await (const { task, chain } of channel) {
      const ctx: ChainContext = { prior_results: {} };

      for (const bm of chain) {
        // 依赖判定：前置失败且 on_failure=skip（默认）→ 跳过本业务
        if (blockedByDependency(bm, ctx)) continue;

        // 门禁：输入未就绪 → 跳过，不阻塞链上后续
        if (bm.gate && !bm.gate(task.event, ctx)) continue;

        // 闸门：按业务执行粒度获取（一个执行 = 一个沙箱进程）
        await this.semaphore.acquire();
        try {
          // 通过全部检查才组装重数据
          const context = this.loadContext(bm.business_id);
          const lifecycle = createLifecycle(bm.business_id, task); // 打标：创建→进行中
          // 【耗时串行】分钟级长调用，await 到完结才轮到链上下一个业务（完成序）；
          // 本通道的后续任务同样被这个 await 挡住——同通道严格串行就体现在这里
          const result = await lifecycle.run(task.event, context);
          ctx.prior_results[bm.business_id] = result;

          // 结果处置：【逐业务、跑完即处置】，由每个业务自己的 disposition 决定，
          // 不是整条链跑完统一处理
          if (bm.disposition.kind === 'requeue') {
            const next = deriveEvent(task.event, result); // hop+1、correlation 继承、
                                                          // source='internal'、
                                                          // event_type=业务id.产出类型
            if (next.hop_count > this.config.hop_limit) {
              this.queue.deadLetter(task.task_id, 'hop_limit'); // 判循环，告警
            } else {
              this.queue.enqueue(next); // 关注者消化（如企微通知）
            }
          }
          // kind === 'terminate'：出口型业务，不回队，到此终结
        } finally {
          this.semaphore.release();
        }
      }

      this.queue.complete(task.task_id); // 整条链消化完，任务完结（状态变更，非删除）
    }
  }
}
```

### 8.4 一个场景串起来

企微两个用户各发一条消息：两个信封入队 → `run` 取两次、各匹配成链 → 挂进**两条通道** → 两个 drain **并行**消化，互不等待。

同一用户连发两条消息：两个信封挂进**同一条通道** → 第二个任务排在通道里，等第一个任务的整条链消化完才轮到——同会话严格有序。

链上 [审查（requeue）→ 企微通知（terminate）]：审查跑完立即派生 internal 事件回队（给更下游的关注者），企微通知跑完直接终结——各按各的 disposition。

**辅助函数（签名即契约，实现归各模块）**：

```ts
/** 依赖判定：前置失败/超时被跳过，且配置为 skip 时 → true（阻断） */
declare function blockedByDependency(bm: BusinessMatch, ctx: ChainContext): boolean;

/** 派生事件：hop_count+1、correlation_id 继承、source='internal'、event_type=业务id.产出类型 */
declare function deriveEvent(e: Event, result: ExecutionResult): Event;

/** 生命周期创建：生成 lifecycle_id，打标 created（归生命周期模块） */
declare function createLifecycle(business_id: string, task: Task): Lifecycle;
```

---

## 9. 待定项（本稿不解决，列出备忘）

| 项 | 说明 | 归属 |
|----|------|------|
| 业务语义去重 | 第一层入口幂等由 `event_id` 承担（入口识别源生事件重推并丢弃）；`dedupe_key` 为第二层预留字段（平台定规范+业务给实现），后续再议，需要时单独文档 | 后续再议 |
| `EventSource` / agent / model 枚举扩展 | 枚举新增属向后兼容 | 各文档 |
| GitHub webhook 事件种类调研 | 建分支/push/CI 等事件的源生标识提取规则 | 待调研 |
