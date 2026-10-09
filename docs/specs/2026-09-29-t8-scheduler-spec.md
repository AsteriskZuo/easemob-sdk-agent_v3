# T8 scheduler 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/scheduler-loop-contracts.md`、`design/failure-handling.md`。

## 1. 目标

产出 `@asteriskzuo/agent-scheduler` 包：**平台的心脏——入口事件循环与出口事件循环**。两个循环是同一副机械（摄取 run + 通道消化 drain 两层结构），只有匹配规则与执行器不同。本包只做循环机械：取任务、匹配、挂通道、过闸门、调执行器、结果扇出、完结/死信。**不实现**业务上下文组装、生命周期执行、出口工具——它们是注入的执行器回调（后续任务实现，装配根接线）。

## 2. 背景知识（执行所需的最小上下文）

- 平台有两条任务队列（入口队列 entry_tasks / 出口队列 exit_tasks，同为 `@asteriskzuo/agent-queue` 的 TaskQueue 实例）。外部事件入入口队列；业务执行完结后派生事件**无脑投两个队列**，各循环自行过滤（无关注者/无出口绑定即丢弃）。
- 同通道严格串行、跨通道自然并行。业务通道 id = `source__session_id__business_id`；出口通道 id = `exit__<destination_id>`。用 `@asteriskzuo/agent-contracts` 的 `buildBusinessChannelId` / `buildExitChannelId` 构造。
- 链内并行：一个事件的多个关注者（入口 = BusinessMatch，出口 = ExitBinding）各挂各的通道。
- 失败处理第一阶段只做日志留痕，唯一例外：**出口投递有界重试**（指数退避、次数上限、原地重试、耗尽死信）。
- 平台稳定性是设计目标：业务执行失败、执行器抛异常、匹配异常都**不得**让循环崩溃或退出。

### 2.1 消费的上游包（真实签名，以此为准）

`@asteriskzuo/agent-queue`：

```ts
export interface Task { task_id: string; event: EventEnvelope; status: TaskStatus; enqueued_at: string; finished_at?: string }
export interface TaskQueue {
  enqueue(event: EventEnvelope): Task;        // event_id 幂等；非法信封抛错
  take(): Task | null;                        // FIFO 取 pending 置 processing；空返回 null
  complete(task_id: string): void;            // 置 done；不存在抛错
  deadLetter(task_id: string, reason: string): void; // 置 dead + reason；不存在抛错
  query(filter: TaskFilter): Task[];
  recover(): number;                          // processing 残留重置回 pending（装配根启动时调，本包不调）
  purge(cutoffIso: string): number;
}
```

`@asteriskzuo/agent-registry`：

```ts
export interface BusinessMatch {
  business_id: string; business_name: string; creator_id: string;
  source: EventSource; event_type: string; on_failure?: boolean; // 默认 false = 失败不扇出
}
export interface ExitBinding { business_id: string; tool: string; config: Record<string, string> }
export interface BusinessRegistry {
  match(source: EventSource, event_type: string): BusinessMatch[];  // 空 = 无关注者
  exitBindings(business_id: string): ExitBinding[];                 // 空 = 无出口绑定
  // 其余方法本包不用
}
```

`@asteriskzuo/agent-channel`：

```ts
export interface ChannelItem<T = unknown> { task: Task; watcher: T }
export interface Channel extends AsyncIterable<ChannelItem> {
  readonly key: string;
  enqueue(task: Task, watcher: unknown): void;  // 空闲通道挂入时触发 onActivate
}
export interface ChannelPool {
  get(key: string): Channel;                    // 取或建（创建即落库）
  onActivate(cb: (channel: Channel) => void): void; // 每个池只能注册一次
}
```

`@asteriskzuo/agent-contracts`：`EventEnvelope`（字段见 §5.2）、`EventSource`、`newUlid()` / `newEventId()`（事件 id 用后者，`evt_` 前缀）、`buildBusinessChannelId(source, sessionId, businessId)`、`buildExitChannelId(destinationId)`。

`@asteriskzuo/agent-logger`（全局外观，装配根已 initLogger，本包直接用）：

```ts
logger.for({ module: 'entry-loop' }).info('消息', { event_id, task_id, ... }) // fields 可选
// CategoryLogger: error/warn/info/debug(message, fields?) + .with(fields)
```

### 2.2 依赖规则（违反即返工）

- 本包是**上下文注入**类（规则第 3 类）：所有协作对象经构造函数参数注入，不 import 任何全局单例（logger 外观除外——它是规则第 2 类）；
- 不读 `process.env`；配置全部经 `PlatformConfig` / `SchedulerOptions` 注入；
- 不改任何其他包的文件。

## 3. 范围与不做清单

**本任务做**：入口循环、出口循环、Semaphore、deriveEvent、配套测试。

**本任务不做**：

- BusinessContext 组装 / Lifecycle / 业务流程程序 spawn（T10/T12，经 `EntryDriver` 注入）；
- 出口工具实现与凭证解析（T9/T12，经 `ExitDriver` 注入）；
- `queue.recover()` / `purge()` 的调用（装配根纪律，本包只在注释说明）；
- 死信告警通知、任务级重跑（第二阶段）。

## 4. 包结构

```text
packages/scheduler/
├── package.json            # @asteriskzuo/agent-scheduler
├── tsconfig.json
├── src/
│   ├── index.ts            # 导出清单见 §8
│   ├── types.ts            # PlatformConfig / ExecutionResult / EntryDriver / ExitDriver / SchedulerOptions / SchedulerLoop
│   ├── semaphore.ts
│   ├── derive-event.ts
│   ├── entry-loop.ts
│   └── exit-loop.ts
└── tests/
    ├── semaphore.test.ts
    ├── derive-event.test.ts
    ├── entry-loop.test.ts
    └── exit-loop.test.ts
```

工程约定同 T0 spec §4。`dependencies`：`@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-queue`、`@asteriskzuo/agent-registry`、`@asteriskzuo/agent-channel`、`@asteriskzuo/agent-logger`（全部 `workspace:*`）。`devDependencies` 另加 `@asteriskzuo/agent-database`（测试用它建内存库造真实 queue/registry/channel 实例）。

## 5. 详细规格

### 5.1 类型（types.ts）

```ts
import type { EventEnvelope } from '@asteriskzuo/agent-contracts';
import type { Task } from '@asteriskzuo/agent-queue';
import type { BusinessMatch, ExitBinding } from '@asteriskzuo/agent-registry';

/** 平台运行参数：装配根从环境/设置读好后注入；本包不读 process.env */
export interface PlatformConfig {
  hop_limit: number;          // 派生事件 hop_count 超此值 → 落库即死信（只判入口循环的扇出）
  task_concurrency: number;   // 入口业务闸门
  result_concurrency: number; // 出口闸门
}

/** 执行结果（Lifecycle 的返回形状；本包只消费不生产） */
export interface ExecutionResult {
  status: 'success' | 'failed' | 'timeout';
  output: unknown;            // 业务产出；派生事件的 payload（成功时）
  usage?: { tokens: number; duration_ms: number }; // 执行计量（可选）：仅留痕，不进任何判定
}

/** 入口执行器（注入）：一个 (任务, 关注者) 的一次完整业务执行。
 *  实现方负责：闸门通过后组装 BusinessContext → spawn 业务流程程序 → 返回结果。
 *  分钟级长调用。约定：业务失败应返回 {status:'failed'|'timeout'} 而非抛错；
 *  抛错 = 基础设施异常，本包按 §5.3 兜底合成 failed。 */
export interface EntryDriver {
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
  pollIntervalMs?: number;   // 摄取空转轮询间隔，默认 50
  exitRetry?: {
    maxAttempts?: number;    // 默认 3（含首次）
    baseDelayMs?: number;    // 默认 1000
    maxDelayMs?: number;     // 默认 10000；第 n 次重试前等待 min(base*2^(n-1), max)
  };
}

/** 循环句柄 */
export interface SchedulerLoop {
  start(): void;             // 启动摄取循环与 drain 触发；幂等（重复调不重复启动）
  stop(): Promise<void>;     // 优雅停：摄取循环退出 + 等在飞的 drain 消化完通道存量；不打断在飞的 execute/deliver
}
```

### 5.2 deriveEvent（derive-event.ts，纯函数）

```ts
/** 结果扇出的派生事件构造（纯函数）。调用方：入口循环 drain，业务执行完结后；
 *  构造结果由调用方判 hop_limit 后投入口队列与出口队列（或超限落库即死信） */
export function deriveEvent(
  upstream: EventEnvelope,   // 触发本次执行的上游事件
  producer: BusinessMatch,   // 产出方业务的匹配行（取 business_id）
  result: ExecutionResult,   // 本次执行结果（决定 event_type 与 payload 形态）
): EventEnvelope;
```

规则（逐条可测）：

1. `contract_version: 'v1'`；`event_id: newEventId()`（`evt_` 前缀，contracts 提供）；`timestamp: new Date().toISOString()`；
2. `source: 'internal'`；`producer_business_id: producer.business_id`；
3. `hop_count: upstream.hop_count + 1`；`correlation_id` 继承 upstream；`session_id` 继承 upstream（源生标识全链不变）；
4. **event_type**（本规格裁决，见 §9-A）：`result.status === 'success'` → `${producer.business_id}.completed`；否则（failed/timeout）→ `${producer.business_id}.failed`；
5. **payload**：success → `result.output`（原样，出口投递的就是它）；failed/timeout → `{ status: result.status, output: result.output ?? null }`（带失败状态，下游门禁验收）。

### 5.3 入口事件循环（entry-loop.ts）

```ts
/** 创建入口事件循环。装配纪律（调用方职责，本包不代做）：
 *  ① start 前装配根已 initLogger() 并对两条队列调过 recover()；
 *  ② channels 必须是本循环专用的 ChannelPool 实例（onActivate 每池单注册，两个循环各持一池） */
export function createEntryLoop(deps: {
  queue: TaskQueue;        // 入口队列
  exitQueue: TaskQueue;    // 出口队列（扇出的另一半）
  registry: BusinessRegistry;
  channels: ChannelPool;   // 入口专用池（与出口循环各持一个实例）
  config: PlatformConfig;
  driver: EntryDriver;
  options?: SchedulerOptions;
}): SchedulerLoop;
```

**摄取循环**（start 后跑到 stop；绝不执行任何业务，永远轻快）：

```text
while (!stopped):
  task = queue.take()
  if (!task) { await sleep(pollIntervalMs); continue }
  try:
    watchers = registry.match(task.event.source, task.event.event_type)
    if (watchers.length === 0):
      queue.complete(task.task_id)                       // 无关注者：正常完结
      log.info('无关注者，事件丢弃', {event_id, task_id, source, event_type})
      continue
    pending.set(task.task_id, watchers.length)           // 任务级完结计数（内存 Map）
    for (bm of watchers):
      key = buildBusinessChannelId(task.event.source, task.event.session_id, bm.business_id)
      channels.get(key).enqueue(task, bm)                // 空闲通道触发 onActivate → drain
  catch (err):                                            // 匹配/挂通道期意外异常（含毒任务）
    pending.delete(task.task_id)
    queue.deadLetter(task.task_id, 'dispatch_error')
    log.error('摄取派发异常，任务死信', {event_id, task_id, error})
```

**消化循环 drain**（`channels.onActivate(ch => 启动 drain(ch))`；一条通道同一时刻最多一个 drain——Channel 的 AsyncIterable 已保证；消化空即退出）：

```text
for await ({task, watcher: bm} of channel):
  await semaphore.acquire()                              // 业务闸门 = config.task_concurrency
  try:
    let result: ExecutionResult
    try:
      result = await driver.execute(task, bm)            // 分钟级长调用
    catch (err):
      result = { status: 'failed', output: undefined }   // 基础设施异常兜底：合成 failed
      log.error('业务执行抛异常', {event_id, task_id, business_id, channel_id, error})
    if (result.status === 'success' || bm.on_failure === true):
      next = deriveEvent(task.event, bm, result)
      if (next.hop_count > config.hop_limit):            // 判循环：两队落库留痕即死信
        t1 = queue.enqueue(next);  queue.deadLetter(t1.task_id, 'hop_limit')
        t2 = exitQueue.enqueue(next); exitQueue.deadLetter(t2.task_id, 'hop_limit')
        log.error('hop 超限，派生事件死信', {event_id: next.event_id, hop_count: next.hop_count})
      else:
        queue.enqueue(next)                              // 下游业务关注者消化
        exitQueue.enqueue(next)                          // 出口绑定投递
    // result.status 非 success 且 on_failure 未开：不扇出（下游天然不触发、出口无投递）
  finally:
    semaphore.release()
    settle(task)                                          // pending 计数 -1；归零 → queue.complete(task_id)
```

**纪律与边界**：

- 日志器：`logger.for({ module: 'entry-loop' })`；关键节点记 info（摄取、完结），异常记 error；fields 带 `event_id` / `task_id` / `channel_id` / `correlation_id`（有则带）。
- **at-least-once**：崩溃恢复后任务被重新 take、重新派发，已执行过的关注者可能重执行——语义如此，不去做重（业务幂等归业务）。
- 崩溃恢复（`recover()`）由装配根在 start 前调用，本包不调。
- `stop()`：置 stopped → 摄取循环在当前一轮结束后退出；await 全部在飞 drain .promise 落定。stop 后队列里 pending 任务原样保留（下次启动 recover 接回）。

### 5.4 出口事件循环（exit-loop.ts）

```ts
/** 创建出口事件循环。装配纪律同入口循环（start 前 initLogger + queue.recover()；
 *  channels 为出口专用池）。出口队列里应只有派生事件（producer_business_id 必在），
 *  缺失时本包防御性死信而非断言崩溃 */
export function createExitLoop(deps: {
  queue: TaskQueue;        // 出口队列
  registry: BusinessRegistry;
  channels: ChannelPool;   // 出口专用池
  config: PlatformConfig;
  driver: ExitDriver;
  options?: SchedulerOptions;
}): SchedulerLoop;
```

**摄取循环**：

```text
while (!stopped):
  task = queue.take()
  if (!task) { await sleep(pollIntervalMs); continue }
  try:
    producer = task.event.producer_business_id
    if (!producer):                                       // 防御：出口队列只装派生事件
      queue.deadLetter(task.task_id, 'missing_producer')
      log.error('出口任务缺 producer_business_id，死信', {event_id, task_id})
      continue
    bindings = registry.exitBindings(producer)            // 归属匹配
    if (bindings.length === 0):
      queue.complete(task.task_id)                        // 无出口绑定：丢弃无害
      log.info('无出口绑定，事件丢弃', {event_id, task_id, producer_business_id: producer})
      continue
    pending.set(task.task_id, { remaining: bindings.length, failed: 0 })
    for (b of bindings):
      try:
        key = buildExitChannelId(driver.destinationOf(b)) // 同目标串行
      catch (err):                                        // 未知工具/非法配置：该绑定直接判失败
        log.error('出口目标解析失败', {event_id, task_id, tool: b.tool, error})
        settle(task, /*failed*/ true)                     // 注意：此时尚未挂通道，直接结算
        continue
      channels.get(key).enqueue(task, b)
  catch (err):
    pending.delete(task.task_id)
    queue.deadLetter(task.task_id, 'dispatch_error')
    log.error('出口摄取派发异常，任务死信', {event_id, task_id, error})
```

**消化循环 drain**（有界重试在通道内原地进行——同目标本就该串行排队）：

```text
for await ({task, watcher: binding} of channel):
  await semaphore.acquire()                               // 出口闸门 = config.result_concurrency
  try:
    failed = false
    for (attempt = 1; attempt <= maxAttempts; attempt++):
      try:
        await driver.deliver(binding, task.event.payload) // 出口不做内容加工
        failed = false; break
      catch (err):
        if (attempt === maxAttempts):
          failed = true
          log.error('出口投递重试耗尽', {event_id, task_id, tool, channel_id, attempts, error})
        else:
          await sleep(min(baseDelayMs * 2^(attempt-1), maxDelayMs))
  finally:
    semaphore.release()
    settle(task, failed)   // remaining-1，failed 累计；remaining 归零时：
                           //   failed>0 → queue.deadLetter(task_id, 'deliver_failed')
                           //   否则     → queue.complete(task_id)
```

**纪律**：日志器 `logger.for({ module: 'exit-loop' })`；出口循环**不派生**新事件、**不参与** hop_count；投递 at-least-once（接收方凭 event_id 幂等）。

### 5.5 Semaphore（semaphore.ts）

```ts
export interface Semaphore {
  acquire(): Promise<void>;  // 无令牌则排队等（FIFO 唤醒）
  release(): void;           // 超发（release 多于 acquire）抛错
  readonly limit: number;
}
export function createSemaphore(limit: number): Semaphore; // limit 必须为正整数，否则抛错
```

## 6. 测试清单

测试用**真实** queue/registry/channel 实例（`openDatabase(':memory:')` + `createTaskQueue(db,'entry_tasks'/'exit_tasks')` + `createBusinessRegistry(db)` + `createChannelPool(db)`），driver 用假实现（记录调用顺序/时间戳、可控阻塞与抛错）。logger：`initLogger({ logsDir: 临时目录 })`，每个测试文件 beforeAll/afterAll 配 `resetForTests()`。options 注入小值（`pollIntervalMs: 5`、retry delay `1ms`）。每个用例结束 `await loop.stop()`。

**semaphore.test.ts**：并发上限不被突破（计数器峰值 ≤ limit）；release 后等待者放行；超发 release 抛错；limit<1 抛错。

**derive-event.test.ts**：success 全字段逐条断言（hop+1 / correlation 继承 / session 继承 / source='internal' / event_type=`b.completed` / payload=output 原样 / producer_business_id）；failed → event_type=`b.failed`、payload 包装 `{status, output}`；timeout → 同 failed；output 为 undefined 时 payload.output=null。

**entry-loop.test.ts**：

1. 无关注者 → 任务 done、driver 未被调；
2. 单关注者成功 → driver 收到 (task, bm)；两队各多出一条派生任务且字段正确；原任务 done；
3. 同通道串行：同 (source, session_id, business_id) 两事件 → driver 执行区间不重叠且顺序 = 入队序；
4. 跨通道并行：两个 session_id 各一事件 → driver 执行区间重叠（用 barrier 证明并行）；
5. 闸门生效：`task_concurrency=1` 时两个不同通道也串行；
6. 失败不扇出：`on_failure` 默认（false）+ driver 返回 failed → 两队均无新任务，原任务 done；
7. 失败扇出：`on_failure: true` + failed → 两队各有 `b.failed` 事件，payload 带 status；
8. driver 抛异常 → 合成 failed（行为同 6）；
9. hop 超限：入队 hop_count=hop_limit 的事件 → 执行完结后两队各有一条 dead 任务（reason `hop_limit`）、派生事件 event_id 可查，原任务 done；
10. 任务级完结计数：一事件两关注者（不同 business → 不同通道），快者完结后任务仍 processing，慢者完结后才 done；
11. 派发异常：registry.match 抛错（用代理 registry）→ 任务 dead（reason `dispatch_error`），循环继续消化后续任务。

**exit-loop.test.ts**：

1. 无出口绑定 → 任务 done、deliver 未被调；
2. 正常投递：deliver 收到 binding 与 `task.event.payload` 原样；任务 done；
3. 同目标串行：同一 destination 的两任务（或两绑定）→ deliver 区间不重叠、顺序 = 入队序；不同 destination → 并行；
4. 重试成功：deliver 前 2 次抛错第 3 次成功 → 共调 3 次、任务 done；
5. 重试耗尽：deliver 恒抛错（maxAttempts=3）→ 共调 3 次、任务 dead（reason `deliver_failed`）；
6. 缺 `producer_business_id` → 任务 dead（reason `missing_producer`）；
7. 多绑定一失败：两条绑定（不同 destination），一条恒失败一条成功 → 全部结算后任务 dead；
8. `destinationOf` 抛错（未知 tool）→ 该绑定判失败，任务 dead，另一绑定不受影响。

## 7. 验收标准

1. 包级 `build`/`test` 与根级六项检查（`yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular`）全绿；
2. §6 测试清单全覆盖；串行/并行类用例连跑 20 次不 flake；
3. 导出签名与 §5 一致；`dependencies` 不含未列出的包；
4. 全包无 `process.env`、无对 logger 外观以外的全局单例引用。

## 8. 导出清单（index.ts）

- 值：`createEntryLoop`、`createExitLoop`、`createSemaphore`、`deriveEvent`
- 类型：`PlatformConfig`、`ExecutionResult`、`EntryDriver`、`ExitDriver`、`SchedulerOptions`、`SchedulerLoop`、`Semaphore`

## 9. 本规格的裁决点（设计文档未覆盖，主 agent 已定）

- **A. 派生事件 event_type**：设计为「业务id.产出类型」（产出类型创建时声明），但 registry 未存产出类型、为不改 T4 定为 `${business_id}.completed` / `${business_id}.failed`（timeout 归 failed）。下游关注即订阅这两个 event_type。
- **B. 执行器注入边界**：循环只认 `EntryDriver.execute` / `ExitDriver.destinationOf+deliver`；「闸门通过后才组装 BusinessContext」等编排由驱动实现方（装配根接线时）保证，不在本包。
- **C. 派发期意外异常** → `deadLetter('dispatch_error')`：防止毒任务在 processing 间反复热循环。
- **D. 任务级完结计数在内存**：崩溃后由 recover + at-least-once 语义兜底，不做持久化计数。
- **E. 出口缺 producer_business_id** → `deadLetter('missing_producer')`（设计上"必在"，此处防御而非断言崩溃）。
- **F. 重试默认值** 3 次 / 1s 起步 / ×2 / 封顶 10s，经 SchedulerOptions 可覆盖。
