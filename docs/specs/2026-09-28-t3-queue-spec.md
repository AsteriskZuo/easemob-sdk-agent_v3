# T3 queue 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/scheduler-loop-contracts.md` §2、`event-contract.md` §3、`scheduler.md` §2。

## 1. 目标

产出 `@asteriskzuo/agent-queue` 包：SQLite 持久化任务队列。**平台有两条队列——入口队列与出口队列，同一实现、两个实例**（构造时传不同表名）。

## 2. 背景知识（执行所需的最小上下文）

- 平台的"心脏"是两个调度循环（入口循环消化外部/内部事件，出口循环消化结果投递），各自从自己的队列摄取任务。队列是它们的统一缓冲带。
- 队列信条：**事件进来即持久化，落库才算收到**——崩溃后可找回，杜绝"内存里丢了就永远丢了"；取出不删、完结才标记。事件的加入与获取是低频操作，持久化不是性能瓶颈。
- 队列里的任务 = 事件信封 + 消化状态。事件信封 `EventEnvelope` 已在 `@asteriskzuo/agent-contracts` 定义（含 `validateEnvelope` 校验函数、`newUlid`），直接 import 使用。
- 数据访问只能经 `@asteriskzuo/agent-database` 的 `Database` 接口（全平台唯一数据访问口），禁止直接 import `node:sqlite`。
- **第一层入口幂等**：同一源生事件可能被上游重推（webhook 超时重发是常态）。队列在 `event_id` 上去重：同一队列实例内重复 `event_id` 的 `enqueue` 不产生新任务，幂等返回已有任务。
- **数据增长**：任务只增不减会无限膨胀。保留策略（已定）：**done 任务超期清除**（保留天数是策略、归 server 调用方，默认建议 30 天；本包只提供 `purge` 原语）；**dead 任务不自动清**（量小、排查价值高，人工处置）；pending/processing 绝不动。归档导出（清除前导出 JSONL 留存）本版不做——出现真实审计需求时单独立项，`purge` 之前串一步导出即可，接口不变。

## 3. 范围与不做清单

**本任务做**：`createTaskQueue` 工厂 + `TaskQueue` 接口（enqueue/take/complete/deadLetter/query/recover）。

**本任务不做**：

- 调度循环逻辑（匹配、通道、并发闸门都在 `@asteriskzuo/agent-scheduler`，T7）；
- 死信的告警通知（调用方职责）；
- 阻塞式 take（空队列返回 `null` 即可，空转/阻塞策略归调度循环）；
- 并行 worker 接口（第一阶段不预留，设计已定）。

## 4. 包结构

```text
packages/queue/
├── package.json            # @asteriskzuo/agent-queue
├── tsconfig.json
├── src/
│   ├── index.ts            # 统一导出
│   └── task-queue.ts
└── tests/
    └── task-queue.test.ts
```

工程约定同 T0 spec §4（含包级 devDependencies 自声明）。`dependencies` 声明：`@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-database`（版本 `0.1.0`，yarn workspaces 透明解析）。

## 5. 详细规格

```ts
import type { Database } from '@asteriskzuo/agent-database';
import type { EventEnvelope } from '@asteriskzuo/agent-contracts';

export type TaskStatus = 'pending' | 'processing' | 'done' | 'dead';

/** 队列中的任务 = 事件 + 消化状态 */
export interface Task {
  task_id: string;           // 任务 id：'task_' + ULID，入队时生成
  event: EventEnvelope;      // 任务携带的事件信封（落库为 JSON）
  status: TaskStatus;
  enqueued_at: string;   // ISO 8601
  finished_at?: string;  // complete/deadLetter 时写入
}

/** 控制台查询过滤条件；多条件为 AND，空 filter 返回全部 */
export interface TaskFilter {
  status?: TaskStatus;
  event_id?: string;
  correlation_id?: string;   // 按信封内 correlation_id 过滤（json_extract）
}

export interface TaskQueue {
  /** 落库才算收到。先过 validateEnvelope（fail-closed，不过则抛错）；
   *  event_id 幂等：同表已有该 event_id 则返回已有任务、不产生新行 */
  enqueue(event: EventEnvelope): Task;

  /** FIFO 取下一个 pending 并置为 processing；无 pending 返回 null */
  take(): Task | null;

  /** 消化完结（含"无关注者"的正常完结）；置 done + finished_at */
  complete(task_id: string): void;

  /** 死信（hop_count 超阈值、投递重试耗尽等）；置 dead + finished_at + reason 落库 */
  deadLetter(task_id: string, reason: string): void;

  /** 查询面（控制台用，最小集） */
  query(filter: TaskFilter): Task[];

  /** 崩溃恢复：启动时调用一次，把残留 processing 重置回 pending，返回重置条数 */
  recover(): number;

  /** 数据保留：删除 status=done 且 finished_at 早于 cutoffIso 的任务，返回删除条数。
   *  dead 不删（排查价值）、pending/processing 绝不删 */
  purge(cutoffIso: string): number;
}

/** 创建队列实例。table 由调用方命名（平台用 'entry_tasks' / 'exit_tasks'）；
 *  建表用幂等 CREATE TABLE IF NOT EXISTS */
export function createTaskQueue(db: Database, table: string): TaskQueue;
```

实现要点：

1. 表结构以**迁移列表**声明（database 包的 `migrate` 机制）：v1 = 建表 `task_id` TEXT PK、`event_id` TEXT UNIQUE（幂等键）、`event` TEXT（信封 JSON 序列化）、`status` TEXT、`enqueued_at` TEXT、`finished_at` TEXT NULL、`dead_reason` TEXT NULL；索引 `(status, enqueued_at)`。表名含实例名（迁移的 module 参数用 `'queue:' + table` 区分两个实例）。
2. `task_id` 生成：`'task_' + newUlid()`（contracts 提供）。
3. 时间戳统一 `new Date().toISOString()`（UTC 带 Z，满足"ISO 8601 带时区"）。
4. `take()` 的 FIFO 依据：`enqueued_at` 相同毫秒时以 `rowid` 兜底排序（`ORDER BY enqueued_at, rowid`）；取出与置 processing 在同一 `transaction` 内。
5. `enqueue` 幂等实现：先 `get` 按 event_id 查，命中直接返回该任务；未命中再插入。用 UNIQUE 约束兜底并发冲突。
6. `complete` / `deadLetter` 对不存在的 task_id：抛错（fail-closed，暴露调用方 bug）。
7. `purge(cutoffIso)`：单条 `DELETE WHERE status='done' AND finished_at < cutoffIso`；finished_at 为字符串 ISO 时间，字典序即时间序（统一 UTC Z 格式保证）。

## 6. 测试清单

`tests/task-queue.test.ts`（用临时文件数据库）：

- enqueue → query 能查到，status=pending，字段完整；
- 非法信封 enqueue → 抛错、不落库；
- 同 event_id 重复 enqueue → 返回同一 task_id，行数不增；
- take 的 FIFO 序：入队 A、B、C → 依次取出 A、B、C；空队列 take 返回 null；
- take 后状态 = processing；complete 后 = done 且有 finished_at；
- deadLetter 后 = dead 且 reason 可查（query 或 get 验证）；
- query 三种 filter 各自生效；
- recover：制造 processing 残留 → recover() 后变 pending、返回条数正确、可被 take 重新取出；
- purge：done 且超期的被删、返回条数正确；done 未超期 / dead / pending / processing 均不受影响；
- 持久化：enqueue 后 close 数据库、重开、任务仍在且状态不变（含迁移幂等：重开不重复建表）；
- 两个实例（entry_tasks / exit_tasks）同库共存、互不干扰（同 event_id 可分别入两队）。

## 7. 验收标准

1. 包级与根级六项检查全绿；
2. 只 import `@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-database`、`node:*`；
3. 导出签名与本文 §5 一致。
