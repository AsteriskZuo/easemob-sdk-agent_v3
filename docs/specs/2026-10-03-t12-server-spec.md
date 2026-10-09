# T12 server 应用 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/core-modules.md` §4.8/§5、`design/logging.md` §5、`design/scheduler-loop-contracts.md` §9.3、`design/console-design.md` §6、`design/event-contract.md` §1。
>
> **2026-10-04 修订**：webhook 入口适配器从本任务移出（归后续独立任务 T18——外部业务推送形态复杂，需单独适配设计）；AibotConnector 维持后移（归企微入口任务）。本任务收缩为：配置解析 + 启动自检 + 装配根 + 进程入口 + EntryAdapter 接口 + ExitDriver + 集成验证。

## 1. 目标

产出 `app/server`（`@asteriskzuo/agent-server`，private 不发布）：**平台的装配根与进程入口**——把全部已完成的 packages 接线成可运行的服务，外加：

1. **配置解析**：环境变量 > `{workspace}/config.json` > 代码默认值（console-design §6「配置」类）；
2. **启动自检**：fail-fast，任一前提不满足记 error 日志并停止启动（logging.md §5）；
3. **EntryAdapter 接口**（装配层契约，供 T18 webhook 入口与将来各源入口实现）；
4. **ExitDriver 实现**：`resolveExitConfig` 机密回填（循环契约 §9.3 的落地处）；
5. 优雅停机与未捕获异常兜底（运行期不崩溃）；
6. **端到端集成验证**：以「直接落队」模拟入口（入口适配器的本质动作就是 `queue.enqueue`），走通 落队 → 入口循环 → Lifecycle 四步时序 → 派生扇出 → 出口循环 → 真实投递 全链路。

## 2. 背景知识（执行所需的最小上下文）

- **平台形态**：模块化单体。server 是唯一允许 import 全部模块的装配根（core-modules §5 规则 4）；packages 互不感知 server。
- **装配总览**（server 接线的全景，箭头 = 数据/调用方向）：

```text
                 外部世界（推送：T18 webhook / 后续 wecom·jira…；投递目的地：企微·邮件·jira…）
                    │ 验签→包信封→落队                     ▲ 投递
            ┌───────▼────────┐                     ┌──────┴────────┐
            │ 入口适配器群     │                     │ 出口工具群 ×7   │ ExitRegistry
            │ (EntryAdapter) │                     │ (ExitTool)    │
            └───────┬────────┘                     └──────▲────────┘
                    │ enqueue                             │ bind(非机密config+机密回填).deliver
            ┌───────▼─────────────────────────────────────┴────────┐
            │ 缓冲带：entry_tasks / exit_tasks（platform.db，SQLite） │ event_id 幂等 · recover 恢复
            └───────┬─────────────────────────────────────▲────────┘
                    │ take                                │ 结果扇出：deriveEvent 无脑同投两队列
        ┌───────────▼───────────┐              ┌──────────┴──────────┐
        │ 入口事件循环            │ 派生事件      │ 出口事件循环           │
        │ match→通道→闸门→执行    ├──────────────►│ 归属匹配→通道→有界重试   │
        └───────────┬───────────┘              └──────────▲──────────┘
                    │ EntryDriver=Lifecycle                │ ExitDriver（本任务：机密回填）
        ┌───────────▼──────────────────────────────────────┴─────────┐
        │ runtime 粘合层（T17）                                       │
        │  ContextLoader：profile + 资产物化 + env两桶 → RunContext     │
        │  Lifecycle 四步：①load ②serve ③spawn ④close + lifecycles打标 │
        └──┬──────────────┬──────────────────┬─────────────────────┘
   ┌───────▼──────┐ ┌─────▼───────┐ ┌────────▼────────┐
   │ asset-registry│ │agent-service│ │ workflow-runner │
   │ git 物化资产   │ │per-run socket│ │ spawn 业务流程程序 │
   └──────────────┘ │ spawn pi    │ │ (process.execPath)│
                    └─────────────┘ └─────────────────┘
横切支撑：registry(业务资料/匹配/出口绑定) · EnvProvider两桶 · ChannelPool/Store · logger(四类日志) · database(唯一数据口) · contracts(信封/id)
```

### 2.0.1 模块组织图（维护版）

图源：`docs/designs/2026-09-14-skill-platform-spec-v3/design/architecture-overview.puml`（PlantUML）与 `architecture-overview.mmd`（Mermaid），同内容双格式、只提图源不提渲染产物。**模块组织视图**（整体 → 层 → 模块，箭头 = 允许依赖方向）以这两个图源为准，与骨架 `skill-platform-spec-v3.md` §2 的 ASCII 图内容一致、改动时同步；本文件 §2 的 ASCII 图是**数据流视图**（一次任务的流向），两种视图各司其职、不互相替代。

### 2.0.2 server 是空平台，console 是配置的唯一生产入口

T12 交付的 server 启动后是**空跑态**：registry 无业务、两桶无配置、资产无登记——平台的一切业务数据（业务资料、入口/出口绑定、vars/secrets、资产登记）都由控制台经管理 API（T13）写入。**没有 console，server 只能初始化运行，这是分层而非缺陷**：server 提供机械执行能力，配置生产归 console。自检不校验"是否有业务"，空库是合法状态。

- **双循环**：入口循环消化业务执行（EntryDriver = T17 的 Lifecycle），出口循环消化结果投递（ExitDriver = 本任务实现）。业务产出派生事件无脑投两条队列，各循环自行过滤。
- **入口职责链**（各入口适配器通用）：验签 → 包装信封（含 session_id）→ 落队，立即返回。落库才算收到；`event_id` 兼任入口幂等键（queue.enqueue 同 event_id 返回已有任务、不产生新行）。本任务只立接口，第一个真实入口适配器是 T18 的 webhook。
- **出口机密回填**：绑定配置只存非机密项；`configSchema` 标注 `secret: true` 的项由控制台写入该业务 secrets 桶，投递前合并进 config 再 bind（core-modules §4.5）。
- **日志纪律**：error/warn/info 契约性必打；系统级日志是总纲（启动自检结果、关键事件）；入口侧流水用 module `'entry-loop'`，出口用 `'exit-loop'`，平台级用 `'system'`。
- 工程约定同 T0 spec §4（`docs/specs/2026-09-28-t0-engineering-skeleton-spec.md`）：`app/*` 在 workspaces 范围内，包级脚本模板、ESM `.js` 后缀、jest 编译态等全部适用。

### 2.1 消费的上游包真实签名（以 packages/ 源码为准，此处为最小引用面）

`@asteriskzuo/agent-env`：`getString(name, { default?, required? })` / `getNumber(name, { default?, required?, min?, max? })` / `getBoolean(...)`，失败抛 `EnvError`（message 含变量名与原因）。

`@asteriskzuo/agent-logger`：

```ts
initLogger(options: { logsDir: string; level?: 'error'|'warn'|'info'|'debug'; enabled?: boolean; secrets?: readonly string[] }): void;
// 只能调一次；logsDir 不可建/不可写 → 抛错（自带 fail-fast 自检）
logger.for({ module: string, ...固定字段 }): CategoryLogger;  // error/warn/info/debug(message, fields?) + .with(fields)
```

`@asteriskzuo/agent-database`：`openDatabase(path): Database`（父目录自动创建；打不开抛错）；`Database { run/get/all/transaction/exec/close }`。

`@asteriskzuo/agent-queue`：

```ts
createTaskQueue(db: Database, table: string): TaskQueue;  // 平台用 'entry_tasks' / 'exit_tasks'
// TaskQueue.enqueue(event)：先 validateEnvelope（不过抛错）；event_id 幂等（重复返回已有任务）
// TaskQueue.recover()：processing 残留重置回 pending，返回条数——装配根启动时调一次
```

`@asteriskzuo/agent-registry`：

```ts
createBusinessRegistry(db: Database): BusinessRegistry;
interface BusinessMatch { business_id: string; business_name: string; creator_id: string;
  source: EventSource; event_type: string; on_failure?: boolean;
  entry_config?: Record<string, unknown> }  // 入口配置：平台不解析，消费方=入口适配层（T18 起）
interface ExitBinding { business_id: string; tool: string; config: Record<string, string> } // config 只有非机密项
// 本任务用到：match(source, event_type): BusinessMatch[]（EntryDeps 暴露给入口适配器）
// 术语对齐：返回的关注者集合即设计中的「处理链」（ProcessingChain = 一个事件的关注者集合，链内并行）
```

`@asteriskzuo/agent-channel`：`createChannelPool(db): ChannelPool`（两个循环各持一个实例，共用一张表、channel_id 前缀分域）；`createChannelStore(db): ChannelStore`——`bindAgentSession/getAgentSession/clear` 三个方法，结构兼容 agent-service 的 `AgentSessionMapping`，直接注入。

`@asteriskzuo/agent-contracts`：`newEventId()`（`evt_` 前缀）、`buildBusinessChannelId(source, sessionId, businessId)`、`EventEnvelope`、`EventSource`、`CONTRACT_VERSION`。

`@asteriskzuo/agent-scheduler`：

```ts
interface PlatformConfig { hop_limit: number; task_concurrency: number; result_concurrency: number }
interface EntryDriver { execute(task: Task, watcher: BusinessMatch): Promise<ExecutionResult> }
interface ExitDriver {
  destinationOf(binding: ExitBinding): string;               // 纯函数，只看非机密配置
  deliver(binding: ExitBinding, payload: unknown): Promise<void>; // 失败抛错，循环按有界重试处置
}
interface SchedulerLoop { start(): void; stop(): Promise<void> } // start 幂等；stop 等在飞消化落定
createEntryLoop(deps: { queue; exitQueue; registry; channels; config: PlatformConfig; driver: EntryDriver; options? }): SchedulerLoop;
createExitLoop(deps: { queue; registry; channels; config: PlatformConfig; driver: ExitDriver; options? }): SchedulerLoop;
// 装配纪律（本任务履行）：① start 前 initLogger + 两条队列各 recover()；② 两个循环各持专用 ChannelPool
```

`@asteriskzuo/agent-runtime`：

```ts
createEnvProvider(db: Database): EnvProvider;
interface EnvProvider {
  getFor(business_id: string): { vars: Record<string,string>; secrets: Record<string,string> }; // 通用层+业务层合并，业务优先
  set(business_id: string | null, bucket: 'vars'|'secrets', key: string, value: string): void;   // null = 通用层
  remove(business_id: string | null, bucket: 'vars'|'secrets', key: string): void;
  list(business_id: string | null): { vars: Record<string,string>; secret_keys: string[] };
}
createContextLoader(deps: { registry; assets; env: EnvProvider;
  defaults: { task_timeout_minutes: number; max_agent_calls: number } }): ContextLoader;
createLifecycle(deps: { loader: ContextLoader; runner: WorkflowRunner; agentService: AgentService;
  workspaceRoot: string; db: Database }): EntryDriver;  // 四步时序 + 业务标记打标
```

`@asteriskzuo/agent-workflow-runner`：`createWorkflowRunner({ workspaceRoot, maxOutputBytes?, killGraceMs?, nodePath? }): WorkflowRunner`。

`@asteriskzuo/agent-service`：`createAgentService({ pi_cli_path, pi_agent_dir, pi_env, mapping }): AgentService`。`pi_env` = pi 子进程基础环境（PATH/HOME 等）；模型凭据由 `pi_agent_dir` 下的 `models.json` 承载（平台管理文件，不进环境变量）。

`@asteriskzuo/agent-asset-registry`：`createAssetRegistry(db, { cache_root }): AssetRegistry`（`register/list/get/materialize`）。

`@asteriskzuo/agent-exit-tools`：

```ts
createExitRegistry(): ExitRegistry;  // 登记全部七个内置工具
interface ExitRegistry { get(kind: string): ExitTool; list(): ExitTool[] }  // get 未注册抛错
interface ExitTool {
  readonly kind: string; readonly name: string;
  readonly configSchema: ConfigField[];  // ConfigField { key, label, required?, secret?, placeholder? }
  destinationOf(config: Record<string,string>): string;   // 只能来自非机密配置；非法抛错
  bind(config: Record<string,string>): Exit;              // 收完整配置（含已回填机密项）；required 缺失抛错
}
interface Exit { deliver(result: unknown): Promise<void> } // 失败抛错
```

### 2.2 依赖规则（违反即返工）

- server 是装配根：唯一允许 import 全部模块的应用；自身只被 `app/console`（将来）经 HTTP 消费，不被任何 packages 依赖（dpdm 方向检查）；
- 配置读取只能经 `@asteriskzuo/agent-env`；日志只能经全局外观；不允许散点 `process.env`（config.ts 是唯一例外——它是 env 包的调用方）；
- 不修改任何 packages 的文件。

## 3. 范围与不做清单

**本任务做**：`app/server` 全量——config / self-check / bootstrap / main / EntryAdapter 接口 / ExitDriver / 端到端集成验证。

**本任务不做**：

- **webhook 入口适配器**：归 T18（外部业务推送形态复杂，验签/会话标识/幂等约定需结合真实外部业务单独设计；本任务只立 EntryAdapter 接口）；
- **AibotConnector**（企微智能机器人 SDK 连接属主）：归企微入口任务（入口/出口必须共享同一连接）。连接器落地前 `wecom-aibot` 出口绑定的 bind 必抛错（无 resolveSender）→ 投递重试耗尽死信，属已知缺口；
- 其他入口适配器（wecom / jira / github / cron / manual）：各归后续任务；
- 管理 API（T13，复用本任务的装配产物；HTTP 服务与入口流量各自独立，见决策点 6）、控制台 UI（T14）；
- 队列 purge 定时清理、死信告警、任务级重跑（失败处理第二阶段）；
- 身份目录 identity_links、ConfigStore 设置模块（全局默认值本任务经配置注入）；
- `.env` 文件加载（env 包既定边界）。

## 4. 包结构

```text
app/server/
├── package.json            # @asteriskzuo/agent-server（private: true）
├── tsconfig.json           # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts            # 导出 bootstrap / ServerHandle / AssembledContext / 各工厂与类型（供测试与 T13 复用）
│   ├── main.ts             # 进程入口：bootstrap + 信号处理 + 未捕获兜底
│   ├── config.ts           # ServerConfig 解析（env > config.json > 默认）
│   ├── self-check.ts       # 启动自检（fail-fast）
│   ├── bootstrap.ts        # 装配根：创建全部模块实例并按依赖方向接线
│   ├── entry-adapter.ts    # EntryAdapter / EntryDeps 接口（装配层契约）
│   └── exit-driver.ts      # ExitDriver 实现（resolveExitConfig 机密回填）
└── tests/
    ├── config.test.ts
    ├── self-check.test.ts
    ├── exit-driver.test.ts
    └── integration.test.ts # 端到端：直接落队 → 业务执行 → 出口投递（内存 fixture）
```

`dependencies`（版本号形式）：`@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-database`、`@asteriskzuo/agent-queue`、`@asteriskzuo/agent-registry`、`@asteriskzuo/agent-channel`、`@asteriskzuo/agent-logger`、`@asteriskzuo/agent-env`、`@asteriskzuo/agent-scheduler`、`@asteriskzuo/agent-runtime`、`@asteriskzuo/agent-workflow-runner`、`@asteriskzuo/agent-service`、`@asteriskzuo/agent-asset-registry`、`@asteriskzuo/agent-exit-tools`。**零第三方运行时依赖**。包级脚本模板同 T0 §4，另加 `"start": "node dist/main.js"`。

## 5. 详细规格

### 5.1 配置解析（config.ts）

```ts
/** 平台运行配置：装配根的唯一配置来源（解析后只读，不再读环境变量） */
export interface ServerConfig {
  workspace: string;            // 平台工作目录 {workspace}（数据五类分根的根）
  log_level: 'error' | 'warn' | 'info' | 'debug';
  log_enabled: boolean;
  hop_limit: number;            // 派生事件 hop 上限（入口循环判循环）
  task_concurrency: number;     // 入口业务闸门
  result_concurrency: number;   // 出口闸门
  task_timeout_minutes: number; // run 超时全局默认（业务可覆盖，runtime 解析）
  max_agent_calls: number;      // agent 调用配额全局默认（同上）
  pi_cli_path: string;          // pi 可执行文件绝对路径
  pi_agent_dir: string;         // PI_CODING_AGENT_DIR（models.json 所在，模型凭据由该文件承载）
  pi_env: Record<string, string>; // pi 子进程基础环境：{ PATH, HOME }（缺失 = 配置错误）
}

/** 解析配置。envMap 可注入（测试用），缺省 process.env；
 *  缺失必填项 / 非法值 → 抛 EnvError（message 列出全部问题） */
export function resolveServerConfig(envMap?: Record<string, string | undefined>): ServerConfig;
```

环境变量清单（优先级：**环境变量 > `{workspace}/config.json` 同名键 > 代码默认**）：

| 环境变量 | 必填 | 默认 | 约束 |
|----------|------|------|------|
| `AGENT_WORKSPACE` | 是 | — | **只能来自环境变量**（config.json 就在 workspace 里，鸡生蛋） |
| `AGENT_LOG_LEVEL` | 否 | `info` | 四值之一 |
| `AGENT_LOG_ENABLED` | 否 | `true` | 布尔 |
| `AGENT_HOP_LIMIT` | 否 | `8` | ≥1 |
| `AGENT_TASK_CONCURRENCY` | 否 | `4` | ≥1 |
| `AGENT_RESULT_CONCURRENCY` | 否 | `16` | ≥1 |
| `AGENT_TASK_TIMEOUT_MINUTES` | 否 | `60` | ≥1 |
| `AGENT_MAX_AGENT_CALLS` | 否 | `20` | ≥1 |
| `AGENT_PI_CLI_PATH` | 是 | — | 自检验存在可执行 |
| `AGENT_PI_AGENT_DIR` | 是 | — | 自检验含 models.json |

- **config.json**：`{workspace}/config.json`，可选；扁平 JSON object，**键名与环境变量同名**（含 `AGENT_` 前缀），值类型须与目标类型匹配（string/number/boolean）；文件不存在 = 跳过，非法 JSON / 值类型不符 → 抛 EnvError；
- 解析实现：先取 `AGENT_WORKSPACE`（仅 envMap）→ 读 config.json（有则）→ 逐键 `envMap` 优先、文件次之、默认兜底；字符串/数字/布尔解析委托 env 包的三个函数（对 envMap 来源），文件来源的值直接校验类型；
- `pi_env` 固定组 `{ PATH, HOME }`（取自 envMap，缺任一 → 抛 EnvError）；模型凭据一律走 `pi_agent_dir/models.json`（决策点 5）。

### 5.2 启动自检（self-check.ts）

```ts
/** 启动自检（fail-fast）：任一不满足抛出 Error，message 列出全部失败项 */
export function runSelfCheck(config: ServerConfig): void;
```

检查项（全量收集后一次性报出，不遇一错即停）：

1. `{workspace}` 可建可写（mkdirSync recursive + 探测文件写删）；
2. 数据分类子目录骨架可建：`data/` `cache/` `runs/` `logs/`；
3. `pi_cli_path` 存在且可执行（`accessSync(path, constants.X_OK)`）；
4. `pi_agent_dir` 存在且含 `models.json` 文件；
5. `git` 可用（`execFileSync('git', ['--version'])` 成功）——asset-registry 物化资产经 git 子进程，git 缺失则一切资产拉取必败；
6. （node 不单列：workflow-runner 缺省用 `process.execPath` spawn 业务程序，server 能启动即 node 必然在；数据库可打开/迁移由各工厂创建时自然 fail-fast，亦不单列。）

### 5.3 EntryAdapter 接口（entry-adapter.ts，装配层契约）

```ts
import type { EventSource } from '@asteriskzuo/agent-contracts';
import type { TaskQueue } from '@asteriskzuo/agent-queue';
import type { BusinessRegistry } from '@asteriskzuo/agent-registry';
import type { EnvProvider } from '@asteriskzuo/agent-runtime';

/** 入口适配器契约：每个事件源一个实现。职责链：验签 → 包装信封（含 session_id）→ 落队，立即返回。
 *  各入口自管理自己的监听资源（webhook 自起 HTTP 服务、企微自持 SDK 连接、cron 自持定时器），
 *  装配根只管注入依赖与调 start/stop */
export interface EntryAdapter {
  readonly source: EventSource;
  /** 装配根在循环启动后调用；deps 为装配产物（入口与内部模块共用同一套公开接口） */
  start(deps: EntryDeps): void;
  /** 优雅停（停止接收、释放监听资源）；幂等 */
  stop(): Promise<void>;
}

export interface EntryDeps {
  queue: TaskQueue;            // 入口队列
  registry: BusinessRegistry;  // 入口配置（match 行 entry_config）读取
  env: EnvProvider;            // 入口验签凭据（secrets 桶）
}
```

设计文档 core-modules §4.8 的 `EntryDeps { queue, idGen, clock, log }` 在落地中调整：id 生成与时间戳已由 contracts 纯函数（`newEventId`）与 `new Date().toISOString()` 承担，日志由全局外观承担；实际需要的是 registry（入口配置）与 env（验签凭据）（决策点 1）。

### 5.4 ExitDriver（exit-driver.ts）

```ts
/** 创建出口执行器：ExitRegistry 取用 + 机密回填 + bind/deliver */
export function createExitDriver(deps: {
  exits: ExitRegistry;
  env: EnvProvider;
}): ExitDriver;  // @asteriskzuo/agent-scheduler 的类型，显式 import type 标注
```

- `destinationOf(binding)` = `exits.get(binding.tool).destinationOf(binding.config)`——纯函数，binding.config 只有非机密项，恰好满足 destinationOf「只能来自非机密配置」的约束；
- `deliver(binding, payload)`：
  1. `tool = exits.get(binding.tool)`；
  2. 机密回填：`config = { ...binding.config }`；遍历 `tool.configSchema` 中 `secret: true` 的项，键规则 **`exit.{kind}.{field.key}`**（本规格唯一定义处；core-modules §4.5 只给了 `exit.{tool}.` 前缀方向，控制台 T13/T14 写 secrets 时必须用同一规则），取 `env.getFor(binding.business_id).secrets[回填键]`，有才合入；
  3. `tool.bind(config).deliver(payload)`——required 机密缺失由 bind 校验抛错，出口循环按有界重试处置（配置类错误重试无用，耗尽死信，语义可接受）。

### 5.5 装配根（bootstrap.ts）

```ts
/** 装配产物：T13 管理 API 与 T18 入口适配器复用的全部实例 */
export interface AssembledContext {
  config: ServerConfig;
  db: Database;
  entryQueue: TaskQueue; exitQueue: TaskQueue;
  registry: BusinessRegistry;
  env: EnvProvider;
  assets: AssetRegistry;
  entryLoop: SchedulerLoop; exitLoop: SchedulerLoop;
}

export interface ServerHandle {
  context: AssembledContext;
  /** 优雅停：入口适配器 stop（有则）→ 两循环 stop → db close；幂等 */
  stop(): Promise<void>;
}

/** 装配并启动平台。envMap 可注入（测试用）；配置/自检失败抛错（main 负责退出码） */
export function bootstrap(overrides?: {
  env?: Record<string, string | undefined>;
  adapters?: EntryAdapter[];   // 入口适配器实例（本任务缺省为空——T18 起由 main 注入真实入口）
}): Promise<ServerHandle>;
```

**装配顺序**（固定，代码注释标注各步）：

1. `config = resolveServerConfig(overrides?.env)`；
2. `initLogger({ logsDir: '{workspace}/logs', level: config.log_level, enabled: config.log_enabled })`——自带目录自检；
3. `runSelfCheck(config)`；
4. system 日志「启动中」（回显关键配置：闸门/workspace/pi 路径——**不含任何 secret**）；
5. 接线（依赖方向即创建顺序）：
   - `db = openDatabase('{workspace}/data/platform.db')`；
   - `entryQueue = createTaskQueue(db, 'entry_tasks')`、`exitQueue = createTaskQueue(db, 'exit_tasks')`；
   - `registry = createBusinessRegistry(db)`；
   - `entryChannels = createChannelPool(db)`、`exitChannels = createChannelPool(db)`（两循环各持一池）；
   - `channelStore = createChannelStore(db)`；
   - `assets = createAssetRegistry(db, { cache_root: '{workspace}/cache/assets' })`；
   - `envProvider = createEnvProvider(db)`；
   - `loader = createContextLoader({ registry, assets, env: envProvider, defaults: { task_timeout_minutes: config.task_timeout_minutes, max_agent_calls: config.max_agent_calls } })`；
   - `runner = createWorkflowRunner({ workspaceRoot: config.workspace })`；
   - `agentService = createAgentService({ pi_cli_path: config.pi_cli_path, pi_agent_dir: config.pi_agent_dir, pi_env: config.pi_env, mapping: channelStore })`；
   - `lifecycle = createLifecycle({ loader, runner, agentService, workspaceRoot: config.workspace, db })`；
   - `exits = createExitRegistry()`；
   - `exitDriver = createExitDriver({ exits, env: envProvider })`；
   - `platformConfig = { hop_limit, task_concurrency, result_concurrency }`（取自 config）；
   - `entryLoop = createEntryLoop({ queue: entryQueue, exitQueue, registry, channels: entryChannels, config: platformConfig, driver: lifecycle })`；
   - `exitLoop = createExitLoop({ queue: exitQueue, registry, channels: exitChannels, config: platformConfig, driver: exitDriver })`；
6. **崩溃恢复**：`entryQueue.recover()` + `exitQueue.recover()`，重置条数记 system info；
7. `entryLoop.start()`、`exitLoop.start()`；
8. 适配器逐一 `start({ queue: entryQueue, registry, env: envProvider })`（本任务缺省为空集）；
9. system 日志「启动完成」。

### 5.6 进程入口（main.ts）

```ts
// 进程入口：node dist/main.js
// ① bootstrap() 失败 → stderr 打印 + process.exit(1)（initLogger 之前失败只有 stderr；
//    之后失败 bootstrap 内已记 error 日志）；
// ② SIGINT/SIGTERM → await handle.stop() → exit(0)；
// ③ process.on('uncaughtException' / 'unhandledRejection') → system error 日志，不退出
//    （logging.md §5.2：运行期不崩溃，兜底保住主循环）。
```

## 6. 测试清单

通用手法：内存/临时目录造真实实例（`openDatabase(临时文件)`）；环境变量经 `envMap` 注入（不碰 `process.env`）；logger `initLogger({ logsDir: 临时目录 })`，各测试文件后 `resetForTests()`。

**config.test.ts**：

- 必填缺失（AGENT_WORKSPACE / AGENT_PI_CLI_PATH / PATH / HOME）→ EnvError 且 message 含变量名；
- 全默认：给齐必填 → 各默认值正确（8/4/16/60/20/info/true），pi_env = { PATH, HOME }；
- config.json 兜底：临时 workspace 写 config.json（`AGENT_TASK_CONCURRENCY: 9`）→ 生效；同名环境变量存在 → 环境变量优先；非法 JSON / 值类型不符 → EnvError；
- 数字越界 / 非法布尔 / 非法 log_level → EnvError。

**self-check.test.ts**：

- 全绿通过（临时 workspace + fixture pi）；
- pi_cli_path 不存在 / 不可执行 → 抛错且 message 含路径；
- pi_agent_dir 缺 models.json → 抛错；
- workspace 不可写（注入只读目录）→ 抛错；多项同时失败 → message 列出全部失败项；
- git 不可用（用例内临时将 `process.env.PATH` 置空、结束恢复）→ 抛错且 message 含 `git`。

**exit-driver.test.ts**（假 ExitRegistry 记录 bind 收到的 config；真 EnvProvider 内存库）：

- `destinationOf` 透传 tool.destinationOf(binding.config)；
- 机密回填：configSchema 含 `secret:true` 的 `pass` 项 + secrets 桶有 `exit.mail.pass` → bind 收到合并后 config（非机密项原样 + 机密项回填）；secrets 无该键 → 不回填（bind 侧 required 抛错透出）；
- `secret:false` 的项绝不回填（即使 secrets 有同名键）；
- 未知 tool → `exits.get` 抛错透出。

**integration.test.ts**（端到端，全真实装配）：

- 临时 workspace；envMap 注入必填项（pi_cli_path 指向 fixture 假 pi 可执行脚本、pi_agent_dir 指向含哑 models.json 的 fixture 目录）→ `bootstrap({ env })`；
- 造资产：临时目录 git init + commit 一个**包资产**（含 `agent-package.json` 清单 + 流程程序 fixture：读 stdin 信封，stdout 输出一行 `{contract_version:'v1', ok:true, output:{echo: input.payload, got_config: config['X']}}`）→ `assets.register({ kind:'package', url: 本地路径, ref:'HEAD', owner_id })`；git commit 用 `git -c user.email=test@test -c user.name=test`；
- `registry.create` 业务（绑定该包 + entry_program + prompt；EnvProvider vars 写 `X`）→ `addMatch(bid, 'manual', 'test.ping')` → 出口绑定 `webhook` 工具（config.url 指向本地接收服务器）；
- **模拟入口落队**（等价于入口适配器的落队动作）：直接向 `entryQueue.enqueue` 一个 `{ source:'manual', event_type:'test.ping', session_id:'S-1', ... }` 合法信封；
- 断言（轮询等待，总超时 15s）：① 本地接收服务器收到出口投递，payload = `{ echo: 原 payload, got_config: 'X值' }`；② lifecycles 表有该业务 success 行；③ `logs/businesses/manual/S-1/{bid}/` 下有 run 日志文件；④ `runs/manual/S-1/{bid}/` 下有 run 工作区；
- `await handle.stop()` 干净退出（不挂起）。

## 7. 验收标准

1. 根级六连全绿：`yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular`；
2. §6 测试清单全覆盖；integration.test.ts 连跑 10 次不 flake；
3. 零第三方运行时依赖；packages 零改动；无任何 packages 依赖 app/server；
4. 导出签名与本文 §5 一致；全包仅 config.ts 经 env 包接触环境变量，无散点 `process.env`；
5. `yarn workspace @asteriskzuo/agent-server build && AGENT_WORKSPACE=<临时目录> AGENT_PI_CLI_PATH=<假pi> AGENT_PI_AGENT_DIR=<fixture> node app/server/dist/main.js` 能起能停（自检失败路径同样验证：缺 AGENT_WORKSPACE 退出码 1）。

## 8. 本规格的决策点（设计文档未覆盖或有调整，主 agent 已定，owner 已审）

1. **EntryAdapter 接口落装配层、EntryDeps 形状调整**：设计文档的 `{ queue, idGen, clock, log }` 中 idGen/clock/log 已分别由 contracts 纯函数、`new Date().toISOString()`、logger 全局外观承担（T0–T17 的落地现实）；接口实际需要 queue / registry（入口配置）/ env（验签凭据）。接口定义在 app/server（装配层契约），不进 contracts 包——它是组装关系而非数据契约。
2. **webhook 入口适配器后移 T18**（2026-10-04，owner 裁决）：webhook 监听外部业务推送，验签与会话标识规则需结合真实外部业务形态单独设计，不在装配任务里凭空定。本任务只立接口；entry_config schema / 验签 / 幂等头约定随 T18 定。
3. **AibotConnector 不在本任务**（owner 裁决）：归企微入口任务（入口/出口共享同一 SDK 连接，T9 spec 决策 J）。连接器落地前 wecom-aibot 出口绑定 bind 必抛错 → 重试耗尽死信，已知缺口。
4. **出口机密回填键规则定稿**：`exit.{kind}.{field.key}`（core-modules §4.5 只给了前缀方向）。本规格是唯一定义处，控制台写 secrets 与装配根回填共用此规则。
5. **pi_env 只组 PATH/HOME**：模型凭据由 `pi_agent_dir/models.json` 承载（平台管理文件），不进环境变量、不进日志；将来确有 env 形式凭据需求再扩配置项。
6. **入口流量与管理 API 各自独立**（owner 裁决）：各入口适配器自管理监听资源（webhook 将来在 T18 自起 HTTP 服务、独立端口），管理 API（T13）另起独立 HTTP 服务与端口——架构清晰、各自演化，不共享实例。
7. **config.json 兜底**：env > `{workspace}/config.json`（同名键、扁平 JSON）> 代码默认；`AGENT_WORKSPACE` 仅环境变量（config.json 栖身于 workspace）。
8. **集成验证的入口 = 直接落队**：入口适配器的本质动作就是 `queue.enqueue`（验签/包装归 T18），集成测试直接落队即可走通全链路，不因 webhook 后移而削弱验证强度。
9. **自检失败退出码 1**：initLogger 之前的失败（配置解析）走 stderr；之后走 system error 日志 + stderr。带病运行比不运行更危险（logging.md §5.1）。
10. **自检覆盖 git、不覆盖 node**（owner 裁决）：git 是 asset-registry 物化资产的子进程依赖（`execFileSync("git", …)`），缺失则资产拉取必败，必须 fail-fast；node 由 workflow-runner 以 `process.execPath`（server 进程本体）spawn 业务程序，server 能启动即恒真，不做恒真检查。pi 经 `AGENT_PI_CLI_PATH` 检查（存在+可执行）。
