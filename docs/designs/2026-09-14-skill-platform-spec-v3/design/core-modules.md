# 核心模块与接口

> 日期：2026-09-15（2026-09-26 修订：双循环、出口工具群、出口绑定。2026-09-27 修订：代码即流程——AgentSlot 拆解为 WorkflowRunner + AgentService，新增业务 SDK）
> 状态：定稿
> 范围：**核心模块清单 + 各模块公开接口（TS）+ 工程结构**。已在《调度循环契约》《设置模块契约》中定义的接口（Event、TaskQueue、BusinessRegistry、ProcessingChain、BusinessContext、Lifecycle、ExitTool、Exit、ExitBinding、ExitRegistry、Channel/ChannelPool、Semaphore、PlatformConfig、ConfigStore）此处只引用不重复。
> 依据：骨架 `skill-platform-spec-v3.md` §2 架构分层 + `design/` 各节点文档 + 调度循环契约与设置契约。
> 纪律：模块间只许通过本文档列出的公开接口调用，禁止跨模块直接引用内部实现（骨架 §2 命门）。
> 技术栈：**Node.js 24（LTS）+ yarn 4.14.1（corepack 启用）+ TypeScript 5.x（strict）**。

---

## 1. 模块全景

树状总览（层级 = 骨架分层，叶子 = 模块）：

```
easemob-agent（模块化单体）
├── 入口模块群                       # 每事件源一个独立小模块，只消费队列/日志
│   ├── 企业微信入口 EntryAdapter(wecom)
│   ├── Jira 入口    EntryAdapter(jira)
│   ├── GitHub 入口  EntryAdapter(github)
│   ├── Webhook 入口 EntryAdapter(webhook)   # 内置通用 webhook 接收：平台可作他方的中间组件
│   └── 定时/手动    CronTimer / manual
├── 出口工具群                       # 每通知目的地一个内置投递器模块，只被出口循环调用
│   ├── 企微智能机器人 ExitTool(wecom-bot)
│   ├── 企微群 webhook ExitTool(wecom-webhook)
│   ├── 邮件 / 自定义 webhook / jira / confluence / github 操作 …
├── 编排内核（平台心脏：一副机械，两个循环）
│   ├── 入口事件循环 SchedulerLoop      # 摄取 + 各业务通道消化 + 结果扇出
│   ├── 出口事件循环 ExitSchedulerLoop  # 摄取 + 各出口通道消化 + 投递
│   ├── 任务队列     TaskQueue ×2       # 入口队列 / 出口队列，同一契约，SQLite 持久化，FIFO
│   ├── 业务注册表   BusinessRegistry   # 匹配视图 + 业务配置（含出口绑定）统一读写口
│   ├── 业务组装器   ContextLoader      # 匹配通过后才组装重数据
│   ├── 生命周期     Lifecycle          # 单次执行 = spawn 业务流程程序，跑完即销毁
│   ├── 流程执行器   WorkflowRunner     # spawn 业务流程程序的薄原语（子进程契约、超时、输出上限）
│   └── agent 服务   AgentService       # sdk.agent() 的另一端：socket 服务 + pi 子进程执行
├── Skill 包仓（动态加载）
│   └── Skill 注册表 SkillRegistry    # public / private，hash 兼任 id
├── 平台公共模块
│   ├── 通道模块     ChannelStore     # 业务通道 channel_id↔agent 会话映射 + 四操作的平台侧部分
│   ├── 出口注册表   ExitRegistry     # 内置出口工具菜单的登记与取用
│   ├── 环境配置     EnvProvider      # 通用/专用 key-value，业务级优先
│   ├── 设置模块     ConfigStore      # 全局/业务设置，含权限校验
│   └── 日志模块     Logger           # 四类日志（系统/入口循环/出口循环），脱敏内建
├── 基础设施与工具                   # 被所有模块依赖，不反向依赖任何业务模块
│   ├── 数据库       Database         # SQLite 薄封装，全平台唯一数据访问口
│   ├── 标识生成     IdGen            # event_id / task_id / lifecycle_id / 随机段
│   └── 时钟         Clock            # 时间戳统一来源（信封/日志/session_id）
└── 控制台 Console                   # 开关与仪表盘集合，无业务逻辑
    └── 账号体系（`design/accounts.md`）
```

说明：**出口与入口对称**（已定决策）——出口 = 出口事件循环 + 出口工具群（内置投递器模块，不是 skill）。业务结果无脑扇出到两个队列：入口队列由关注业务消化（订阅匹配），出口队列由产出方业务的出口绑定消化（归属匹配，不过 LLM、毫秒级）。注意区分两类「触达能力」：**结果投递**归出口工具；**执行内调用**（如审查过程中读写 Jira）仍以 public skill 由 Skill 包仓提供。

模块明细：

| # | 模块 | 层 | 一句话职责 | 公开接口 | 主要消费方 |
|---|------|----|-----------|---------|-----------|
| 1 | 入口适配器群 EntryAdapter | 入口 | 验签 → 包装信封（含 session_id）→ 落队，立即返回 | `EntryAdapter`（§4.8，契约一致、各自实现） | — |
| 2 | 定时器 CronTimer | 入口 | 到点包装任务入队，不直接执行 | 同上（`source = cron` 的 EntryAdapter 实现） | — |
| 3 | 出口工具群 ExitTool | 出口 | 投递器模块：一个目的地一个实现，bind 持配置、deliver 只收结果 | `ExitTool` / `Exit`（循环契约 §6） | 出口循环（经 ExitRegistry） |
| 4 | 任务队列 TaskQueue ×2 | 内核 | 统一缓冲带：入口队列 / 出口队列，FIFO、SQLite 持久化、状态机 | `TaskQueue`（循环契约 §2） | 入口群、两个循环、控制台 |
| 5 | 业务注册表 BusinessRegistry | 内核 | 业务匹配视图 + 业务配置（含出口绑定）统一读写口 | `BusinessRegistry`（循环契约 §3） | 两个循环、控制台、设置模块 |
| 6 | 入口事件循环 SchedulerLoop | 内核 | 心脏之一：摄取 + 各业务通道消化 + 结果扇出 | 无（是消费方，见循环契约 §9） | — |
| 7 | 出口事件循环 ExitSchedulerLoop | 内核 | 心脏之二：摄取 + 各出口通道消化 + 投递 | 无（是消费方，见循环契约 §9） | — |
| 8 | 业务组装器 ContextLoader | 内核 | 匹配通过后才组装重数据为 BusinessContext | `ContextLoader`（§4.1） | 入口循环 |
| 9 | 生命周期 Lifecycle | 内核 | 单次执行 = spawn 业务流程程序、进程退出即完结、统一打标埋点 | `Lifecycle`（循环契约 §5） | 入口循环、控制台（业务标记投影） |
| 10 | 流程执行器 WorkflowRunner | 内核 | spawn 业务流程程序的薄原语：子进程契约、超时强杀、输出上限 | `WorkflowRunner`（§4.2） | 生命周期 |
| 11 | agent 服务 AgentService | 内核 | sdk.agent() 的另一端：per-run socket + pi 子进程执行 + 配额与审计 | `AgentService`（§4.2） | 业务流程程序（经 socket，非 import） |
| 12 | 通道模块 ChannelStore | 公共 | 业务通道 channel_id↔agent 会话映射 + 四操作中的平台侧部分 | `ChannelStore`（§4.3） | 业务组装器、agent 服务 |
| 13 | 出口注册表 ExitRegistry | 公共 | 内置出口工具菜单的登记与取用 | `ExitRegistry`（循环契约 §6） | 出口循环、控制台 |
| 14 | Skill 注册表 SkillRegistry | Skill 仓 | 登记/列表/取用 skill 包，hash 兼任 id | `SkillRegistry`（§4.4） | 控制台、业务组装器 |
| 15 | 环境配置 EnvProvider | 公共 | 按业务合并通用/专用 key-value，运行时注入 | `EnvProvider`（§4.5） | 业务组装器、出口循环（出口凭证解析）、控制台 |
| 16 | 设置模块 ConfigStore | 公共 | 全局/业务设置统一读写（含权限校验） | `ConfigStore`（设置契约） | 控制台、内核各模块（只读） |
| 17 | 日志模块 Logger | 公共 | 四类日志（系统/入口循环/出口循环；业务日志由执行器采集）、四级契约性输出、脱敏内建 | `Logger`（§4.6） | 全部模块 |
| 18 | 数据库 Database | 基础设施 | SQLite 薄封装：全平台唯一数据访问口，保薄抽象 | `Database`（§4.7） | 全部持久化模块 |
| 19 | 标识生成 IdGen | 基础设施 | 各类 id 与随机段的唯一生成口 | `IdGen`（§4.7） | 入口群、内核 |
| 20 | 时钟 Clock | 基础设施 | 时间戳统一来源（信封 timestamp、日志、session_id 时间戳段） | `Clock`（§4.7） | 全部模块 |
| 21 | 控制台 Console | 控制台 | 开关与仪表盘集合，本身无业务逻辑 | 无（是纯消费方） | — |

---

## 2. 依赖纪律（允许的方向）

```
入口群 ──▶ TaskQueue(入口) / Logger   # 会话标识直接从事件提取（channel-model §4），入口不再需要会话存储
入口循环 ──▶ TaskQueue(入口/出口) / BusinessRegistry / ContextLoader / Lifecycle / ChannelPool / PlatformConfig / Logger
出口循环 ──▶ TaskQueue(出口) / BusinessRegistry(出口绑定) / ExitRegistry / ChannelPool / EnvProvider / PlatformConfig / Logger
ContextLoader ──▶ BusinessRegistry / SkillRegistry / EnvProvider / ChannelStore
Lifecycle ──▶ WorkflowRunner / Logger
WorkflowRunner ──▶ Logger                      # spawn 业务流程程序（子进程，非 import）
AgentService ──▶ ChannelStore / Logger          # 经 socket 服务业务进程（非 import）；内部 spawn pi 子进程
Console ──▶ 全部公开接口（只经接口，不碰内部存储；与内部模块共用同一套读写口）
全部模块 ──▶ infra（Database / IdGen / Clock）——基础设施不反向依赖
业务 = 注册表里的数据行 + 工作区里的流程程序资产，不是模块，不被 import
```

- **心脏不认识业务**：两个循环只读信封字段与匹配视图；业务细节（提示词、skill、agent 配置）全部封在 ContextLoader 组装出的 BusinessContext 里；
- **出入口对称**：新事件源 = 新增一个入口小模块；新通知目的地 = 新增一个出口工具模块——都不动内核；
- **配置只有一个家**：结构化业务字段（含出口绑定）归 BusinessRegistry，可调参数归 ConfigStore，环境/密钥归 EnvProvider（见设置契约 §7）。

---

## 3. 已定义接口索引（不重复，出处为准）

| 契约 | 定义处 |
|------|--------|
| Event / EventSource / ChannelId | 循环契约 §1（语义权威：`design/event-contract.md`、`design/glossary.md`） |
| Task / TaskQueue | 循环契约 §2（两个实例：入口队列 / 出口队列） |
| BusinessRegistry / BusinessMatch / ProcessingChain | 循环契约 §3 |
| BusinessContext 及其成员（PromptObject、SkillObject、AgentCliObject、ModelObject、EnvConfig、ChannelRef） | 循环契约 §4（仅入口循环） |
| Lifecycle / ExecutionResult / 结果扇出规则 | 循环契约 §5 |
| ExitTool / Exit / ExitBinding / ExitRegistry | 循环契约 §6 |
| Channel / ChannelPool / Semaphore / PlatformConfig | 循环契约 §7 |
| ConfigStore / ConfigScope / ConfigKeyDef / User（最小形状） | 设置契约 §3–5 |

---

## 4. 缺口接口定义（本文档的新增内容）

### 4.1 业务组装器 ContextLoader

匹配、依赖、门禁、闸门全部通过之后才调用——没通过的检查不触发任何重数据加载。

```ts
/** 按业务 id 组装可执行上下文：注册表取组合体声明 → Skill 仓取 skill →
 *  EnvProvider 取环境配置 → ChannelStore 取通道映射引用 → PlatformConfig 取超时 */
interface ContextLoader {
  load(business_id: string, channel_id: ChannelId): BusinessContext;
}
```

### 4.2 流程执行器 WorkflowRunner 与 agent 服务 AgentService

业务执行模型的完整语义（一入一出、子进程契约、SDK、配额、hooks 纪律）见 `design/business-workflow.md`；此处只定义平台侧两个接口的形状。

```ts
/** 流程执行器：spawn 业务流程程序的薄原语。子进程契约：stdin 进（信封+注入上下文）、
 *  stdout 出（唯一结果，schema 校验 + 大小上限）、exit 非零或超时 = failed（fail-closed）。
 *  同一契约被业务侧 sdk.run() 递归复用（business-workflow §5） */
interface WorkflowRunner {
  run(job: {
    program: string;           // 业务流程程序入口（业务工作区内）
    event: Event;              // 触发信封
    env: EnvConfig;            // 按业务隔离注入（secrets 不落盘不进日志）
    workspace: string;         // run 隔离目录 runs/{run_id}/，作为 cwd
    endpoint: ServiceEndpoint; // 注入环境变量，SDK 据此连 agent 服务
    timeout_minutes: number;   // 业务配置优先，缺省取全局 task_timeout_minutes（60）
  }): Promise<ExecutionResult>;
}

/** agent 调用服务：sdk.agent() 的另一端。每 run 监听一个 unix socket（一次性 token 鉴权），
 *  每次调用 spawn pi 子进程执行：cwd=workspace、总纲注入、skill 白名单校验、
 *  -e 注入 skill 附带的 pi extension、按 channel 恢复/绑定会话、配额强制、埋点与请求体审计。
 *  会话操作：compact 转交 pi 执行，clear 经 ChannelStore 解除映射（channel-model §3） */
interface AgentService {
  /** 随 run 启动监听，随 run 结束关闭（token 失效） */
  serve(context: BusinessContext): Promise<ServiceEndpoint>;
}
```

**run 内的组装时序**（Lifecycle.run 内部固定四步，本节为唯一定义处）：

1. ContextLoader 组装静态上下文（业务资料 / env / channel / quota）——此时尚无 endpoint；
2. `AgentService.serve(context)` → 得 endpoint（socket 监听就绪）；
3. `WorkflowRunner.run`（endpoint 注入环境变量）→ 业务流程程序执行；
4. 进程退出 → serve 关闭、token 失效，ExecutionResult 出炉。

### 4.3 通道模块 ChannelStore

三种「会话」辨析与通道模型见 `design/glossary.md`、`design/channel-model.md`；session_id = 源生会话标识，入口按来源规则直接提取（channel-model §4），**平台不生成、入口侧无需会话存储**。

```ts
interface ChannelStore {
  /** 业务通道 channel_id ↔ agent-cli 会话 id 映射：同通道（相同会话+相同业务）上下文连续的唯一依据 */
  bindAgentSession(channel_id: ChannelId, agent_session_id: string): void;
  getAgentSession(channel_id: ChannelId): string | undefined;

  /** 四操作之清空：解除映射；下次触发即重绑新 agent 会话（通道标识不变，历史按时间追溯） */
  clear(channel_id: ChannelId): void;
}
```

- **只管业务通道**：出口通道不过 LLM、无 agent 会话，不涉及本模块（出口通道的串行语义由 ChannelPool 承载）；
- **创建/恢复**不占接口：执行侧 `getAgentSession` 命中即恢复；未命中由首次执行建立并 `bindAgentSession`；
- **压缩**不占接口：由用户消息（如企微斜杠命令）原样透传给 agent-cli 执行，平台不翻译、不主动调用；
- 各来源会话标识规则定义在 `design/channel-model.md` §4（wecom=群/用户 id，jira=工单 key，github 按事件种类细分，internal 继承上游源生标识，cron/manual 业务级兜底）。

### 4.4 Skill 注册表 SkillRegistry

skill 遵循公开规范、不为本平台适配；整包 hash 兼任内部编号（`design/skill-package.md` §3）。

```ts
interface SkillRegistry {
  /** 登记：计算整包 hash 作为 skill_id（天然唯一、内容变即 id 变），附元数据，不改写包内容 */
  register(input: SkillPackageInput): SkillObject;

  /** 控制台列表：public 全部可见；private 按归属账号过滤（权限规则见 skill-package.md §2） */
  list(filter: { visibility?: 'public' | 'private'; owner_id?: string }): SkillMeta[];

  /** 组装上下文时取用最小视图（skill_id + 注入用 schema） */
  get(skill_id: string): SkillObject;
}

interface SkillPackageInput {
  path: string;                          // 包在文件树中的位置（public/skills/ 或 accounts/{账号id}/skills/）
  visibility: 'public' | 'private';
  owner_id: string;                      // 创建者账号：读写权限判定（admin 兜底）
}

interface SkillMeta {
  skill_id: string;                      // 整包 hash（短哈希展示）
  visibility: 'public' | 'private';
  owner_id: string;
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

与 ConfigStore 的分工：EnvProvider 管**执行环境**（环境变量、密钥、外部服务凭证），ConfigStore 管**运行参数**（超时、阈值、并发数）。密钥安全纪律见 `design/security.md`。出口绑定配置中的机密项（webhook 密钥、账号 token）同样经本模块解析，bind 时注入出口实例、只活内存（见循环契约 §9.3 `resolveExitConfig`）。

### 4.6 日志模块 Logger

四类日志（系统级 / 入口事件循环 / 出口事件循环 / 业务），error/warn/info 契约性必打，脱敏内建（`design/logging.md`）。业务日志不在本接口内——由流程执行器捕获业务进程 stderr 采集（logging.md §1）。

```ts
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** 关联键即检索键：模块标记决定进哪类日志，关联键用于跨日志互跳 */
interface LogContext {
  module: string;            // 必带：system / entry-loop / exit-loop / queue / console / lifecycle …
  event_id?: string;
  lifecycle_id?: string;
  channel_id?: ChannelId;    // 业务通道 source__session_id__business_id；出口通道 exit__destination_id
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

### 4.8 入口适配器 EntryAdapter

形态定为**接口而非基类**（已定）：各源差异大（webhook 接收 / 定时触发 / 手动触发），基类能复用的实现极少却引入耦合；契约一致即可，重复代码真出现时以普通工具函数沉淀，不立继承体系。出口工具同此纪律（循环契约 §6）。

```ts
/** 入口适配器契约：每个事件源一个实现（wecom / jira / github / webhook / cron / manual），
 *  职责链：验签 → 包装信封（含 session_id）→ 落队，立即返回 */
interface EntryAdapter {
  readonly source: EventSource;
  /** 启动监听/定时器；依赖由 main.ts 注入，入口与内部模块共用同一套公开接口 */
  start(deps: EntryDeps): void;
  stop(): void;
}

interface EntryDeps {
  queue: TaskQueue;   // 入口队列
  idGen: IdGen;
  clock: Clock;
  log: Logger;
}
```

---

## 5. 工程结构

模块边界在目录层面落地，依赖规则在代码层面强制（骨架 §2 命门）。

仓库根：

```
easemob-sdk-agent_v3/
├── package.json      # 单包起步；packageManager: yarn@4.14.1（corepack）
├── tsconfig.json     # TypeScript 5.x，strict
├── .gitignore        # 运行时数据（workspace、runs/、日志、*.sqlite）不入库
├── public/
│   └── skills/       # 内置 public skill 发布物（jira 工具 / github 操作 / 企微工具…），随仓库发布
├── tests/            # 跨模块端到端测试（M3 起）；模块单测与源码同处（*.test.ts）
├── docs/             # 设计文档
└── src/              # 平台本体，见下
```

内置工具（github / jira / confluence / 邮件 / 企微等）的载体统一为**工具实现文件**：`src/tools/` 下**一个工具一个 TypeScript 文件**，独立、可复用、不含账号凭证。它有两种封装：**执行内调用**——包装为内置 public skill（`public/skills/` 发布、首启由 SkillRegistry 登记/同步进 workspace 与注册表，供 LLM 在业务执行中调用，与用户上传的 public skill 同规则）；**结果投递**——包装为出口工具（`src/exits/`，随平台发布、由 ExitRegistry 登记，平台直接调用）。两种封装复用同一份工具实现。此外还有**监听/接收类**（各源 webhook 监听、企微机器人收消息）——是 `src/entries/` 的入口适配器代码模块，不基于工具实现。凭证一律走 EnvProvider 专用 key-value（services），按业务隔离，业务创建者在控制台填自己的账号即可用。

`src/`：

```
├── contracts/    # 纯类型契约（Event、TaskQueue、BusinessRegistry、ExitTool、ConfigStore…），零实现零依赖，所有模块可 import
├── infra/        # 基础设施与工具：database.ts / id-gen.ts / clock.ts；不依赖任何业务模块
├── entries/      # 入口模块群：wecom.ts / jira.ts / github.ts / webhook.ts / cron.ts / manual.ts（新事件源 = 新文件）
├── exits/        # 出口工具群：wecom-bot.ts / wecom-webhook.ts / mail.ts / webhook.ts / jira.ts / confluence.ts / github.ts（新目的地 = 新文件，出口封装）
├── tools/        # 工具实现：一个工具一个 TS 文件（github / jira / confluence / mail …），skill 与出口工具复用同一实现
├── kernel/       # 编排内核：scheduler-loop（入口循环）/ exit-loop（出口循环）/ task-queue / business-registry / context-loader / lifecycle / workflow-runner / agent-service / channel
├── sdk/          # 业务 SDK 发布物（业务程序的唯一依赖；API 唯一定义见 design/business-workflow.md §3）
├── skills/       # SkillRegistry 与 skill 包加载
├── platform/     # 平台公共模块：channel-store / exit-registry / env-provider / config-store / logger
├── console/      # 控制台服务与 UI（前后端同构，共享 contracts/ 类型）
└── main.ts       # 组装根：依赖注入的唯一地点，唯一允许 import 全部模块的文件
```

规则：

1. **业务模块只许 import `contracts/`、`infra/`、以及其他模块的公开出口**（模块根 `index.ts`）；禁止深入其他模块内部文件——由 lint 边界规则（如 `eslint-plugin-boundaries`）强制，不靠自觉；
2. `contracts/` 纯类型、零实现、零依赖；`infra/` 不反向依赖业务模块；
3. **运行时数据不进 `src/`**：业务目录、`runs/`、日志等按 `design/console-design.md` §6 的 workspace 树，平台级工作目录由控制台配置；
4. `main.ts` 组装：创建各模块实例、按 §2 的方向注入依赖——模块之间不互相 new；
5. **测试同处**：模块单测紧邻源码（`scheduler-loop.test.ts` 挨着 `scheduler-loop.ts`），随模块移动、随模块删除；跨模块端到端放根 `tests/`。测试经公开接口注入 fake（依赖注入本就在 `main.ts`，测试复用同一组装方式），不 mock 内部实现。

---

## 6. 数据归属（哪个模块管哪张表）

| 数据 | 属主模块 | 说明 |
|------|---------|------|
| 任务（tasks） | TaskQueue ×2 | 入口队列 / 出口队列各一张（或一张表加队列标识，实现定）；状态机 pending/processing/done/dead |
| 通道（channels） | ChannelPool | 两个循环共用一张表，channel_id 前缀区分域（业务通道三维 / 出口通道 `exit__`）；创建即落库，完成只做状态变更 |
| 业务配置（businesses） | BusinessRegistry | 含 business_id（不可改）、business_name（可改）、creator_id、匹配字段、依赖、on_failure、**出口绑定**（business_id + 工具 kind + 配置） |
| 通道映射（channels_sessions） | ChannelStore | 业务通道 channel_id ↔ agent 会话 id 一张表（出口通道不在此表） |
| skill 元数据 | SkillRegistry | 包内容在文件树，库中只存元数据 |
| 环境配置（含 secrets） | EnvProvider | 按业务隔离 |
| 设置（config） | ConfigStore | 只存覆盖值，默认值在键注册表 |
| 日志 | Logger | 文件，不进 SQLite；分割交 logrotate |

以上各表的全部读写都经 `Database`（§4.7）——属主管"哪些表"，Database 管"怎么访问"。

---

## 7. 待定项

| 项 | 说明 | 归属 |
|----|------|------|
| GitHub webhook 事件种类 | **已定**：会话标识按事件种类细分（PR=仓库+PR号、issues=仓库+issue号、push=仓库+分支），见 `design/channel-model.md` §4 | 已定 |
| 业务语义去重 | **已定**：归业务流程程序自行处理（平台不定规范、不提供字段）；第一层入口幂等由 `event_id` 承担（event-contract §1 去重职责划分） | 已定 |
| SQLite 驱动选型 | **已定**：`node:sqlite`（Node 24 内置，零依赖；队列场景性能足够） | 已定 |
| 测试运行器 | **已定**：jest 29 + esbuild 编译态（参考 v2 已验证组合；只保留编译态一套模式） | 已定 |
