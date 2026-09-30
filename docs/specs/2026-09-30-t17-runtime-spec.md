# T17 runtime 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/core-modules.md` §4.1/§4.2/§4.5、`design/scheduler-loop-contracts.md` §4/§5、`design/lifecycle.md`、`design/console-design.md` §4/§6、`design/asset-model.md` §3.1/§9。

## 1. 目标

产出 `@easemob/agent-runtime` 包：**入口循环「过闸门之后」的全部重数据组装与执行编排**——EnvProvider（两桶环境配置）+ ContextLoader（组装 RunContext）+ Lifecycle（实现 scheduler 的 EntryDriver：四步时序 + 业务标记打标）。同时顺带完成两个既有包的小扩展：registry 扩业务资料字段（迁移 v2）、workflow-runner 的 RunRequest 加可选 `run_id`。

本包是 scheduler（轻数据调度）与 workflow-runner / agent-service（执行原语）之间的**唯一粘合层**。心脏不认识业务：scheduler 只调 `EntryDriver.execute(task, watcher)`，业务细节全部封在本包内。

## 2. 背景知识（执行所需的最小上下文）

- **四步时序**（Lifecycle.run 内部固定，core-modules §4.2 为唯一定义处）：① ContextLoader 组装静态上下文（此时尚无 endpoint）→ ② `AgentService.serve(context)` 得 endpoint（socket 监听就绪）→ ③ `WorkflowRunner.run`（endpoint 注入）执行业务流程程序 → ④ 进程退出 → serve 关闭、token 失效、结果出炉。
- **业务资料**（控制台登记，registry 存储）：提示词总纲 prompt（每业务一个，平台注入）、包绑定（恰好 1 个包资产 + 流程程序入口名）、工具绑定（任意多工具资产）、skill 绑定（任意多 skill 集合资产）、agent 内核（MVP 仅 pi）、大模型（MVP 仅 qwen3.8max）、quota 覆盖（timeout_minutes / max_agent_calls，业务级优先于全局默认）、入口配置（每匹配行一份，平台不解析、原样透传）。
- **EnvProvider 两桶**：普通桶 vars / 安全桶 secrets，区别只在存储与回显（安全桶只写不读明文、掩码回显、不进日志）；使用方式相同。**业务级优先于通用级**（同超时优先级规则）。github/jira 等账号凭证本质也是 key-value，不设第三类。
- **资产消费**：ContextLoader 经 asset-registry 物化业务绑定的全部资产（包 + 工具 + skill 集合），物化幂等（命中缓存即返回）。私有资产（`is_private`）的凭据按**操作者维度**解析：runtime 场景的触发者是业务，取该业务两桶中 `credential_key` 同名的值（secrets 优先、vars 兜底），传给 `materialize(asset_id, { credential })`。
- **channel_id**：业务通道 = `buildBusinessChannelId(source, session_id, business_id)`（contracts 提供纯函数）。scheduler 调 EntryDriver 时不传 channel_id，本包用同一纯函数自行计算，结果必然一致。
- **配额解析**：`timeout_minutes` / `max_agent_calls` = 业务资料覆盖值 ?? 工厂注入的全局默认值。ConfigStore（设置模块）尚未实现，全局默认值由装配根经工厂参数注入，本包不读环境变量。
- **业务标记**：生命周期状态机（created → running → success/failed/timeout）落库，是控制台任务监控的投影来源。
- 数据访问只能经 `@easemob/agent-database`，禁止直接 import `node:sqlite`。

### 2.1 消费的上游包真实签名

`@easemob/agent-scheduler`（0.1.0，`packages/scheduler/src/types.ts`）：

```ts
/** 执行结果（Lifecycle 的返回形状） */
export interface ExecutionResult {
  status: "success" | "failed" | "timeout"; // timeout 在扇出时归 failed（scheduler 负责）
  output: unknown;                          // 业务产出；派生事件的 payload（成功时）
  usage?: { tokens: number; duration_ms: number };
}

/** 入口执行器：一个 (任务, 关注者) 的一次完整业务执行。分钟级长调用。
 *  约定：业务失败应返回 {status:'failed'|'timeout'} 而非抛错；
 *  抛错 = 基础设施异常，scheduler 兜底合成 failed 并记 error 日志 */
export interface EntryDriver {
  execute(task: Task, watcher: BusinessMatch): Promise<ExecutionResult>;
}
```

`@easemob/agent-workflow-runner`（0.1.0）：

```ts
export interface RunRequest {
  program: string;            // 流程程序入口 JS 的绝对路径
  event: EventEnvelope;       // 触发信封（取 source/session_id 用于目录与日志键）
  business_id: string;
  config: Record<string, string>;   // 业务非机密配置（→ stdin config）
  secrets: Record<string, string>;  // 业务安全变量（→ stdin secrets，不落盘不进日志）
  endpoint: { socket_path: string; token: string }; // AgentService 的 per-run 端点
  quota: { timeout_minutes: number };               // wall-clock 超时；agent 次数配额归 agent-service
  // 本任务扩展 ↓（见 §5.5）
  run_id?: string;            // 可选：调用方指定 run_id（缺省内部生成 `run_${ulid}`）；workspace/日志路径按它派生
}

export interface RunOutcome {
  status: "success" | "failed" | "timeout";
  output: unknown;   // 仅 success 有值
  reason?: string;   // failed/timeout 原因
}

export interface WorkflowRunner {
  /** 业务失败/异常/超时都返回 RunOutcome；只有平台自身错误（目录不可建、program 不存在、段非法）才抛错 */
  run(req: RunRequest): Promise<RunOutcome>;
}
```

runner 内部路径规则（本包必须与之对齐）：`workspace = {workspaceRoot}/runs/{source}/{session_id}/{business_id}/{run_id}/`；业务日志 = `{workspaceRoot}/logs/businesses/{同三维}/{run_id}.log`。

`@easemob/agent-service`（0.1.0）：

```ts
export interface SkillRef {
  name: string;  // 白名单校验的键（sdk.agent 请求里的名）
  path: string;  // 物化后的 skill 绝对路径（--skill 注入）
}

export interface AgentServeContext {
  run_id: string;          // socket 文件名、日志关联用
  channel_id: string;      // 业务通道 channel_id（会话映射键）
  workspace: string;       // run 工作目录 = pi 子进程 cwd
  prompt: string;          // 提示词总纲 → --system-prompt
  skills: SkillRef[];      // 本业务 skill 白名单（全集）
  model: string;           // --model 值
  session_dir: string;     // pi 会话存储目录（装配方保证存在）
  audit_log_path: string;  // 请求体审计落盘路径（serve 时建父目录）
  quota: { max_agent_calls: number };
}

export interface AgentService {
  /** 每 run 调一次：监听就绪后返回；close 幂等（杀在飞 pi、删 socket、token 失效） */
  serve(ctx: AgentServeContext): Promise<{ endpoint: { socket_path: string; token: string }; close(): Promise<void> }>;
}
```

`@easemob/agent-asset-registry`（0.1.0）：

```ts
export type AssetKind = 'package' | 'tool' | 'skill';

export interface AssetMeta {
  asset_id: string; kind: AssetKind; owner_id: string; shared: boolean;
  is_private: boolean;
  credential_key?: string;  // 仅 is_private 时有值（key 名，非值）
  created_at: string; modified_at: string;
}

export type AssetManifest =
  | { kind: 'package'; name: string; version?: string;
      programs: Record<string, string>;
      requires: { tools: string[]; skills: string[] } }  // requires 是 package 专属（工具是叶子组件）
  | { kind: 'tool'; name: string; version?: string;
      programs: Record<string, string> }                 // 无 requires
  | { kind: 'skill'; skills: string[] };  // 技能名列表（字典序）

export interface AssetObject { meta: AssetMeta; manifest: AssetManifest; }

/** 名解析的输入视图项；解析按传入顺序首个命中 */
export interface ResolvedAsset {
  asset_id: string;
  root: string;                       // 物化后的资产根绝对路径
  programs: Record<string, string>;   // package/tool 的清单 programs；skill 传 {}
  skills: string[];                   // skill 资产的技能名列表；package/tool 传 []
}

export interface AssetRegistry {
  register(input: AssetInput, opts?: { credential?: string }): AssetMeta;
  list(filter: { kind?: AssetKind; owner_id?: string; shared?: boolean }): AssetMeta[];
  /** 内部先 materialize 再校验解析；未登记抛 asset_not_found；is_private 且缓存缺失且未传 credential → credential_required: <credential_key> */
  get(asset_id: string, opts?: { credential?: string }): AssetObject;
  /** 幂等；缓存缺失自动补拉；credential 规则同 get */
  materialize(asset_id: string, opts?: { credential?: string }): string;
}

/** 名解析纯函数：kind='program' 查各资产 programs，kind='skill' 查各资产 skills；
 *  按集合顺序首个命中；全无 → 抛 resource_not_found: <kind> <name> */
export function resolveResource(
  assets: readonly ResolvedAsset[], kind: 'program' | 'skill', name: string,
): { asset_id: string; name: string; path: string };
```

`@easemob/agent-registry`（0.1.0，本任务扩展前的现有面）：

```ts
export interface BusinessMatch {
  business_id: string; business_name: string; creator_id: string;
  source: EventSource;        // 行级
  event_type: string;         // 行级
  on_failure?: boolean;
}
export interface BusinessRegistry {
  match(source: EventSource, event_type: string): BusinessMatch[];
  exitBindings(business_id: string): ExitBinding[];
  get(business_id: string): BusinessMatch[];
  update(business_id: string, patch: BusinessPatch): void;
  create(input: CreateBusinessInput): string;
  addMatch(business_id: string, source: EventSource, event_type: string): void;
  removeMatch(business_id: string, source: EventSource, event_type: string): void;
  remove(business_id: string): void;
}
export function createBusinessRegistry(db: Database): BusinessRegistry;
```

存储现状（迁移 v1，module `'registry'`）：`businesses`(business_id PK, business_name, creator_id, on_failure INTEGER, exit_bindings TEXT JSON)；`business_matches`(business_id, source, event_type, UNIQUE 三列)。

`@easemob/agent-queue`（0.1.0）：`Task { task_id: string; event: EventEnvelope; status; enqueued_at: string; finished_at?: string }`。

`@easemob/agent-contracts`（0.1.0）：`EventEnvelope`（contract_version/source/event_id/event_type/timestamp/session_id/correlation_id/hop_count/payload/producer_business_id?）、`buildBusinessChannelId(source, session_id, business_id): string`、`newUlid(): string`。

`@easemob/agent-logger`（0.1.0）：全局外观 `logger.for({ module, ...固定字段 })` → CategoryLogger（error/warn/info/debug）。本包日志 module 名统一用 `'entry-loop'`（生命周期属入口循环侧，日志分类归入口循环日志）。

## 3. 范围与不做清单

**本任务做**：

1. `packages/runtime/` 新包：EnvProvider + ContextLoader + Lifecycle（EntryDriver 实现）+ lifecycle 打标表；
2. `packages/registry/` 扩展：迁移 v2 扩业务资料字段 + `getProfile` 读口 + create/update/addMatch 相应扩展；
3. `packages/workflow-runner/` 扩展：RunRequest 加可选 `run_id`（§5.5）。

**本任务不做**：

- ConfigStore（设置模块）与键注册表（全局默认值由工厂参数注入，将来装配根从 ConfigStore 取）；
- 权限校验（EnvProvider.set / registry 写口的 actor 规则归控制台与账号体系，同 T4 先例：本层只做机械读写）；
- 入口配置 entry_config 的解析与使用（平台不解析，原样透传；消费方是未来的入口适配层）；
- 出口侧（ExitDriver / resolveExitConfig 的机密回填归 T12 装配或后续任务）；
- ChannelStore 消费（agent-service 自带 mapping 依赖，会话映射不需要 ContextLoader 经手——见 §8 决策点 4）；
- secrets 加密存储（第一版明文存 platform.db，见 §8 决策点 6）；
- `ExecutionResult.usage` 的 tokens 采集（审计落盘已有请求体；usage 暂不填，见 §8 决策点 7）。

## 4. 包结构

```text
packages/runtime/
├── package.json            # @easemob/agent-runtime
├── tsconfig.json           # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts            # 统一导出
│   ├── env-provider.ts     # EnvProvider：两桶 key-value（表 env_entries）
│   ├── context-loader.ts   # ContextLoader：profile → 物化闭包 → 名解析 → RunContext
│   ├── lifecycle.ts        # Lifecycle：EntryDriver 实现（四步时序）+ 打标
│   └── lifecycle-store.ts  # lifecycles 表读写（打标/查询）
└── tests/
    ├── env-provider.test.ts
    ├── context-loader.test.ts
    └── lifecycle.test.ts
```

工程约定同 T0 spec §4。`dependencies`（版本号形式）：`@easemob/agent-contracts`、`@easemob/agent-database`、`@easemob/agent-registry`、`@easemob/agent-asset-registry`、`@easemob/agent-workflow-runner`、`@easemob/agent-service`、`@easemob/agent-scheduler`（**仅 import type** EntryDriver/ExecutionResult）、`@easemob/agent-logger`。

registry / workflow-runner 的扩展在原包内完成（各自的迁移与测试随包走）。

## 5. 详细规格

### 5.1 registry 扩展（迁移 v2，module `'registry'`）

**businesses 表加列**（ALTER TABLE ADD COLUMN）：

| 列 | 类型 | 缺省 | 说明 |
|----|------|------|------|
| `prompt` | TEXT NOT NULL | `''` | 提示词总纲 |
| `model` | TEXT NOT NULL | `'qwen3.8max'` | 大模型选择 |
| `agent_kind` | TEXT NOT NULL | `'pi'` | agent 内核（MVP 仅 pi） |
| `package_asset_id` | TEXT | NULL | 绑定的包资产 |
| `entry_program` | TEXT | NULL | 流程程序入口名（包清单 programs 的键） |
| `tool_asset_ids` | TEXT NOT NULL | `'[]'` | 工具资产 id 数组（JSON） |
| `skill_asset_ids` | TEXT NOT NULL | `'[]'` | skill 集合资产 id 数组（JSON） |
| `timeout_minutes` | INTEGER | NULL | run 超时覆盖；NULL = 用全局默认 |
| `max_agent_calls` | INTEGER | NULL | agent 调用次数配额覆盖；NULL = 用全局默认 |

**business_matches 表加列**：`entry_config` TEXT（JSON object，NULL）——入口配置（过滤配置、会话标识规则等），平台不解析、原样存储透传。

**新增类型与方法**（既有方法签名不变，行为兼容）：

```ts
/** 业务资料（业务级字段的完整读面；匹配视图 BusinessMatch 保持轻量不变） */
export interface BusinessProfile {
  business_id: string;
  business_name: string;
  creator_id: string;
  on_failure: boolean;
  prompt: string;               // 提示词总纲（可空串）
  model: string;
  agent_kind: string;
  package_asset_id?: string;    // 未绑定 = undefined
  entry_program?: string;
  tool_asset_ids: string[];     // 缺省 []
  skill_asset_ids: string[];    // 缺省 []
  timeout_minutes?: number;
  max_agent_calls?: number;
}

// BusinessRegistry 追加：
/** 取业务资料；业务不存在返回 undefined */
getProfile(business_id: string): BusinessProfile | undefined;
```

- `CreateBusinessInput` 追加可选字段：`prompt?` / `model?` / `agent_kind?` / `package_asset_id?` / `entry_program?` / `tool_asset_ids?` / `skill_asset_ids?` / `timeout_minutes?` / `max_agent_calls?`（全部缺省即上表缺省值）。**registry 层不做强必填校验**（机械存储；「包绑定/总纲必填」是控制台业务流程的校验职责）；
- `BusinessPatch` 追加同名字段（均为可选；`timeout_minutes` / `max_agent_calls` 支持显式传 `null` 表示清除覆盖——落库 NULL）；
- `addMatch(business_id, source, event_type, entry_config?: Record<string, unknown>)`：第四参可选，落库为 JSON 文本；`BusinessMatch` 类型加 `entry_config?: Record<string, unknown>`（读出时 JSON 解析）；
- 迁移 v2 必须与 v1 共存升级：老库（v1 数据）migrate 后数据不丢、新列取缺省。

### 5.2 EnvProvider

```ts
/** 两桶环境配置（与 scheduler-loop-contracts §4 EnvConfig 同形） */
export interface EnvConfig {
  vars: Record<string, string>;
  secrets: Record<string, string>;
}

export interface EnvProvider {
  /** 组装上下文时取：通用层（scope=''）+ 业务层合并（业务优先）；secrets 仅在此时出库进内存 */
  getFor(business_id: string): EnvConfig;

  /** 控制台写入：upsert；business_id = null 表示通用层。secrets 只写不读明文（本接口无读明文出口） */
  set(business_id: string | null, bucket: 'vars' | 'secrets', key: string, value: string): void;

  /** 删除一个 key；不存在幂等 */
  remove(business_id: string | null, bucket: 'vars' | 'secrets', key: string): void;

  /** 控制台展示：vars 给明文键值；secrets 只给键名（掩码回显归控制台渲染） */
  list(business_id: string | null): { vars: Record<string, string>; secret_keys: string[] };
}
```

存储（迁移 module `'runtime'`）：

```sql
CREATE TABLE env_entries (
  scope TEXT NOT NULL,          -- business_id；通用层 = ''
  bucket TEXT NOT NULL,         -- 'vars' | 'secrets'
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, bucket, key)
);

CREATE TABLE lifecycles (
  lifecycle_id TEXT PRIMARY KEY,   -- = run_id（见 §8 决策点 5）
  business_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'created' | 'running' | 'success' | 'failed' | 'timeout'
  created_at TEXT NOT NULL,
  finished_at TEXT
);
```

- key 校验：非空、 trim 后与原名一致（拒绝空白键）；value 允许空串；
- 时间戳 `new Date().toISOString()`。

### 5.3 ContextLoader

```ts
/** 可执行上下文：四步时序第①步的产物，Lifecycle 据此装配 serve 与 run 的入参 */
export interface RunContext {
  business_id: string;
  channel_id: string;                 // buildBusinessChannelId 计算结果（回显用）
  program: string;                    // 流程程序入口绝对路径（名解析命中）
  prompt: string;                     // 总纲（可空串，agent-service 原样传）
  skills: SkillRef[];                 // 白名单全集：绑定 skill 集合的技能并集（name + 物化绝对路径）
  model: string;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  quota: { timeout_minutes: number; max_agent_calls: number };  // 已解析（业务优先）
}

export interface ContextLoader {
  /** 组装运行上下文；同步（asset-registry 物化是同步接口）。
   *  业务不存在 → 抛 business_not_found: <business_id>；
   *  未绑定包/入口程序 → 抛 invalid_business: <原因>（控制台本应拦住，运行时兜底） */
  load(business_id: string, channel_id: string): RunContext;
}

export function createContextLoader(deps: {
  registry: BusinessRegistry;       // 扩展后的（含 getProfile）
  assets: AssetRegistry;
  env: EnvProvider;
  defaults: { task_timeout_minutes: number; max_agent_calls: number }; // 全局默认（装配根注入）
}): ContextLoader;
```

load 步骤（顺序固定）：

1. `registry.getProfile(business_id)` → undefined 则抛 `business_not_found`；
2. `env.getFor(business_id)` → `{ vars, secrets }`（先取配置：下一步凭据解析要用）；
3. 物化闭包：资产 id 集合 = `[package_asset_id, ...tool_asset_ids, ...skill_asset_ids]`（package_asset_id 缺失 → `invalid_business: 未绑定包`），逐个 `assets.get(asset_id, { credential })`——credential 解析：`meta.is_private` 时取 `secrets[meta.credential_key] ?? vars[meta.credential_key]`，仍无 → 不传（asset-registry 自己抛 `credential_required`，原样上抛）；
4. 名解析：构造 `ResolvedAsset[]`（顺序 = 包在前、工具随后、skill 最后；root = `assets.materialize(asset_id, { credential })`——get 已物化，此处命中缓存）：
   - `program = resolveResource(assets, 'program', profile.entry_program).path`（entry_program 缺失 → `invalid_business: 未指定入口程序`；找不到 → `resource_not_found` 原样上抛）；
   - `skills`：遍历 skill 资产的 `manifest.skills`，逐个 `resolveResource(assets, 'skill', 技能名)` → `{ name, path }`；
5. quota：`timeout_minutes = profile.timeout_minutes ?? defaults.task_timeout_minutes`，`max_agent_calls = profile.max_agent_calls ?? defaults.max_agent_calls`；
6. 返回 RunContext。**每次 run 都重新组装**（物化命中缓存是廉价路径），不引入缓存失效问题。

### 5.4 Lifecycle（EntryDriver 实现）

```ts
export interface LifecycleDeps {
  loader: ContextLoader;
  runner: WorkflowRunner;
  agentService: AgentService;
  workspaceRoot: string;   // 平台工作目录 {workspace}（其下 runs/ cache/ logs/ 布局与 runner 对齐）
  db: Database;            // 打标表（lifecycles，§5.2 迁移）
}

/** 创建 Lifecycle：实现 scheduler 的 EntryDriver 契约（结构对齐，显式 import type 标注） */
export function createLifecycle(deps: LifecycleDeps): EntryDriver;

/** 打标读口（控制台任务监控用；最小集） */
export interface LifecycleStore {
  /** 按业务查执行记录，按 created_at 倒序；limit 缺省 50 */
  listByBusiness(business_id: string, limit?: number): LifecycleRecord[];
  get(lifecycle_id: string): LifecycleRecord | undefined;
}
export interface LifecycleRecord {
  lifecycle_id: string; business_id: string; event_id: string; channel_id: string;
  status: 'created' | 'running' | 'success' | 'failed' | 'timeout';
  created_at: string; finished_at?: string;
}
```

`execute(task, watcher)` 步骤（顺序固定，即四步时序的落地）：

1. `channel_id = buildBusinessChannelId(task.event.source, task.event.session_id, watcher.business_id)`；`run_id = \`run_\${newUlid()}\``；**打标 created → running**（一行插入即 running：created 是瞬时态，不落中间行，注释说明）；
2. 路径组齐（mkdirSync recursive）：`workspace = {workspaceRoot}/runs/{source}/{session_id}/{business_id}/{run_id}`、`session_dir = {workspaceRoot}/cache/agent-sessions/{source}/{session_id}/{business_id}`、`audit_log_path = {workspace}/audit/llm-requests.jsonl`（父目录建好后 serve 内还会兜底）；
3. ① `ctx = loader.load(business_id, channel_id)`；
4. ② `handle = await agentService.serve({ run_id, channel_id, workspace, prompt: ctx.prompt, skills: ctx.skills, model: ctx.model, session_dir, audit_log_path, quota: { max_agent_calls: ctx.quota.max_agent_calls } })`；
5. ③ `try { outcome = await runner.run({ program: ctx.program, event: task.event, business_id, config: ctx.vars, secrets: ctx.secrets, endpoint: handle.endpoint, quota: { timeout_minutes: ctx.quota.timeout_minutes }, run_id }) } finally { await handle.close() }`——**close 必须无条件执行**（含 runner 抛错路径）；
6. 打标终态（success/failed/timeout + finished_at），返回 `{ status: outcome.status, output: outcome.output }`（usage 不填，决策点 7）。

**失败纪律**：

- 步骤 1–4 失败（business_not_found / invalid_business / credential_required / resource_not_found / 物化失败 / serve 失败）：打标 failed → **原样抛错**（这些是配置或基础设施问题，归 scheduler 兜底合成 failed + error 日志；业务标记必须有终态，故先打标再抛）；
- 步骤 5 runner 抛错（平台自身错误）：打标 failed → 原样抛；
- runner 返回 failed/timeout：不抛错，打标对应终态后返回（EntryDriver 契约：业务失败返回而非抛）。

### 5.5 workflow-runner 扩展

`RunRequest` 加可选字段 `run_id?: string`：

- 缺省：维持现状（内部 `run_${newUlid()}` 生成）；
- 传入：跳过内部生成，workspace 与业务日志路径按传入值派生（路径规则不变）；
- 合法性：传入值须匹配 `/^run_[0-9A-HJKMNP-TV-Z]{26}$/`（ulid 形），不符 → 抛错（平台自身错误类）。

主 agent 会同步回写 T10 spec（`docs/specs/2026-09-29-t10-workflow-runner-spec.md`）该字段——执行者只改代码与测试，不动 docs/。

### 5.6 日志纪律

- module 固定 `'entry-loop'`；固定字段带 `business_id`、`channel_id`（serve 内 agent-service 自带 run_id 关联，本包日志也补 `run_id`）；
- 必打点：run 开始（info，event_id/run_id）、run 终态（info；failed/timeout 用 warn，reason 带上）、loader/serve 失败（error）；
- **secrets 值不进任何日志**（runner 已做 addSecrets 登记，本包不重复、不打印）。

## 6. 测试清单

`tests/env-provider.test.ts`：

- set/getFor 往返：vars 与 secrets 各自隔离；通用层 + 业务层合并、**业务优先**（同名 key 业务覆盖通用）；
- remove 生效且幂等；list：vars 明文返回、secrets 只给键名；
- key 空白/空串 → 抛错；value 空串允许；
- 持久化：close 重开后 getFor 一致。

`packages/registry` 追加测试（原测试不动）：

- v1 老库升级：先以 v1 建库写数据，追加 v2 migrate 后老数据在、新列取缺省；
- create 带资料字段 → getProfile 读回一致；缺省 create → getProfile 各字段为缺省值（prompt `''`、model `'qwen3.8max'`、数组 `[]`、覆盖字段 undefined）；
- update 资料字段（prompt/model/资产绑定/quota）→ getProfile 反映；`timeout_minutes: null` → 覆盖清除；
- addMatch 带 entry_config → get 的该行读出 entry_config 对象；不带 → undefined；
- getProfile 不存在业务 → undefined。

`tests/context-loader.test.ts`（临时目录造 git 资产仓库，参考 T16 测试的造法；registry/env 用真实包 + 内存库）：

- 全链路组装：登记包（含 programs）+ 工具 + skill 集合 → create 业务（绑定三族 + prompt + quota 覆盖）→ load 返回 RunContext 各字段正确（program 绝对路径存在、skills 为绑定集合技能并集且 path 存在、quota 为业务覆盖值）；
- quota 缺省 → 取 defaults；
- 私有资产凭据：is_private + credential_key，secrets 里有同名 key → load 成功（本地 git 路径模拟）；secrets/vars 都没有 → 抛 `credential_required`；
- business_not_found / 未绑定包 / 未指定 entry_program / entry_program 名解析不到 → 各抛对应错误。

`tests/lifecycle.test.ts`（loader/runner/agentService 可结构性 stub；另做一条真实 runner 集成）：

- 四步顺序：用记录仪断言 load → serve → runner.run → close 的调用顺序与入参映射（endpoint 来自 serve 返回值、quota/config/secrets 来自 ctx、run_id 全链一致）；
- close 无条件：runner 返回 failed、runner 抛错、serve 成功但 runner 超时，三条路径 close 都被调且仅一次；
- 打标：成功路径 lifecycles 行 status=success 且 finished_at 有值；runner 返回 failed → failed；loader 抛错 → failed 且错误原样上抛；
- 真实 runner 集成：stub agentService（serve 返回假 endpoint + close 记录仪）+ 真 WorkflowRunner（fixture 程序 echo input）→ execute 返回 success、output 正确、workspace 目录按三维 + 指定 run_id 创建；
- workflow-runner 扩展：RunRequest 传 run_id → 目录按传入值派生；非法 run_id 形 → 抛错（此用例写在 packages/workflow-runner 的测试里）。

## 7. 验收标准

1. 根级六连全绿：`yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular`；
2. runtime 包运行时依赖不超出 §4 清单；`@easemob/agent-scheduler` 仅 import type（dpdm 无环）；
3. registry / workflow-runner 的扩展向后兼容：两包既有测试零改动全过；
4. 导出签名与本文 §5.2/§5.3/§5.4 一致；registry 新增面与 §5.1 一致。

## 8. 本规格的决策点

1. **ContextLoader 同步接口**：asset-registry 的 materialize/get 都是同步（内部 spawnSync git），load 跟随同步；入口循环 drain 内调用无并发问题（同通道串行、跨通道各自组装）。
2. **registry 层不做强必填校验**：包绑定/总纲/入口程序的必填是控制台业务流程的规则（fail-fast 在配置期）；registry 只做机械存储，runtime 的 `invalid_business` 是兜底防线。两层各管一段，不把业务规则渗进存储层。
3. **入口配置 entry_config 挂匹配行、平台不解析**：入口配置本质是「来源 × 事件类型」维度的（同业务的 webhook 入口与 jira 入口配置形状不同），且消费方是入口适配层而非 runtime——registry 只存取透传（JSON object），不在本版定 schema。
4. **ContextLoader 不碰 ChannelStore**：core-modules §2 的依赖清单里有它，但 T11 落地后会话映射由 agent-service 经注入的 mapping 自持（serve 内部 getAgentSession/bindAgentSession），ContextLoader 无需经手——以真实代码形状为准，少一层传递。
5. **lifecycle_id 即 run_id**：二者一一对应（一次执行 = 一个 run 目录 = 一条打标），合并为一个标识少一个概念；前缀取 `run_`（runner 目录名的既有形态）。created 是瞬时态，插入即 running。
6. **secrets 明文存 platform.db（第一版）**：platform.db 属「状态」类文件，部署层靠文件权限保护；加密存储引入密钥管理问题（加密密钥 itself 放哪），超出第一版边界。纪律不变的是：不明文回显（list 只给键名）、不进日志、运行时只经 stdin 注入。
7. **ExecutionResult.usage 暂不填**：tokens 计量在 agent-service 的审计落盘里（请求体），回传链路（pi 输出解析 → socket 响应 → 聚合）本版不做；duration 已有 runner reason 尾部埋点与日志。usage 字段保留空缺，将来补采集链路时回填。
8. **全局配额默认值走工厂参数而非 ConfigStore**：ConfigStore 未实现；工厂参数注入与依赖四类归宿一致（上下文注入），将来装配根从 ConfigStore/环境变量读后传入，本包零改动。
