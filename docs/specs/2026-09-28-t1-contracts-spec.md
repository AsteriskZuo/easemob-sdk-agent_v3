# T1 contracts 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/event-contract.md`、`channel-model.md`。

## 1. 目标

产出 `@asteriskzuo/agent-contracts` 包：事件信封 v1 类型与校验、channel_id 编解码、id 生成。**零运行时依赖、纯类型 + 机械函数**，是全部后续包的共同地基。

## 2. 背景知识（执行所需的最小上下文）

**事件信封**：平台内一切事件的统一包装。外部事件（webhook、企微消息等）进入平台时被入口模块包装成信封落队列；业务处理完产出新信封再派发给后续业务与出口。信封带 `contract_version` 字段承担版本路由，因此**类型名不缀版本号**——未来 v2 到来时再处理，届时靠 `contract_version` 值区分。

信封字段语义（写校验与测试需要理解）：

| 字段 | 语义 |
|------|------|
| `contract_version` | 信封结构版本，当前恒为 `'v1'` |
| `source` | 入口来源：wecom / jira / github / webhook / cron / internal / manual |
| `event_id` | 全局唯一锚点，兼作入口幂等键（同一源生事件重推时按它识别丢弃） |
| `event_type` | 事件的类别标签（非实例标识），是业务关注匹配的键 |
| `timestamp` | 入口接收并包装任务的时间，ISO 8601 带时区 |
| `session_id` | 源生会话标识（群 id / 工单 key 等），必填，平台视为不透明字符串 |
| `correlation_id` | 等于整条派生链首个任务的 event_id，用于全链追溯 |
| `hop_count` | 派生转发计数器，防 A→B→A 循环订阅 |
| `payload` | 事件数据载体，结构由来源自定义 |
| `producer_business_id` | 可选，仅 internal 派生事件填写 = 产出方业务 id，出口循环按它做归属匹配 |

**channel_id（通道标识）**：平台的串行/隔离单位，复合键用双下划线 `__` 连接。

- **业务通道** = `source__session_id__business_id` 三维，例：`wecom__wmAb3xK9Qf__b01J8xk`。同通道串行、跨通道并行。
- **出口通道** = `exit__destination_id` 两维，例：`exit__wmAb3xK9Qf`（投向同一企微群的全部通知串行）。
- **destination_id** = 投递目标标识，由出口工具从绑定配置提取（提取逻辑不在本包）。形态举例：企微群 webhook 的 key 段、收件人邮箱地址、规范化的仓库地址 `github.com_AsteriskZuo_im_flutter_sdk`、jira 站点+工单 key `j1.private.easemob.com_HIM-23363`。
- 各段必须**文件路径安全**：channel_id 会出现在日志与目录名中，段内禁止 `/`、`\`、`:` 等路径分隔字符；禁止段内出现 `__`（否则无法拆分解析）。
- source 枚举中没有 `exit`，故 `exit` 前缀天然保留给出口通道，解析无歧义。

## 3. 范围与不做清单

**本任务做**：事件信封 v1 类型与校验、channel_id 编解码、ULID/event_id 生成。

**本任务不做**：

- 业务流程程序的 stdin/stdout 进程契约 → 归 T8，届时补入本包；
- 管理 API（console ↔ server）契约 → 归 T11，届时补入本包；
- 业务语义去重 → **已定决策：归业务流程程序自行处理**（平台不了解业务细节，不定规范、不提供字段；业务自行判重，如同一工单只审一次）。信封中不存在去重字段；平台侧只有 `event_id` 承担入口幂等；
- `destinationOf`（从出口绑定配置提取 destination_id）→ 归 T7 各出口工具，本包只提供出口 channel_id 的拼装；
- 任何持久化、IO、网络代码。

## 4. 包结构

```text
packages/contracts/
├── src/
│   ├── index.ts          # 统一导出
│   ├── envelope.ts       # 信封类型 + 校验
│   ├── channel-id.ts     # channel_id 编解码
│   └── id.ts             # ULID / event_id 生成
└── tests/
    ├── envelope.test.ts
    ├── channel-id.test.ts
    └── id.test.ts
```

`package.json`：`"name": "@asteriskzuo/agent-contracts"`，`"dependencies": {}`（必须为空）。

## 5. 详细规格

### 5.1 envelope.ts

```ts
export const CONTRACT_VERSION = 'v1' as const;
export type ContractVersion = typeof CONTRACT_VERSION;

/** 入口来源枚举；新增来源 = 扩展此联合类型（向后兼容） */
export type EventSource =
  | 'wecom' | 'jira' | 'github' | 'webhook' | 'cron' | 'internal' | 'manual';

export interface EventEnvelope {
  contract_version: ContractVersion; // 信封结构版本，恒为 'v1'；版本路由靠它，类型名不缀版本号
  source: EventSource;               // 入口来源（internal = 平台内派生事件）
  event_id: string;                  // 全局唯一锚点，兼作入口幂等键（源生事件重推按它丢弃）
  event_type: string;                // 类别标签（非实例标识），业务关注匹配的键
  timestamp: string;             // ISO 8601 带时区
  session_id: string;                // 源生会话标识（群 id / 工单 key 等），不透明字符串
  correlation_id: string;            // 整条派生链首个任务的 event_id，全链追溯用
  hop_count: number;                 // 派生转发计数（派生 +1），防循环订阅
  payload: unknown;                  // 事件数据载体，结构由来源自定义；派生事件的 payload = 业务产出
  producer_business_id?: string; // 仅 internal 派生事件填写
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/** 机械校验：结构/类型/取值域，不查业务语义。不识别的字段忽略（向后兼容规则） */
export function validateEnvelope(input: unknown): ValidationResult;
```

校验规则（逐条可测）：

1. 是 plain object；必填字段全部存在；
2. `contract_version === 'v1'`；
3. `source` 在枚举内；`event_id` / `event_type` / `session_id` / `correlation_id` 为非空字符串；
4. `timestamp` 是合法 ISO 8601（`Date.parse` 可解析且含时区偏移）；
5. `hop_count` 为 >= 0 的整数；
6. `producer_business_id` 若存在必须是非空字符串；
7. 返回全部错误（`errors` 数组），不遇到第一个就停。

### 5.2 channel-id.ts

```ts
export const SEGMENT_SEPARATOR = '__';

export type ChannelId =
  | { kind: 'business'; source: string; sessionId: string; businessId: string } // 业务通道三维
  | { kind: 'exit'; destinationId: string }; // 出口通道：投递目标标识

/** 段合法性：非空、不含 '__'、不含 '/' '\\' ':' 及控制字符；非法抛 ChannelIdError */
export function assertSafeSegment(segment: string): void;

export function buildBusinessChannelId(
  source: string, sessionId: string, businessId: string,
): string; // 每段过 assertSafeSegment

export function buildExitChannelId(destinationId: string): string; // 'exit' + '__' + destinationId

/** 解析；格式非法抛 ChannelIdError。'exit__' 前缀判为出口通道，否则按三段拆 */
export function parseChannelId(id: string): ChannelId;

export class ChannelIdError extends Error {}
```

### 5.3 id.ts

```ts
/** 手写 ULID：26 字符 Crockford base32 = 48bit 毫秒时间戳 + 80bit 随机（node:crypto） */
export function newUlid(): string;

/** 事件 id：'evt_' + ulid（ULID 为标准大写 Crockford base32，对应设计示例 evt_01J...） */
export function newEventId(): string;
```

不引入 ulid 依赖包（实现约 50 行，零依赖原则）。

## 6. 测试清单

**envelope.test.ts**
- 合法信封（含/不含 producer_business_id）→ ok；
- 缺每个必填字段各一例 → 报对应错误；
- contract_version 非 v1、source 枚举外、hop_count 负数/非整数、timestamp 无时区 → 报错；
- 携带未知额外字段 → ok（兼容规则）；
- 多错误同时存在 → errors 数组全部列出。

**channel-id.test.ts**
- 业务通道 build → parse 往返一致；
- 出口通道 build → parse 往返一致；
- 段含 `__`、`/`、`:`、空段 → 抛 ChannelIdError；
- `exit` 前缀的 id 解析为出口通道；
- 单下划线 `_` 的段合法（如 `github.com_AsteriskZuo_im_flutter_sdk`）。

**id.test.ts**
- newUlid 格式：26 字符、Crockford base32 字符集；
- newEventId 前缀 `evt_`；
- 连发 10000 个无重复。

## 7. 验收标准

1. 该包 `build` / `test` / `typecheck` / `lint` / `format:check` 全绿；
2. `dependencies` 为空；
3. dpdm 无循环依赖；
4. 导出签名与本文 §5 一致（评审逐条核对）。
