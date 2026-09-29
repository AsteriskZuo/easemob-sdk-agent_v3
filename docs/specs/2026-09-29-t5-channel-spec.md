# T5 channel 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/channel-model.md` §1–§3、`scheduler-loop-contracts.md` §7、§9.1、`core-modules.md` §4.3。

## 1. 目标

产出 `@easemob/agent-channel` 包：平台的**通道**原语——`ChannelPool`/`Channel`（同通道严格串行的虚拟执行链）+ `ChannelStore`（业务通道 ↔ agent 会话映射）。调度循环（T7）是消费方，本包不实现任何循环逻辑。

## 2. 背景知识（执行所需的最小上下文）

- **通道 = 平台的串行/隔离单位**，以 channel_id 字符串为键（由 `@easemob/agent-contracts` 的 `buildBusinessChannelId` / `buildExitChannelId` 产出，本包把它当不透明字符串，不解析）。规则：**同通道严格串行、跨通道自然并行**。
- 调度循环是两层结构：摄取循环把 (task, 关注者) 挂入各通道；**消化循环 drain 由通道触发**（通道挂入任务时经 `onActivate` 回调通知循环启动 drain）。一条通道同一时刻最多一个 drain 在跑 = 同通道串行；十条通道 = 十个 drain 并行 = 跨通道并行。通道"**用完即焚**"：消化空即 drain 退出，后续再有任务挂入则重新触发 onActivate。
- **Channel 是 AsyncIterable**：消化循环以 `for await (const { task, watcher } of channel)` 逐条取出挂入的项。
- **通道创建即落库**（防意外丢失），后续只做状态变更；通道上排队的项不单独持久化——任务本体已在任务队列（@easemob/agent-queue）里持久化，崩溃恢复由队列的 `recover()` 承担。
- **ChannelStore**：业务通道 channel_id ↔ agent-cli 会话 id 的映射表。大模型上下文由 agent-cli（pi）自己托管，平台只存映射。出口通道（`exit__` 前缀）不过 LLM、无 agent 会话，**不进本映射**。
- 数据访问只能经 `@easemob/agent-database`（migrate 机制建表，module 名 `'channel'`），禁止直接 import `node:sqlite`。

## 3. 范围与不做清单

**本任务做**：`createChannelPool` + `ChannelPool`/`Channel` + `createChannelStore` + `ChannelStore`。

**本任务不做**：

- 调度循环（摄取/匹配/drain/闸门，归 T7）；Semaphore、PlatformConfig（归 T7）；
- 入口适配器接口 EntryAdapter（归 T11 server 装配层）；
- agent 会话的创建/恢复/压缩执行（归 T10 AgentService；本包只存映射）；
- 通道级长期记忆 memory（设计留白，第一阶段不实现）。

## 4. 包结构

```text
packages/channel/
├── package.json            # @easemob/agent-channel
├── tsconfig.json
├── src/
│   ├── index.ts            # 统一导出
│   ├── channel-pool.ts     # Channel / ChannelPool
│   └── channel-store.ts    # ChannelStore
└── tests/
    ├── channel-pool.test.ts
    └── channel-store.test.ts
```

工程约定同 T0 spec §4。`dependencies`：`@easemob/agent-contracts`、`@easemob/agent-database`、`@easemob/agent-queue`（Task 类型）。

## 5. 详细规格

```ts
import type { Database } from '@easemob/agent-database';
import type { Task } from '@easemob/agent-queue';

/** 挂入通道的一项：任务 + 关注者（关注者类型各循环自定，本包不解释） */
export interface ChannelItem<T = unknown> {
  task: Task;      // 队列任务（本体已在任务队列持久化，此处只持有引用）
  watcher: T;      // 关注者：入口循环 = BusinessMatch，出口循环 = ExitBinding
}

/** 通道：同通道严格串行的虚拟执行链。AsyncIterable——消化循环 for await 逐项取出。
 *  迭代器在队列空时结束（用完即焚）；之后再有 enqueue 须能重新迭代（经 onActivate 重启 drain） */
export interface Channel extends AsyncIterable<ChannelItem> {
  readonly key: string;      // channel_id 字符串
  /** 挂入 (task, 关注者)；同通道上一次消化未完结则排队。空闲通道挂入时触发 onActivate */
  enqueue(task: Task, watcher: unknown): void;
}

/** 通道池：按 channel_id 取或建（创建即落库） */
export interface ChannelPool {
  /** 取或建通道；同键返回同一实例 */
  get(key: string): Channel;
  /** 通道激活回调：空闲通道挂入任务时触发（每个 ChannelPool 只注册一次） */
  onActivate(cb: (channel: Channel) => void): void;
}

/** 创建通道池。db 为全平台唯一数据访问口（@easemob/agent-database） */
export function createChannelPool(db: Database): ChannelPool;

/** 业务通道 channel_id ↔ agent-cli 会话 id 映射。只管业务通道（exit__ 前缀的键调用即抛错） */
export interface ChannelStore {
  /** 绑定/重绑：INSERT OR REPLACE 语义 */
  bindAgentSession(channelId: string, agentSessionId: string): void;
  /** 查映射；未命中返回 undefined */
  getAgentSession(channelId: string): string | undefined;
  /** 清空：解除映射；下次触发即重绑新会话（通道标识不变，历史按时间追溯） */
  clear(channelId: string): void;
}

/** 创建映射存储。与 ChannelPool 共用 module 'channel' 的同一份迁移 */
export function createChannelStore(db: Database): ChannelStore;
```

实现要点：

1. **迁移**（module `'channel'`）：v1 = 两表——`channels`（channel_id PK, created_at, last_active_at）；`channel_sessions`（channel_id PK, agent_session_id, updated_at）。
2. **ChannelPool.get**：无则建（内存 Map + `channels` 表 INSERT OR IGNORE + last_active_at 更新），有则取。
3. **串行与激活的正确性是本包核心**，必须满足的语义：
   - 同通道的项严格按 enqueue 顺序被迭代取出，同一时刻最多一个活跃迭代器；
   - 迭代器在"取出最后一项、队列空"时结束；
   - **竞态纪律**：enqueue 发生在"迭代器已判定空、但 onActivate 状态未复位"的窗口时，任务不得丢失也不得被两个 drain 并发消化——用通道级 `draining` 标志（JS 单线程）保证：enqueue 时若 `!draining` 则置位并触发 onActivate 回调；迭代器结束（含异常退出）时复位。建议迭代器实现用"有界等待"（队列空时短轮询/事件等待一小段时间再判结束），并在测试中验证竞态；
   - 迭代中的项被消费即弃（不重试——重试语义归上层循环/队列）。
4. **ChannelStore**：exit 通道防护——channelId 以 `exit__` 开头时三个方法都抛错；bind 用 INSERT OR REPLACE；clear 用 DELETE（不存在幂等）；getAgentSession 未命中返回 undefined。
5. 时间戳统一 `new Date().toISOString()`。

## 6. 测试清单

**channel-pool.test.ts**
- get 同键返回同一 Channel 实例；不同键不同实例；
- 串行性：同通道 enqueue 三项，for await 消费顺序一致；模拟慢消费（await 延迟）期间再 enqueue，仍严格有序；
- 并行性：两个通道各自消费互不阻塞（用完成顺序/时间证明并行）；
- 用完即焚 + 重启：迭代器结束后再 enqueue → onActivate 再次触发、新迭代正常消费；
- onActivate 只在空闲通道挂入时触发（drain 进行中 enqueue 不重复触发——用计数断言）；
- 竞态：迭代器判空退出的同时 enqueue（用微任务时序构造），任务不丢失；
- 落库：get 创建通道后 `channels` 表有记录（channel_id/created_at），重开数据库后记录仍在；
- watcher 为任意对象原样透传。

**channel-store.test.ts**
- bind → getAgentSession 命中；rebind 覆盖；clear 后未命中；
- 未命中返回 undefined；clear 不存在的键幂等；
- `exit__xxx` 键三个方法都抛错；
- 持久化：close 重开后映射仍在。

## 7. 验收标准

1. 包级与根级六项检查全绿；
2. 只 import `@easemob/agent-contracts`、`@easemob/agent-database`、`@easemob/agent-queue`、`node:*`；
3. 导出签名与本文 §5 一致；
4. 串行性/竞态测试稳定通过（连跑 10 次不 flake）。
