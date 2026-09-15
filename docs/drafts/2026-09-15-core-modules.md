# 核心模块与接口（草稿）

> 日期：2026-09-15
> 状态：草稿，讨论用，未定稿
> 范围：**核心模块清单 + 各模块公开接口（TS）+ 工程结构**。已在《调度循环契约》《设置模块契约》草稿中定义的接口（Event、TaskQueue、BusinessRegistry、ProcessingChain、BusinessContext、Lifecycle、Channel/ChannelPool、Semaphore、PlatformConfig、ConfigStore）此处只引用不重复。
> 依据：骨架 `skill-platform-spec-v3.md` §2 架构分层 + `design/` 各节点文档 + 前两份契约草稿。
> 纪律：模块间只许通过本文档列出的公开接口调用，禁止跨模块直接引用内部实现（骨架 §2 命门）。
> 技术栈：**Node.js 24（LTS）+ yarn 4.14.1（corepack 启用）+ TypeScript 5.x（strict）**。

---

## 1. 模块全景

树状总览（层级 = 骨架分层，叶子 = 模块）：

```
easemob-agent（模块化单体）
├── 入口模块群                       # 每事件源一个独立小模块，只消费队列/会话/日志
│   ├── 企业微信入口 EntryAdapter(wecom)
│   ├── Jira 入口    EntryAdapter(jira)
│   ├── GitHub 入口  EntryAdapter(github)
│   └── 定时/手动    CronTimer / manual
├── 编排内核（平台心脏）
│   ├── 调度循环     SchedulerLoop    # 唯一主循环：摄取 + 各通道消化
│   ├── 任务队列     TaskQueue        # SQLite 持久化，FIFO
│   ├── 业务注册表   BusinessRegistry # 匹配视图 + 业务配置统一读写口
│   ├── 业务组装器   ContextLoader    # 匹配通过后才组装重数据
│   ├── 生命周期     Lifecycle        # 单次执行，跑完即销毁
│   └── Agent 适配槽 AgentSlot        # 调用 agent-cli 的唯一通道，适配器要薄
├── Skill 包仓（动态加载）
│   └── Skill 注册表 SkillRegistry    # public / private，hash 兼任 id
├── 平台公共模块
│   ├── 会话模块     SessionStore     # 两类映射 + 四操作的平台侧部分
│   ├── 环境配置     EnvProvider      # 通用/专用 key-value，业务级优先
│   ├── 设置模块     ConfigStore      # 全局/业务设置，含权限校验
│   └── 日志模块     Logger           # 三层日志，脱敏内建
├── 基础设施与工具                   # 被所有模块依赖，不反向依赖任何业务模块
│   ├── 数据库       Database         # SQLite 薄封装，全平台唯一数据访问口
│   ├── 标识生成     IdGen            # event_id / task_id / lifecycle_id / 随机段
│   └── 时钟         Clock            # 时间戳统一来源（信封/日志/session_id）
└── 控制台 Console                   # 开关与仪表盘集合，无业务逻辑
    └── 账号体系（单独文档）
```

说明：**「出口模块群」不再出现在树里**（已定决策）——出口 = 队列中的可选任务，由出口型业务消化；触达外部的能力以 public skill 形式由 Skill 包仓提供。

模块明细：

| # | 模块 | 层 | 一句话职责 | 公开接口 | 主要消费方 |
|---|------|----|-----------|---------|-----------|
| 1 | 入口适配器群 EntryAdapter | 入口 | 验签 → 包装信封（含 session_id）→ 落队，立即返回 | 无对外接口（只消费队列/会话/日志） | — |
| 2 | 定时器 CronTimer | 入口 | 到点包装任务入队，不直接执行 | 同上 | — |
| 3 | 任务队列 TaskQueue | 内核 | 统一缓冲带：FIFO、SQLite 持久化、状态机 | `TaskQueue`（循环契约 §2） | 入口群、调度循环、控制台 |
| 4 | 业务注册表 BusinessRegistry | 内核 | 业务匹配视图 + 业务配置统一读写口 | `BusinessRegistry`（循环契约 §3） | 调度循环、控制台、设置模块 |
| 5 | 调度循环 SchedulerLoop | 内核 | 心脏：摄取 + 各通道消化 | 无（是消费方，见循环契约 §8） | — |
| 6 | 业务组装器 ContextLoader | 内核 | 匹配通过后才组装重数据为 BusinessContext | `ContextLoader`（§4.1） | 调度循环 |
| 7 | 生命周期 Lifecycle | 内核 | 单次执行、跑完即销毁、统一打标埋点 | `Lifecycle`（循环契约 §5） | 调度循环、控制台（业务标记投影） |
| 8 | Agent 适配槽 AgentSlot | 内核 | 统一调用 agent-cli 的唯一通道，适配器要薄 | `AgentSlot`（§4.2） | 生命周期 |
| 9 | 会话模块 SessionStore | 公共 | 两类映射 + 四操作中的平台侧部分 | `SessionStore`（§4.3） | 入口群、业务组装器 |
| 10 | Skill 注册表 SkillRegistry | Skill 仓 | 登记/列表/取用 skill 包，hash 兼任 id | `SkillRegistry`（§4.4） | 控制台、业务组装器 |
| 11 | 环境配置 EnvProvider | 公共 | 按业务合并通用/专用 key-value，运行时注入 | `EnvProvider`（§4.5） | 业务组装器、控制台 |
| 12 | 设置模块 ConfigStore | 公共 | 全局/业务设置统一读写（含权限校验） | `ConfigStore`（设置契约） | 控制台、内核各模块（只读） |
| 13 | 日志模块 Logger | 公共 | 三层日志、四级契约性输出、脱敏内建 | `Logger`（§4.6） | 全部模块 |
| 14 | 数据库 Database | 基础设施 | SQLite 薄封装：全平台唯一数据访问口，保薄抽象 | `Database`（§4.7） | 全部持久化模块 |
| 15 | 标识生成 IdGen | 基础设施 | 各类 id 与随机段的唯一生成口 | `IdGen`（§4.7） | 入口群、内核 |
| 16 | 时钟 Clock | 基础设施 | 时间戳统一来源（信封 timestamp、日志、session_id 时间戳段） | `Clock`（§4.7） | 全部模块 |
| 17 | 控制台 Console | 控制台 | 开关与仪表盘集合，本身无业务逻辑 | 无（是纯消费方） | — |

---

## 2. 依赖纪律（允许的方向）

```
入口群 ──▶ TaskQueue / SessionStore / Logger
调度循环 ──▶ TaskQueue / BusinessRegistry / ContextLoader / Lifecycle / PlatformConfig / Logger
ContextLoader ──▶ BusinessRegistry / SkillRegistry / EnvProvider / SessionStore
Lifecycle ──▶ AgentSlot / Logger
Console ──▶ 全部公开接口（只经接口，不碰内部存储；与内部模块共用同一套读写口）
全部模块 ──▶ infra（Database / IdGen / Clock）——基础设施不反向依赖
业务 = 注册表里的数据行，不是模块，不被 import
```

- **心脏不认识业务**：SchedulerLoop 只读信封字段与匹配视图；业务细节（提示词、skill、agent 配置）全部封在 ContextLoader 组装出的 BusinessContext 里；
- **出入口对称**：新事件源 = 新增一个入口小模块；新通知目的地 = 新增/选用一个出口型业务（skill 已在仓里）——都不动内核；
- **配置只有一个家**：结构化业务字段归 BusinessRegistry，可调参数归 ConfigStore，环境/密钥归 EnvProvider（见设置契约 §7）。

---

## 3. 已定义接口索引（不重复，出处为准）

| 契约 | 定义处 |
|------|--------|
| Event / EventSource / ChannelKey | 循环契约 §1（语义权威：`design/event-contract.md`） |
| Task / TaskQueue | 循环契约 §2 |
| BusinessRegistry / BusinessMatch / Dependency / ProcessingChain | 循环契约 §3 |
| BusinessContext 及其成员（PromptObject、SkillObject、AgentCliObject、ModelObject、EnvConfig、SessionRef） | 循环契约 §4 |
| Lifecycle / ExecutionResult / ResultDisposition / Gate / ChainContext | 循环契约 §5 |
| Channel / ChannelPool / Semaphore / PlatformConfig | 循环契约 §6 |
| ConfigStore / ConfigScope / ConfigKeyDef / User（最小形状） | 设置契约 §3–5 |

---

## 4. 缺口接口定义（本文档的新增内容）

### 4.1 业务组装器 ContextLoader

匹配、依赖、门禁、闸门全部通过之后才调用——没通过的检查不触发任何重数据加载。

```ts
/** 按业务 id 组装可执行上下文：注册表取组合体声明 → Skill 仓取 skill →
 *  EnvProvider 取环境配置 → SessionStore 取会话引用 → PlatformConfig 取超时 */
interface ContextLoader {
  load(business_id: string, session_id: string): BusinessContext;
}
```

### 4.2 Agent 适配槽 AgentSlot

生命周期调用 agent-cli 的唯一通道。适配器要薄：只统一调用方式，不封装能力差异（`design/lifecycle.md` §5）。

```ts
interface AgentSlot {
  /** 单次调用：分钟级长耗时（沙箱进程）；内部统一埋点 token/耗时/成本 */
  invoke(call: AgentInvocation): Promise<AgentResult>;
}

interface AgentInvocation {
  agent: AgentCliObject;     // 适配器引用 + 配置（MVP 仅 pi）
  model: ModelObject;        // MVP 仅 qwen3.8max
  prompt: string;            // 提示词总纲
  skills: SkillObject[];     // schema 按需注入
  env: EnvConfig;            // 运行时注入，secrets 不落盘不进日志
  session: SessionRef;       // 平台侧注入 session 映射，用户斜杠命令原样透传（平台不翻译）
  workspace: string;         // 任务级隔离目录 runs/{run_id}/
  timeout_minutes: number;   // 业务配置优先，缺省取全局 task_timeout_minutes（60）
}

interface AgentResult {
  output: unknown;           // 业务产出；大产物走引用
  usage: { tokens: number; duration_ms: number };
}
```

**超时优先级规则**（`design/lifecycle.md` §4）：业务配置 > 平台通用配置。超时是该规则的第一条适用项，后续同类配置同规则。

### 4.3 会话模块 SessionStore

两种会话一张映射表（`design/session-model.md` §1）；session_id 的**唯一定义点**在 `design/session-model.md` §2，本模块只消费不定义。

```ts
interface SessionStore {
  /** 入口侧：按外部键取或建会话（涵盖四操作中的创建/恢复）；
   *  创建时生成 session_id 并建立 外部键↔session_id 映射 */
  getOrCreate(source: EventSource, external_key: string): SessionRef;

  /** 执行侧：写入/读取 session_id ↔ agent-cli 会话 id 映射 */
  bindAgentSession(session_id: string, agent_session_id: string): void;
  getAgentSession(session_id: string): string | undefined;

  /** 四操作之清空：解除映射；下次触发即新会话（新 session_id，历史按时间追溯） */
  clear(session_id: string): void;
}
```

- **压缩**不占接口：由用户消息（如企微斜杠命令）原样透传给 agent-cli 执行，平台不翻译、不主动调用；
- 外部键规则按来源定义在 `design/session-model.md` §4（wecom=群/用户 id，github=仓库名+PR 号，jira=工单 key；internal 继承上游；cron/manual 业务级兜底）。

### 4.4 Skill 注册表 SkillRegistry

skill 遵循公开规范、不为本平台适配；整包 hash 兼任内部编号（`design/skill-package.md` §3）。

```ts
interface SkillRegistry {
  /** 登记：计算整包 hash 作为 skill_id（天然唯一、内容变即 id 变），附元数据，不改写包内容 */
  register(input: SkillPackageInput): SkillObject;

  /** 控制台列表：public 全部可见；private 按归属业务过滤 */
  list(filter: { visibility?: 'public' | 'private'; business_id?: string }): SkillMeta[];

  /** 组装上下文时取用最小视图（skill_id + 注入用 schema） */
  get(skill_id: string): SkillObject;
}

interface SkillPackageInput {
  path: string;                          // 包在文件树中的位置（public/skills/ 或 businesses/{id}/skills/）
  visibility: 'public' | 'private';
  business_id?: string;                  // private 时必填（归属业务）
}

interface SkillMeta {
  skill_id: string;                      // 整包 hash（短哈希展示）
  visibility: 'public' | 'private';
  business_id?: string;
  created_at: string;
  modified_at: string;
}
```

### 4.5 环境配置 EnvProvider

通用 key-value 与专用 key-value（github/wecom/jira）按业务隔离合并；**业务级优先于通用级**（与超时同一优先级规则）。

```ts
interface EnvProvider {
  /** 组装上下文时取：通用层 + 业务层合并（业务优先），secrets 仅在此时注入内存 */
  getFor(business_id: string): EnvConfig;

  /** 控制台写入：按业务隔离；secrets 只写不读明文 */
  set(business_id: string | null, category: 'vars' | 'secrets' | 'services',
      key: string, value: string, actor: User): void;
}
// business_id = null 表示通用层
```

与 ConfigStore 的分工：EnvProvider 管**执行环境**（环境变量、密钥、外部服务凭证），ConfigStore 管**运行参数**（超时、阈值、并发数）。密钥安全纪律见 `design/security.md`。

### 4.6 日志模块 Logger

三层日志（会话/总/模块），error/warn/info 契约性必打，脱敏内建（`design/logging.md`）。

```ts
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** 关联键即路由依据：带 channel_key 进会话日志，其余按模块归模块日志，总日志由关键节点自动镜像 */
interface LogContext {
  module: string;            // 必带：scheduler / queue / lifecycle / console …
  event_id?: string;
  lifecycle_id?: string;
  channel_key?: string;      // source__session_id
  correlation_id?: string;
}

/** 兼容 console.log 调用习惯的简单封装；脱敏内建于实现，各模块不用各自处理 */
interface Logger {
  error(message: string, ctx: LogContext): void;  // 契约性必打：无法继续执行
  warn(message: string, ctx: LogContext): void;   // 契约性必打：有问题但可继续
  info(message: string, ctx: LogContext): void;   // 契约性必打：关键节点
  debug(message: string, ctx: LogContext): void;  // 可选，生产默认关
}
```

### 4.7 基础设施与工具类

被所有模块依赖，不反向依赖任何业务模块。它们存在的理由：**消除"各模块各自实现"的散点**——SQL 写法、id 格式、时间格式一旦散落各处就难以维护（与 session_id 单点定义同一思路）。

```ts
/** SQLite 薄封装：全平台唯一数据访问口。刻意保持薄抽象（骨架 §4），
 *  未来迁 PostgreSQL 时只有本接口的实现需要换 */
interface Database {
  run(sql: string, params?: unknown[]): void;             // 写
  get<T>(sql: string, params?: unknown[]): T | undefined; // 读一行
  all<T>(sql: string, params?: unknown[]): T[];           // 读多行
  transaction<T>(fn: () => T): T;                         // 事务
}

/** 各类标识的唯一生成口：id 的格式只有这里知道 */
interface IdGen {
  eventId(): string;       // evt_ 前缀，全局唯一锚点
  taskId(): string;
  lifecycleId(): string;
  randomSegment(): string; // session_id 的随机段
}

/** 时间戳统一来源：信封 timestamp、日志、session_id 时间戳段都从这里取，
 *  禁止各模块各自 new Date()（时区/格式会漂移） */
interface Clock {
  nowIso(): string;      // ISO 8601 带时区（如 2026-09-15T10:30:00+08:00）
  nowCompact(): string;  // 紧凑格式（如 20260915103000），session_id 时间戳段用
}
```

---

## 5. 工程结构

模块边界在目录层面落地，依赖规则在代码层面强制（骨架 §2 命门）。

```
src/
├── contracts/    # 纯类型契约（Event、TaskQueue、BusinessRegistry、ConfigStore…），零实现零依赖，所有模块可 import
├── infra/        # 基础设施与工具：database.ts / id-gen.ts / clock.ts；不依赖任何业务模块
├── entries/      # 入口模块群：wecom.ts / jira.ts / github.ts / cron.ts / manual.ts（新事件源 = 新文件）
├── kernel/       # 编排内核：scheduler-loop / task-queue / business-registry / context-loader / lifecycle / agent-slot / channel
├── skills/       # SkillRegistry 与 skill 包加载
├── platform/     # 平台公共模块：session-store / env-provider / config-store / logger
├── console/      # 控制台服务与 UI（前后端同构，共享 contracts/ 类型）
└── main.ts       # 组装根：依赖注入的唯一地点，唯一允许 import 全部模块的文件
```

规则：

1. **业务模块只许 import `contracts/`、`infra/`、以及其他模块的公开出口**（模块根 `index.ts`）；禁止深入其他模块内部文件——由 lint 边界规则（如 `eslint-plugin-boundaries`）强制，不靠自觉；
2. `contracts/` 纯类型、零实现、零依赖；`infra/` 不反向依赖业务模块；
3. **运行时数据不进 `src/`**：业务目录、`runs/`、日志等按 `design/console-design.md` §6 的 workspace 树，平台级工作目录由控制台配置；
4. `main.ts` 组装：创建各模块实例、按 §2 的方向注入依赖——模块之间不互相 new。

---

## 6. 数据归属（哪个模块管哪张表）

| 数据 | 属主模块 | 说明 |
|------|---------|------|
| 任务（tasks） | TaskQueue | 状态机 pending/processing/done/dead |
| 通道（channels） | ChannelPool | 创建即落库，完成只做状态变更 |
| 业务配置（businesses） | BusinessRegistry | 含 creator_id、匹配字段、依赖、disposition |
| 会话映射（sessions） | SessionStore | 外部键↔session_id、session_id↔agent 会话 id 两类 |
| skill 元数据 | SkillRegistry | 包内容在文件树，库中只存元数据 |
| 环境配置（含 secrets） | EnvProvider | 按业务隔离 |
| 设置（config） | ConfigStore | 只存覆盖值，默认值在键注册表 |
| 日志 | Logger | 文件，不进 SQLite；分割交 logrotate |

以上各表的全部读写都经 `Database`（§4.7）——属主管"哪些表"，Database 管"怎么访问"。

---

## 7. 毕业时的文档同步项（本稿发现的不一致）

1. ~~session_id 定义三处不一致~~ —— 已解决（2026-09-15）：单点定义落在 `session-model.md` §2（四段式、单下划线），话术集与 event-contract 已改引用；
2. **骨架架构图**：出口模块群加注释（出口=队列中的可选任务，能力以 public skill 提供）、补业务注册表（已定，待改）；
3. **循环契约回补**：`BusinessMatch.creator_id`、`PlatformConfig.task_timeout_minutes` 已补入调度循环契约草稿；
4. **骨架 §4 技术选型补版本号**：Node 24 / yarn 4.14.1 / TypeScript 5.x（已定，待改）。

---

## 8. 待定项

| 项 | 说明 | 归属 |
|----|------|------|
| 用户/账号体系完整设计 | 认证、注册、admin/成员管理 | 单独文档 |
| GitHub webhook 事件种类调研 | 各事件的源生标识提取规则 | 待调研 |
| 入口适配器形态 | 各源独立小模块，本稿只定职责契约不定基类；是否抽象公共基类属实现期 | 实现期 |
| dedupe 去重规则 | 占位不实现，单独文档设计 | 后续文档 |
| SQLite 驱动选型 | `node:sqlite`（Node 24 内置，零依赖）vs `better-sqlite3`（成熟生态）；倾向 node:sqlite，待确认 | 实现期前 |
