# 调度循环契约

> 日期：2026-09-15
> 状态：定稿
> 范围：**只覆盖调度循环直接使用的契约**。入口内部、业务语义去重（后续单独设计）、控制台 UI、日志接口不在本文档。
> 依据：`design/scheduler.md`、`design/processing-chain.md`、`design/lifecycle.md`、`design/event-contract.md`（v1）、`design/channel-model.md`。
> 定位：调度循环就是这些契约的串联（见 §8）。

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
  dedupe_key?: string;     // 第二层业务语义去重的预留字段（本版不实现）；第一层入口幂等由 event_id 承担；循环不使用
  correlation_id: string;  // 首个任务的 event_id，派生继承
  hop_count: number;       // 派生 +1，超阈值进死信
  payload: unknown;        // 来源自定义；大产物走引用
}

type EventSource = 'wecom' | 'jira' | 'github' | 'cron' | 'manual' | 'internal';

/** 串行键 = source__session_id__business_id（三维，双下划线）；
 *  session_id = 源生会话标识（入口提取）；business_id = 执行业务 id（匹配后按关注者补入）。
 *  相同会话 + 相同业务 = 同通道串行；其余组合 = 并行。唯一定义见 glossary 通道词条 */
type ChannelKey = string;
```

**event_type 契约约束**：概念定义（类别标签、匹配键、与 event_id 的区别）见 `design/glossary.md` 事件类型词条——唯一定义处；此处只列契约约束：

- 自定义字段，由业务创建者/管理者确定，**一旦创建不可修改**；
- **全平台唯一**，不得与现有标识符冲突；名字要有意义；
- internal 事件：`对象.动作` = `业务id.产出类型`（如 `b01J8xk.review.completed`），业务创建时声明产出类型，供下游关注；**依赖关系的唯一表达方式 = 关注上游的产出事件类型**（见 `design/processing-chain.md` §2）。

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

  /** 消化完结：全部关注者执行完结后触发（含"无关注者"的正常完结）；按 task 计数 */
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
 *  原则：业务配置（关注、结果处置等）在控制台设置、数据库保存，
 *  查询与修改只有这一个接口，内部模块与控制台共用，没有第二套。 */
interface BusinessRegistry {
  /** 匹配：返回关注 (source, event_type) 的业务匹配视图（关注者集合，无顺序语义） */
  match(source: EventSource, event_type: string): BusinessMatch[];

  /** 业务配置读写：控制台与内部同一个接口 */
  get(business_id: string): BusinessMatch;
  update(business_id: string, patch: Partial<BusinessMatch>): void;
}

/** 匹配视图：注册表执行视图的一行，常驻内存 */
interface BusinessMatch {
  business_id: string;        // 业务 id：创建时自动生成、不可修改，一切内部引用的锚
  business_name: string;      // 展示名：用户设置、可修改；不参与任何匹配与引用
  creator_id: string;         // 创建者：业务设置的权限归属判定（见设置模块契约）
  source: EventSource;        // 关注的来源
  event_type: string;         // 关注的事件类型（依赖关系由此表达：关注上游的产出类型）
  disposition: ResultDisposition; // 结果处置：回队 or 终结（§5）
  // 无 order / depends_on / gate 字段：链内并行（glossary 处理链词条）；
  // 顺序靠事件订阅表达，门禁由业务执行体内部完成（glossary 门禁词条）
}

/** 处理链 = 关注该事件的业务集合；链内并行消化——每个关注者按自己的串行键挂通道 */
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
  channel: ChannelRef;        // 通道映射引用：串行键 ↔ agent-cli 会话
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

/** 通道映射引用（四操作归通道模块，循环只持有引用并注入 agent 调用） */
interface ChannelRef {
  channel_key: ChannelKey;    // 串行键：同通道上下文连续的唯一依据
  agent_session_id?: string;  // 首次执行为空，由首次执行建立并绑定
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
  | { kind: 'requeue';        // 派生新事件回队：hop_count+1、correlation_id 继承、source='internal'、
      on_failure?: boolean }  //   session_id 继承上游源生标识（design/channel-model.md §4.1）。
                              // on_failure：失败也派生（派生事件带失败状态，下游门禁验收）；默认 false = 失败不派生，下游天然不触发
  | { kind: 'terminate' };    // 出口型业务（如企微通知）：处理完不再回队

/** 门禁：不设平台契约。双门禁（业务自检 + 下游验收）由业务执行体（大模型）完成，
 *  规则写在提示词/skill（弱约束）或 skill 内脚本（强约束，半机械检查），
 *  唯一定义见 design/glossary.md；验收未通过 = 本次执行 failed（输入未就绪），不派生、下游自然不触发 */
```

---

## 6. 通道（Channel）、并发闸门（Semaphore）与平台配置

两个薄契约，是循环的调度步骤而非业务配置。

```ts
/** 通道：同通道严格串行、跨通道自然并行；创建即落库，完成只做状态变更 */
interface Channel {
  key: ChannelKey;            // 串行键（三维）
  /** 挂入 (task, 业务)，按序消化；同通道上一次消化未完结则排队 */
  enqueue(task: Task, bm: BusinessMatch): void;
}

/** 通道池：按串行键取或建通道（创建即落库） */
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
| 成链 | `ProcessingChain` | 关注者集合，无顺序语义，链内并行 |
| 挂通道 | `ChannelPool.get()` → `Channel.enqueue()` | 每个关注者按自己的串行键挂通道 |
| 顺序与依赖 | 无平台机制 | 由事件订阅表达（关注上游产出类型），见 processing-chain §2 |
| 门禁 | 无平台契约（业务执行体内部完成，见 glossary） | 验收未通过 = failed（输入未就绪），不派生 |
| 过闸门 | `Semaphore.acquire()` | 按业务执行粒度获取，非按任务 |
| 组装上下文 | `BusinessContext` | 此刻才加载重数据；被拦掉的不加载 |
| 执行 | `Lifecycle.run()` | 单次执行、跑完即销毁、打标 |
| 结果处置 | `ResultDisposition` | 回队（hop+1、correlation 继承、源生标识继承）或终结；失败默认不派生 |
| 完结 | `TaskQueue.complete()` / `deadLetter()` | 状态变更非删除；全部关注者完结后 complete |

---

## 8. 调度循环本体

### 8.1 两层循环（先讲结构，再看代码）

调度循环不是一层循环，是**两层**，职责完全不同：

| 层 | 干什么 | 不干什么 |
|----|--------|---------|
| **摄取循环 `run()`** | 从任务队列取任务 → 轻数据匹配出关注者 → 逐个挂进各自通道 | **绝不执行任何业务**——摄取永远轻快，背压天然成立 |
| **消化循环 `drain()`** | 在一条通道上把排队的 (task, 业务) 按序消化 | 不碰任务队列的摄取 |

**`drain` 由通道触发，不由 `run` 调用**：通道挂入第一个任务时启动；通道消化空了即退出（通道"用完即焚"，只做状态变更落库）。一条通道同一时刻最多一个 drain 在跑——这就是「同通道严格串行」的实现方式；十条通道 = 十个 drain 并行——这就是「跨通道自然并行」。同一事件的多个关注者各挂各的通道——这就是「链内并行」。

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
    private loadContext: (business_id: string, channel_key: ChannelKey) => BusinessContext, // 重数据加载口
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
      const watchers = this.registry.match(e.source, e.event_type); // 轻数据匹配
      if (watchers.length === 0) {
        this.queue.complete(task.task_id);   // 未识别来源：忽略 + 日志（不创建通道、不扩散）；
        continue;                            // 无关注者：正常完结 + 日志
      }

      // 链内并行：每个关注者挂自己的通道（串行键含执行业务 id）
      for (const bm of watchers) {
        const key: ChannelKey = `${e.source}__${e.session_id}__${bm.business_id}`;
        this.channels.get(key).enqueue(task, bm); // 空闲通道触发 onActivate → drain 启动
      }
    }
  }

  /** 消化循环：一条通道一个 drain 实例 = 同通道严格串行；消化空即退出（用完即焚）。
   *  同通道的后续 (task, 业务) 被这个 await 挡住——同通道严格串行就体现在这里。 */
  private async drain(channel: Channel): Promise<void> {
    for await (const { task, bm } of channel) {
      // 闸门：按业务执行粒度获取（一个执行 = 一个沙箱进程）
      await this.semaphore.acquire();
      try {
        // 通过闸门才组装重数据（含通道映射引用：串行键 ↔ agent 会话）
        const context = this.loadContext(bm.business_id, channel.key);
        const lifecycle = createLifecycle(bm.business_id, task); // 打标：创建→进行中
        // 【耗时串行】分钟级长调用，await 到完结才轮到本通道下一个
        const result = await lifecycle.run(task.event, context);

        // 结果处置：跑完即处置。成功即派生；失败默认不派生（下游天然不触发），
        // 配置 on_failure 才带失败状态派生（下游门禁验收）
        const d = bm.disposition;
        if (d.kind === 'requeue' && (result.status === 'success' || d.on_failure === true)) {
          const next = deriveEvent(task.event, bm, result); // hop+1、correlation 继承、
                                                            // source='internal'、session_id 继承源生标识、
                                                            // event_type=业务id.产出类型
          if (next.hop_count > this.config.hop_limit) {
            // 判循环：派生事件照常入队落库（留痕、有 event_id 可追溯），随即置 dead——
            // 不消化、error 日志 + 告警；当前任务不受影响，正常完结
            const dead = this.queue.enqueue(next);
            this.queue.deadLetter(dead.task_id, 'hop_limit');
          } else {
            this.queue.enqueue(next); // 关注者消化（如企微通知、下游业务）
          }
        }
        // kind === 'terminate'：出口型业务，不回队，到此终结
      } finally {
        this.semaphore.release();
      }
      // 任务级 complete：全部关注者执行完结后触发（按 task 计数），状态变更非删除
    }
  }
}
```

### 8.3 一个场景串起来

企微两个用户各发一条消息（同业务）：两个信封入队 → `run` 各匹配出关注者 → 挂进**两条通道**（群不同）→ 两个 drain **并行**消化，互不等待。

同一用户连发两条消息：两个信封挂进**同一条通道**（串行键全同）→ 第二个排在通道里，等第一个消化完才轮到——同会话同业务严格有序。

`R.2 → B.2 →p {C.2, B.3}`：审查（B.2）跑完派生 internal 事件回队；通知（C.2）与 crash 分析（B.3）各挂各的通道**并行**消化——各按各的 disposition（C.2 终结，B.3 继续派生给 B.4）。

**辅助函数（签名即契约，实现归各模块）**：

```ts
/** 派生事件：hop_count+1、correlation_id 继承、source='internal'、
 *  event_type=业务id.产出类型、session_id 继承上游源生标识（channel-model §4.1） */
declare function deriveEvent(e: Event, bm: BusinessMatch, result: ExecutionResult): Event;

/** 生命周期创建：生成 lifecycle_id，打标 created（归生命周期模块） */
declare function createLifecycle(business_id: string, task: Task): Lifecycle;
```

---

## 9. 待定项（本稿不解决，列出备忘）

| 项 | 说明 | 归属 |
|----|------|------|
| 业务语义去重 | 第一层入口幂等由 `event_id` 承担（入口识别源生事件重推并丢弃）；`dedupe_key` 为第二层预留字段（平台定规范+业务给实现），后续再议，需要时单独文档 | 后续再议 |
| `EventSource` / agent / model 枚举扩展 | 枚举新增属向后兼容 | 各文档 |
| 死信告警渠道 | 死信 = 任务状态 + error 日志（已定）；是否再通知管理员（如企微告警） | 待定 |
| 死信事件的消化 | 第一阶段：死信不消化，仅留痕 + 告警；未来若允许出口型业务关注死信事件做善后，属业务规则扩展 | 后续再议 |
