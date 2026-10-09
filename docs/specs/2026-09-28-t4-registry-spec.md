# T4 registry 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/scheduler-loop-contracts.md` §3、§6。

## 1. 目标

产出 `@asteriskzuo/agent-registry` 包：业务注册表——**业务配置（含出口绑定）的统一读写口 + 两个调度循环的匹配视图**。查询与修改只有这一个接口，内部模块与（将来的）控制台共用，没有第二套。

## 2. 背景知识（执行所需的最小上下文）

- 平台心脏是两个调度循环。**入口循环**拿到事件后按 `(source, event_type)` 做**订阅匹配**找出关注该事件的业务集合（无关注者 = 丢弃，正常）；**出口循环**按事件信封里的 `producer_business_id` 做**归属匹配**，取产出方业务的出口绑定逐条投递（无绑定 = 丢弃，正常）。两条匹配路径的查询口都在本包。
- **业务与入口一对多**：一个业务可配多个入口（每个 `(source, event_type)` 组合一行匹配记录）；常规场景一个业务一行。行级字段 = source/event_type；业务级字段（business_name/creator_id/on_failure/出口绑定）各行一致。
- **业务与出口一对多**：一个业务可同时绑定多个出口工具（如审查工单的结果同时发企微群 + 邮件 + jira），`exit_bindings` 是数组，业务完结时出口循环逐绑定投递。**多业务也可绑同一工具**（如同一个企微群 webhook），路由按 business_id 隔离——A 的结果永远触发不了 B 的出口。
- `on_failure`：业务执行失败时是否也派生结果事件（默认 false = 失败不扇出）。
- **出口绑定 ExitBinding** = 出口工具 kind + 非机密配置（Record<string, string>）。机密项（token 等）不在此处存储（归环境配置模块，后续任务）。
- 匹配是热路径：**匹配视图常驻内存**，写操作 write-through（先落库后更新内存）；SQLite 落库保证重启不丢。
- 数据访问只能经 `@asteriskzuo/agent-database`，禁止直接 import `node:sqlite`。
- `EventSource` 类型从 `@asteriskzuo/agent-contracts` import。

## 3. 范围与不做清单

**本任务做**：`createBusinessRegistry` 工厂 + 注册表接口（匹配/读/写）。

**本任务不做**：

- 业务的工作区、提示词、程序包等"重数据"组装（归 ContextLoader，后续批次）；
- 权限校验（actor/权限规则归设置模块与控制台，后续批次）；
- 出口工具本身的实现（归 T8 exit-tools；本包只存绑定的 kind + config 数据）。

## 4. 包结构

```text
packages/registry/
├── package.json            # @asteriskzuo/agent-registry
├── tsconfig.json
├── src/
│   ├── index.ts            # 统一导出
│   └── business-registry.ts
└── tests/
    └── business-registry.test.ts
```

工程约定同 T0 spec §4。`dependencies`：`@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-database`。

## 5. 详细规格

```ts
import type { Database } from '@asteriskzuo/agent-database';
import type { EventSource } from '@asteriskzuo/agent-contracts';

/** 匹配视图：注册表执行视图的一行。无 order/depends_on 字段——链内并行，
 *  顺序靠事件订阅表达 */
export interface BusinessMatch {
  business_id: string;        // 创建时生成、不可修改，一切内部引用的锚
  business_name: string;      // 展示名，可修改，不参与匹配
  creator_id: string;         // 创建者，不可修改（权限归属判定用）
  source: EventSource;        // 关注的来源（行级）
  event_type: string;         // 关注的事件类型（行级）
  on_failure?: boolean;       // 失败也扇出；默认 false
}

/** 出口绑定：业务配置的一部分。config 只存非机密项 */
export interface ExitBinding {
  business_id: string;       // 归属业务 = 出口循环的归属匹配键
  tool: string;               // 出口工具 kind
  config: Record<string, string>;
}

/** 业务级字段补丁（行级字段 source/event_type 不可 patch——改匹配 = 增删行） */
export interface BusinessPatch {
  business_name?: string;          // 展示名
  on_failure?: boolean;            // 失败也扇出开关
  exit_bindings?: ExitBinding[];   // 全量替换该业务的出口绑定
}

/** 创建业务输入（含首个匹配行） */
export interface CreateBusinessInput {
  business_name: string;      // 展示名，可修改
  creator_id: string;         // 创建者账号 id，不可修改（权限归属判定用）
  source: EventSource;        // 首个匹配行
  event_type: string;
  on_failure?: boolean;       // 缺省 false
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>; // 缺省无绑定
}

export interface BusinessRegistry {
  /** 入口循环订阅匹配（热路径，走内存视图）；无关注者返回空数组 */
  match(source: EventSource, event_type: string): BusinessMatch[];

  /** 出口循环归属匹配：产出方业务的全部出口绑定；无绑定返回空数组 */
  exitBindings(business_id: string): ExitBinding[];

  /** 取业务的全部匹配行（一对多）；业务不存在返回空数组 */
  get(business_id: string): BusinessMatch[];

  /** 更新业务级字段（对该业务所有行生效）；业务不存在抛错 */
  update(business_id: string, patch: BusinessPatch): void;

  /** 创建业务（含首个匹配行），返回 business_id */
  create(input: CreateBusinessInput): string;

  /** 增删匹配行 = 增删入口/关注。addMatch 重复 (business_id,source,event_type) 幂等不报错 */
  addMatch(business_id: string, source: EventSource, event_type: string): void;
  removeMatch(business_id: string, source: EventSource, event_type: string): void;

  /** 删除业务（匹配行、出口绑定一并删）；不存在幂等不报错 */
  remove(business_id: string): void;
}

/** 创建注册表。启动时从 SQLite 加载全量匹配行进内存视图 */
export function createBusinessRegistry(db: Database): BusinessRegistry;
```

实现要点：

1. 两张表以**迁移列表**声明（database 包的 `migrate` 机制，module 用 `'registry'`）：v1 = `businesses`（business_id PK, business_name, creator_id, on_failure INTEGER, exit_bindings TEXT JSON）+ `business_matches`（business_id, source, event_type，UNIQUE(business_id, source, event_type)）。
2. `business_id` 生成：`'b' + newUlid()`（contracts 提供）。
3. 内存视图：`Map<string /* `${source}__${event_type}` */, BusinessMatch[]>`；工厂函数启动时全量加载；create/addMatch/removeMatch/remove/update 全部 write-through（transaction 落库 + 更新内存）。
4. 设计缺口补充说明（已在 §5 接口内体现，供评审知悉）：设计契约只定义了 match/exitBindings/get/update 四个方法，写入面（create/addMatch/removeMatch/remove）是控制台落地所必需，本 spec 补齐最小集，已避开任何多余字段。
5. `update` 只接受业务级字段（BusinessPatch 类型上就不含 source/event_type/business_id/creator_id）。

## 6. 测试清单

- create → get 返回一行，字段一致；business_id 以 `b` 开头；
- addMatch 第二行 → get 返回两行；match 对两个 (source, event_type) 组合各自命中；
- match 无关注者 → 空数组（不抛错）；
- 同 (source, event_type) 多业务 → match 全部返回；
- exit_bindings：create 时写入 → exitBindings 读回一致；**一个业务绑定多个出口工具 → exitBindings 返回全部、顺序保持**；无绑定业务 → 空数组；update 全量替换生效；
- update 改 business_name/on_failure → get 的所有行都反映新值；
- update 不存在的 business_id → 抛错；
- addMatch 重复 → 幂等（get 行数不增）；removeMatch → match 不再命中；
- remove → get/match/exitBindings 全部为空；remove 不存在业务 → 不抛错；
- 持久化：写入后 close 数据库重开 → 新注册表实例 match/get 结果一致（内存视图正确重建）。

## 7. 验收标准

1. 包级与根级六项检查全绿；
2. 只 import `@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-database`、`node:*`；
3. 导出签名与本文 §5 一致。
