# 业务配置安全更新与自定义 Pi 配置规格

> 日期：2026-10-26（2026-10-31 修订：资产下架改为 enabled 开关、与既有物理删除并存；更新队列复用 packages/queue 通用能力并采用严格全局 FIFO）
> 状态：已确认（2026-10-31 grilling 两轮 11 项决策全部通过），作为实现依据
> 范围：agent-server 的配置更新协调、业务自定义 Pi 配置、真实验证、控制台和运行链路。本文自包含；与旧规格的冲突仅在本文被确认后由同步任务修订。

> **2026-11-01 修订（部分取代）**：`docs/specs/2026-11-01-business-multi-model-spec.md` 已确认并取代本文以下条目——
> - 第 6 条全局保留作废：全局 `AGENT_PI_MODELS`、`AGENT_PI_AGENT_DIR`、全局派生 `platform/cache/pi/agent/models.json` 与未配置业务的全局兜底全部移除，**业务级大模型配置成为唯一模型来源**；
> - 单模型同步验证改为**多 provider 多 model 异步遍历验证**（validate 返回 202 + validation_id，串行探针逐个真实调用，轮询状态，全部通过才可 confirm）；
> - 模型简写 provider 形式取消，配置结构恒定完整 models.json；provider 名禁止纯整数；
> - 默认模型不再经独立输入项，由服务端派生 = 第一个 provider 的第一个 model（随 pi.set 落库，业务资料 `model` 字段只读）；
> - 删除业务大模型配置不再要求替代模型（remove payload 仅 `{business_id}`）；
> - 新增 socket 契约 v2：`sdk.agent(..., { model })` 指定模型、`sdk.models()` 枚举集合、新错误码 `model_not_allowed`/`model_not_configured`；
> - 新增全局 HTTP 超时配置 `AGENT_HTTP_TIMEOUT_MS`。
>
> 本文其余条款（更新队列与闲时生效、脱敏、验证-确认两段式、目录与权限、pi-probe 探针、模板帮助等）继续有效。

## 1. 决策与变更关系

1. 业务配置归平台持有，业务可以选择自己的完整 Pi `models.json` 配置和 `provider/id` 模型。
2. 平台不做厂商适配，原样保留 Pi 原生字段和 `!command` 等能力；模板只负责帮助填写。
3. 自定义配置必须经过真实模型调用验证，验证成功后还需用户点击确认；验证或确认前不能写入生效配置。
4. 所有会影响业务执行的在线配置与资产变更，统一由 agent-server 内同一个 UpdateCoordinator 协调并持久化；Pi 不拥有专用更新通道。等待自然空闲期间不禁止新 run，实际应用更新时才与执行入口短时互斥。
5. 控制台不展示排队状态，只提示生效时机；管理读面返回当前生效配置，不伪装成新配置已经生效。
6. 本次保留全局 `AGENT_PI_MODELS`、全局 `pi_agent_dir` 和未配置业务时的兜底行为；未来取消全局配置另行迁移。
7. 初始化不调用大模型探针；不处理 `--max-tokens`；不新增加密；不引入候选配置体系、run 级 Pi 快照或资产内容版本系统。
8. `process-runner` 与 SDK 都按公共 npm 包边界发布，SDK 复用同一个进程实现，不保留第二套 spawn。
9. 资产下架/上架是 `AssetMeta.enabled` 开关，不是删除；既有物理删除 `remove` 保留为独立操作。更新队列复用 `packages/queue` 的通用持久化能力，单一物理队列严格全局 FIFO，队首涉及业务未空闲时后续命令不插队。

本文确认后将取代以下旧口径，其他未涉及条款保持：

- `2026-10-25-pi-managed-configuration-spec.md` 的“不支持热更新”“不把模型配置迁入 SQLite、控制台或业务两桶”仅针对全局配置继续有效；业务自定义配置按本文进入 platform.db 和控制台，但仍不进入业务两桶。
- `2026-10-05-t13-console-api-spec.md` 的“全部模型修改只能重启”改为：当前全局 models.json 仍属启动配置并重启生效，业务自定义模型按本文验证、排队、空闲生效。
- `2026-09-30-t16-asset-registry-spec.md` 的“下架即物理删除”改为：下架/上架是 enabled 开关，物理删除保留为独立的 remove 操作（本文 9.3）。
- `2026-09-28-t3-queue-spec.md` 的 queue 包边界扩展为：保持事件队列兼容的前提下抽出通用持久化 FIFO 基础，新增更新命令队列能力（本文 9.1/9.2）。
- 设计文档中的“模型凭据只由平台全局持有”改为“全局或业务配置均由平台持有，业务程序不可读”。

## 2. 范围与明确不做

### 做

- 新增可公共发布的 `process-runner`，迁移 agent-service、workflow-runner、pi-probe 和 SDK 的生产进程创建；SDK 声明公共 npm 依赖并随变更重新发布。
- 新增 `pi-probe`，由 agent-server 调用真实 Pi CLI 验证单一模型。
- 新增业务 Pi 配置存储、脱敏读取、验证、确认、删除和按业务运行目录。
- 新增唯一的 UpdateCoordinator，覆盖业务创建、资料、prompt、模型选择、agent、绑定、quota、匹配行、业务删除、全局/业务 env、业务 Pi，以及资产登记/更新/上架/下架/删除和资产缓存清理。
- 控制台提供自定义配置编辑、厂商模板、在线验证、确认保存和生效说明。

### 不做

- 不删除或重构现有全局 Pi 配置，不做初始化真实模型检查。
- 不做业务创建时的自定义 Pi 两步验证；创建仍先使用平台默认，创建后可在编辑页配置。
- UpdateCoordinator 不是全系统数据库写工具。服务端口、workspace、Pi CLI 路径和当前全局 models.json 等启动部署配置，以及账号认证、事件、lifecycle 和日志写入不纳入；当前全局 Pi 没有在线修改入口，未来若开放，必须复用同一协调器和全业务屏障，不另建更新通道。
- 业务删除只延迟 registry 删除，不扩展为工作区目录删除；全局 env 和资产缓存清理使用全业务屏障，不引入资产生版本。
- 业务创建和无引用的新资产登记通常无需等待，但仍提交同一协调器并立即应用，不保留绕过协调器的生产管理写路径；同 id 仍有在役引用的资产登记必须排队。
- 不做配置加密、资产生版本、run 级资产副本、控制台队列监控或后台更新状态页面。
- 不用格式检查代替真实模型调用；不验证候选配置中所有未选模型。
- 不让业务程序读取 `AGENT_PI_MODELS`，不把原始配置传入 Runner、SDK 或 Pi 子进程环境变量。

## 3. 术语与生效语义

- **统一更新入口**：所有运行时在线配置与资产写命令都提交给同一个 UpdateCoordinator。立即应用只是 `submit` 的一种结果，不是绕过协调器的第二条写路径。
- **当前生效配置**：ContextLoader、registry、EnvProvider 和 AssetRegistry 在此时此刻向 run 提供的值。管理 GET 默认读取此视图。
- **已接受更新**：校验和权限检查通过、已持久化到更新队列的命令。已接受不等于已生效。
- **活动执行**：从 scheduler 的执行协调入口成功登记开始，到业务 runner、AgentService.close 及 EntryDriver 收尾完成。入口匹配前、尚未进入执行协调入口的事件不算活动执行；出口重试不算活动执行。
- **自然空闲**：某业务活动执行数降为 0；全业务命令则要求所有业务活动执行数降为 0。等待更新期间，新执行仍可登记；只有应用更新时新执行才等待。
- **应用窗口**：协调器已阻止相关新执行登记，正在执行一个或一批更新命令的短窗口。窗口内不运行相关业务，因此可以替换配置和共享资产缓存。

正常路径为：保存命令 → 等受影响业务自然空闲 → 原子切换到应用窗口 → 应用更新 → 恢复执行。后续执行在 ContextLoader 时自然读取新配置，无需用户或控制台再做操作。

## 4. 数据与目录

```text
{workspace}/
├── platform/data/platform.db
│   ├── businesses.pi_models                 # 可空；平台持有的业务原生配置 JSON
│   ├── assets.enabled                       # 新增列；资产上架/下架开关，既有数据迁移为 1
│   ├── business_update_commands             # 已接受更新命令，可含明文 secret
│   └── business_update_command_businesses   # 命令与受影响业务的多对多关系
└── businesses/{business_id}/cache/pi/
    ├── agent/models.json                    # 当前业务配置的派生缓存
    └── validations/{validation_id}/agent/   # 一次在线验证的短期目录
        └── models.json
```

规则：

1. 原始业务配置和已确认更新命令明文存 platform.db；本阶段不加密。
2. `businesses.pi_models = NULL` 表示未配置，沿用现有全局目录；非 NULL 表示业务明确使用自定义配置。
3. 派生目录权限 0700、models.json 权限 0600，原子写入；不得进 git、日志或 API 明文回显。
4. 在线验证不是业务 run，不放 `runs/`；其产物可删除、可重建，归 cache/pi。
5. 每次 run 如存在业务配置，都从 platform.db 的当前生效值重新生成业务 agent/models.json；生成失败则该 run 失败，不能读旧文件后继续，也不能回退全局。
6. 确认、取消、被新验证取代或过期后清理对应 validations 子目录。服务重启后未确认验证失效，启动时清理 validations 残留。
7. 未确认验证只存内存和短期目录；已确认更新命令必须持久化。

## 5. 业务原生配置与模型选择

### 5.1 配置形状

编辑器提交的是 models.json 本体，不再包一层 `AGENT_PI_MODELS`：

```json
{
  "providers": {
    "example": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-completions",
      "apiKey": "replace-me",
      "models": [{ "id": "model-a" }]
    }
  }
}
```

结构检查只保证可安全交给 Pi：

1. 顶层为非数组 object，`providers` 为非空 object；provider 名非空，provider 配置为 object。
2. `baseUrl/api/apiKey` 如出现必须为字符串；`models` 如出现必须为非空数组，每项为 object 且含非空 id，同 provider 内 id 不重复。
3. 为支持 Pi 内置 provider，不强制 `baseUrl/api/apiKey/models` 全部出现。自定义 provider 缺字段能否工作由真实探针和 Pi 判定。
4. 未知顶层、provider、model 字段全部保留，平台不重建简化对象、不深合并、不自动修正。
5. 所选 model 必须是非空 `provider/id`，provider 必须存在于配置。provider 显式声明 models 时，id 必须在该数组；未声明 models 时允许使用内置目录，由探针验证。
6. 每次验证只针对本次选择的 provider/id。其他模型只做结构检查和 Pi 启动检查，不逐一产生厂商调用，不能宣称它们均已验证。
7. 全局 AGENT_PI_MODELS 的既有严格校验保持不变；业务原生校验是独立入口，避免为了业务模板改变全局契约。

### 5.2 与 BusinessProfile.model 的关系

- 自定义配置和 model 是一次不可拆分的更新：确认后在同一 registry 写操作中保存。
- 已有自定义配置时，普通 `PATCH /api/businesses/:id` 不得单独修改 model，返回 409；调用方必须重新验证并确认完整组合。
- 平台默认模式的原全局模型选择流程保留，但写入同样经过 UpdateCoordinator；不新增全局真实探针。
- 删除自定义配置时，调用方同时提供一个当前全局可选 model；应用后 pi_models=NULL，后续 run 使用全局目录。
- 已有业务配置但数据损坏、派生失败或运行失败时，只让该业务失败，禁止静默回退。

## 6. 在线验证与确认保存

### 6.1 管理 API

| 方法与路径 | 请求 | 成功响应 | 说明 |
|---|---|---|---|
| GET `/api/businesses/:id/pi-config` | 无 | 200 `{ configured, model, config? }` | 返回当前生效配置；config 为递归脱敏对象，未配置时省略 |
| POST `/api/businesses/:id/pi-config/validate` | `{ model, config }` | 200 `{ validation_id, duration_ms }` | 结构检查后执行真实探针；不回显原始配置 |
| POST `/api/businesses/:id/pi-config/confirm` | `{ validation_id }` | 已应用 200；已接受 202，body 均为 `{ accepted: true }` | 确认同一份已验证配置，形成持久化更新命令 |
| DELETE `/api/businesses/:id/pi-config` | `{ model }` | 已应用 200；已接受 202，body 均为 `{ accepted: true }` | 删除自定义配置并切回合法全局模型，经更新队列生效 |

权限与业务 env 写权限一致：业务 creator 本人或 admin。其他登录用户不能读取配置结构或发起验证。验证失败用 400 返回可修正错误；validation_id 过期、不属于该业务/操作者或已被取代用 409；平台自身进程/文件错误按 internal 处理。所有错误详情必须有界且脱敏。

DTO 约定：

```ts
export interface BusinessPiConfigView {
  /** 是否存在当前生效的业务自定义配置 */
  configured: boolean;
  /** 当前生效的 provider/id；不代表待应用命令 */
  model: string;
  /** configured=true 时存在的递归脱敏完整配置；绝不含明文敏感字段 */
  config?: Record<string, unknown>;
}

export interface ValidateBusinessPiConfigBody {
  /** 本次唯一需要真实验证的 provider/id */
  model: string;
  /** 完整 models.json 本体；整份替换，不与旧配置合并 */
  config: Record<string, unknown>;
}

export interface ValidateBusinessPiConfigResult {
  /** 一次性、短时效确认凭据；不是更新队列 id，不在控制台展示 */
  validation_id: string;
  /** 到首个真实生成事件或完整非流式响应的耗时 */
  duration_ms: number;
}

export interface ConfirmBusinessPiConfigBody {
  /** validate 返回的凭据；confirm 不接收另一份 config/model */
  validation_id: string;
}
```

### 6.2 验证状态与目录生命周期

1. 同一业务同时只保留一个有效验证。新验证开始先取消旧探针、使旧 validation_id 失效并清理旧目录。
2. 服务端将候选配置写入 validations/{validation_id}/agent/models.json，候选 cwd 也位于该验证目录，不触碰当前生效文件。
3. 验证记录只存内存，包含 validation_id、business_id、操作者 user_id、原始 config、model、过期时间和取消控制器；TTL 固定 10 分钟，不新增部署配置项。
4. 验证成功后保留短期目录和记录供确认；失败立即清理并返回错误。
5. confirm 只按 validation_id 取服务端保存的同一份 config/model，校验操作者和有效期，然后持久化更新命令；命令落库后清理验证记录与目录。
6. 验证后任何表单编辑都使前端 validation_id 失效，必须重新验证；服务重启或记录过期后也要求重新验证。
7. 原始验证记录不进入更新队列；只有用户确认后的命令持久化。

### 6.3 原生执行能力的安全说明

`!command` 等 Pi 原生能力不予过滤。它们在在线验证阶段就可能以 agent-server 所在 OS 用户权限执行，并非只在正式 run 执行。进程 env/cwd 白名单不是沙箱。控制台帮助必须明确这一点，验证和运行均使用受管子进程、显式环境、独立工作目录和进程组清理。

## 7. 复合对象脱敏

普通 vars/secrets 的现有脱敏流程不变。logger 包新增三个 Pi 专用纯函数：

```ts
/** 深拷贝输入并递归掩码敏感字段；不修改原对象，非敏感字段和数组结构保留 */
export function maskPiModelsConfig(
  config: Record<string, unknown>,
): Record<string, unknown>;

/** 收集配置中敏感字段的非空字符串真值，供日志与错误文本专用脱敏；不返回其他字段值 */
export function collectPiModelsSecrets(config: Record<string, unknown>): string[];

/** 仅在 Pi 配置链路替换敏感真值；按长度从长到短替换，空串忽略，不改变普通 logger 的短值规则 */
export function maskPiText(text: string, secrets: readonly string[]): string;
```

规则：

1. 键名大小写不敏感地识别 `apiKey/api_key/apikey`、`authorization`、`proxy-authorization`、`accessToken/access_token`、`clientSecret/client_secret`、`password`、`cookie/set-cookie`；headers 中额外识别 `api-key` 及任意以 `-api-key` 结尾的字段。
2. 命中敏感键时，无论值形状都只在展示对象中写 `******`；collect 只收集字符串真值。其他字段原样递归展示。
3. 更新采用完整对象替换。用户必须重新填写所有显示为 `******` 的敏感字段；敏感字段仍为该占位符时拒绝验证/保存，绝不把掩码当真值，也不与旧秘密合并。
4. API 只返回 maskPiModelsConfig 的结果。日志如需记录配置也只记录该结果；probe 返回的有界错误详情先经 maskPiText。
5. 运行准备时把 collect 的真值追加到平台 logger 的现有注册表；业务 Runner 不接收配置，因此不把 Pi 密钥塞入业务 sink。
6. `!command` 动态取得的秘密无法从静态配置收集。禁止记录 Pi 原始 stdout、调试环境或认证详情；错误响应优先返回结构化类别和有界、已脱敏详情。

## 8. process-runner 与 pi-probe

### 8.1 通用进程包

新增 `packages/process-runner` / `@asteriskzuo/agent-process-runner`，统一平台与 SDK 生产代码的进程创建，并作为公共 npm 包发布。公开契约：

```ts
export interface RunProcessOptions {
  /** 子进程工作目录；调用方显式指定 */
  cwd: string;
  /** exact=只使用 values；inherit=明确继承调用方进程环境。无隐式默认合并 */
  env: { mode: "exact"; values: Record<string, string> } | { mode: "inherit" };
  /** 可选 stdin 文本；提供后写入并关闭，未提供则关闭 stdin */
  stdin?: string;
  /** wall-clock 超时，毫秒；必须为正数 */
  timeout_ms: number;
  /** 外部取消；首生成事件、AgentService.close 等均通过它终止 */
  signal?: AbortSignal;
  /** SIGTERM 后的 SIGKILL 宽限；缺省 2000ms */
  kill_grace_ms?: number;
  /** stdout/stderr 各自最大保留字节；正数超限终止，缺省 1MiB；null=显式不限制，仅供既有 SDK 等兼容调用 */
  max_output_bytes?: number | null;
  /** 原始 stdout 数据块；JSONL/业务协议解析归调用方 */
  on_stdout?: (chunk: Buffer) => void;
  /** 原始 stderr 数据块；业务日志分类归调用方 */
  on_stderr?: (chunk: Buffer) => void;
}

export interface ProcessResult {
  /** 正常/异常退出码；被信号终止时为 null */
  code: number | null;
  /** 终止信号名；无信号时为 null */
  signal: string | null;
  /** 按配置上限保留的 stdout；null 上限时完整聚合，流回调不依赖聚合值 */
  stdout: string;
  /** 按配置上限保留的 stderr；错误映射只使用有界尾部 */
  stderr: string;
}

export type ProcessFailureKind =
  | "spawn_failed" // 无法创建子进程
  | "timeout" // 超过 timeout_ms 并完成终止清理
  | "aborted" // signal 主动取消；探针首内容后的自身取消由上层另行归一
  | "output_limit" // stdout 或 stderr 超过保留上限
  | "nonzero_exit"; // 子进程以非零码退出，不含已分类的终止原因
```

`runProcess(command, args, options): Promise<ProcessResult>` 使用数组参数和 shell:false；非零退出、超时、取消、输出超限和 spawn 失败以带 kind、有界 stderr 的结构化错误拒绝。POSIX 环境使用独立进程组，取消时整组 SIGTERM→SIGKILL。调用方可用 AbortController 代替持有 ChildProcess。迁移后 agent-service、workflow-runner、pi-probe 和 `@asteriskzuo/agent-sdk` 的生产进程创建都复用该包，不保留第二套 spawn、超时或终止管理，测试 fixture 不受限制。SDK 在 dependencies 中声明公共 process-runner 兼容版本并重新发布，业务包从 npm 安装 SDK 时同时获得该依赖，不使用平台私有 workspace 依赖；发布顺序为 process-runner → SDK。`sdk.run` 保持结果解析、5 秒终止宽限和既有 stdout 聚合行为，必要时显式使用 `max_output_bytes: null`，不把这一兼容选择扩散为其他调用方的默认值。

### 8.2 Pi 探针包

新增 `packages/pi-probe` / `@asteriskzuo/agent-pi-probe`：

```ts
export interface PiProbeOptions {
  /** 已由 server 解析的 Pi CLI 绝对路径 */
  pi_cli_path: string;
  /** 本次验证专用 agent 目录，含候选 models.json */
  pi_agent_dir: string;
  /** 唯一被验证的 provider/id */
  model: string;
  /** PATH/HOME 等显式基础环境；探针只追加 PI_CODING_AGENT_DIR */
  env: Record<string, string>;
  /** 验证短期工作目录，不是业务 runs 目录 */
  cwd: string;
  /** server 固定传入 15000ms；包不读取全局配置 */
  timeout_ms: number;
  /** 被新验证或关闭服务取代时取消 */
  signal?: AbortSignal;
}

export type PiProbeFailureKind =
  | "spawn_failed" // Pi CLI 无法启动
  | "timeout" // 限定时间内未观察到真实生成
  | "aborted" // 被新验证或服务关闭取消，且此前未观察到真实生成
  | "process_failed" // 非零退出或其他未分类进程失败
  | "assistant_error" // assistant error/aborted，包括退出码 0 的情况
  | "no_generation"; // 进程结束仍无真实内容，包括只有 header/session 的情况

export interface PiProbeResult {
  /** 只有观察到真实模型内容才为 true */
  ok: boolean;
  /** 总耗时，毫秒 */
  duration_ms: number;
  /** ok=false 时的机器分类；ok=true 时省略 */
  failure_kind?: PiProbeFailureKind;
  /** ok=false 时的有界详情；不写日志，调用方脱敏后再展示 */
  detail?: string;
}
```

调用形式为 `pi -p --mode json --no-session --model <provider/id> --system-prompt "Reply briefly." ping`，并关闭 skills、extensions、prompt-templates、context-files、tools；固定最小输入不包含任何业务问题或业务数据，收到首个有效内容即取消，不等待完整回答。不传业务 prompt、审计 extension 或 `--max-tokens`。

成功事件仅包括：

- `message_update.assistantMessageEvent` 为 `text_delta` 或 `thinking_delta`，且 delta 非空；
- 非流式实现中，对应 `text_end/thinking_end` 含非空内容；
- 未出现上述事件时，最终 assistant message 含实际文本/思考内容且不是 error/aborted。

收到首个成功事件立即 abort，并把由探针自身取消导致的 aborted 归一为成功。session/header、agent_start、message_start、prompt accepted、HTTP 200、空 content 和退出码 0 都不算成功。assistant error 必须失败，即使进程退出码为 0。探针不读取 DB、不保存配置、不决定兜底、不处理模板或控制台脱敏。

## 9. UpdateCoordinator

### 9.1 接缝与执行时序

协调器归 app/server 应用层；console-api 只接收注入接口并提交命令，agent-console 只发 HTTP。生产管理路径对 registry、EnvProvider 和 AssetRegistry 的生效写操作只能由协调器的应用处理器执行，Pi 与其他配置共用这一入口。scheduler 只依赖一个窄 RunGate 接口，不认识 registry、资产或 Pi。

更新队列与入口/出口队列是同类设施：持久化、状态机与崩溃恢复复用 `packages/queue` 的通用队列能力，更新命令是新建的任务对象，不复用 EventEnvelope 信封。逻辑上形成第三条持久化队列和第三个 update loop；queue 包只负责存取与恢复，闲时判断、应用屏障和命令处理器归 app/server。

RunGate 包裹“等待全局并发名额 + EntryDriver 执行 + 收尾”，而不是只包 Lifecycle：

```text
RunGate.run(business_id, fn)
  → 若全平台或本业务 applying 则等待，不提前占全局并发名额
  → 同步登记活动执行
  → fn 内先 acquire semaphore，再执行 ContextLoader/runner/close/终态收尾
  → finally 释放活动执行并触发空闲更新
```

活动计数把等待全局并发名额也保守计入，避免“已获得执行许可但尚未 loader”的窗口被更新穿过。等待 applying 时不持有 semaphore，因此不会额外挤占无关业务的并发名额。同一业务所有 source/session/channel 共用一个计数。

单业务命令：

1. submit 持久化 pending 并触发调度。
2. 若活动数大于 0，新执行仍可进入，命令等待自然空闲。
3. 命令成为全局队首、本业务活动数为 0 且没有全平台 applying 时，协调器在同一个无 await 的临界段设置本业务 applying，之后新执行等待。
4. 应用该命令；队首连续涉及同一业务时可在同一应用窗口按 seq 连续应用，避免新 run 看到中间组合。
5. 成功、失败或异常都在 finally 释放 applying、唤醒执行并推进队列。

更新队列是单一全局 FIFO：所有命令共用一个全局自增 seq，update loop 只取队首命令；队首涉及的业务未全部空闲时原地等待，有影响集合的后续命令不插队。唯一例外是空影响集合命令（business.create、无引用 asset.register）：它与任何 run 无互斥，允许越过等待中的队首立即应用，但仍不得在全平台应用窗口进行中应用。

共享资产命令：

- 影响所有当前引用该 asset_id 的业务，不按 shared 标记判断；命令落库时记录全部引用方。
- 队首为共享资产命令时，全部引用方活动数均为 0 才进入应用窗口，且只应用一次。
- 应用前重新计算引用方；新增引用方也纳入屏障判断，已移除引用方不再等待。
- 只修改业务绑定是单业务命令，不等待其他引用方。

全局 env 与 asset.cache.clear 都以 business_ids='all' 提交给同一个协调器，复用全平台活动计数和全平台 applying 标记，不另建全局更新器。全局命令成为队首后，等待期间仍允许新 run；只有全平台活动执行数归零时，才能在同一个无 await 的临界段设置全平台 applying。该标记阻止所有新执行，应用后释放并推进队列。全局 env 只修改通用两桶；缓存清理只清资产缓存，不清空 Pi 配置、业务数据或其他 cache 类别。

business.delete 排队期间仍按“自然空闲”规则等待；一旦 delete 已接受，该业务后续其他写命令返回 409；delete 应用时，同一业务排在它之后的 pending 命令全部标记 failed 不再应用。删除只影响 registry，不额外删除 businesses/{business_id} 目录。business.create 和无引用 asset.register 以空影响集合提交；协调器仍负责持久化、全平台 applying 检查和调度，因没有活动引用方而可按上文豁免规则立即应用，不是绕过统一写路径。

### 9.2 命令与持久化

提交输入与结果：

```ts
export interface SubmitUpdateCommand {
  /** 命令类型；决定应用处理器，不序列化函数 */
  kind: string;
  /** JSON 可序列化完整参数；可含 Pi/env secret，禁止进入日志 */
  payload: unknown;
  /** 空数组=创建或无引用资产；单业务为一项、共享资产为多个引用方；all=全局 env/缓存等全业务屏障 */
  business_ids: string[] | "all";
  /** 已认证操作者 user_id，仅用于审计 */
  requested_by: string;
}

export type UpdateSubmission<T> =
  | {
      /** 持久化命令 id；用于系统日志关联，控制台不展示 */
      update_id: string;
      /** 本次请求已等待应用完成 */
      outcome: "applied";
      /** 应用处理器结果；路由用它保持创建详情、资产 meta 等既有响应 */
      result: T;
    }
  | {
      /** 持久化命令 id；用于系统日志关联，控制台不展示 */
      update_id: string;
      /** 已持久化但仍被活动执行阻塞，稍后自然空闲时应用；没有应用结果 */
      outcome: "accepted";
    };

export interface UpdateCoordinator {
  /** 无受影响活动执行时等待可用应用窗口并完成；仍被活动执行阻塞时只等待持久化并返回 accepted */
  submit<T>(command: SubmitUpdateCommand): Promise<UpdateSubmission<T>>;
  /** 包裹 scheduler 执行；fn 抛错也必须在 finally 释放 */
  run<T>(business_id: string, fn: () => Promise<T>): Promise<T>;
  /** 启动循环前把 processing 恢复为 pending 并驱动队列；失败项不自动重试 */
  recover(): Promise<void>;
  /** 停止接受新调度；未应用命令保留到下次启动 */
  stop(): Promise<void>;
}
```

命令表至少包含：update_id 唯一值、全局自增 seq、kind、payload_json、pending/processing/done/failed 状态、requested_by、created_at、started_at/finished_at、脱敏错误；持久化、状态机与崩溃恢复复用 packages/queue 的通用队列能力，processing 即命令处于应用窗口。事件队列既有的 dead 死信状态保持不变，更新命令失败用 failed，两者不混用。关联表包含 update_id/business_id 联合主键，只记录受影响业务范围，不构成多个持久化分队列；全业务命令不逐行复制全部业务 id，由 business_ids='all' 的命令类型和全平台活动计数实现。payload 明文存 platform.db，不另做加密或 TTL；本版不自动清理历史命令。

命令类别：

| kind | payload 必备语义 | 屏障 |
|---|---|---|
| business.create | CreateBusinessInput + 随建 env/match；不含自定义 Pi | 空影响集合，立即应用 |
| business.patch | BusinessPatch；不得含自定义 pi_models | 单业务 |
| business.delete | business_id；只删除 registry，不删除工作区 | 单业务 |
| business.match.add/remove | source/event_type/entry_config | 单业务 |
| env.global.set/remove | bucket/key/value（set） | 全业务 |
| env.business.set/remove | bucket/key/value（set） | 单业务 |
| pi.set | 已验证完整 config + model | 单业务 |
| pi.remove | 合法全局 model | 单业务 |
| asset.update | asset_id + 提交时解析固定的 commit；credential_key 只存键名不存秘密 | 全部引用方；无引用时为空 |
| asset.enabled.set | asset_id + enabled；下架/上架开关，不改登记行、绑定与缓存 | 全部引用方；无引用时为空 |
| asset.remove | asset_id；物理删除登记行与物化缓存（既有删除语义）；提交时仍有引用方则 409，提示先解绑或下架 | 全部引用方；无引用时为空 |
| asset.register | 完整 AssetInput + 固定 commit；同 id 有在役引用时等待 | 空影响集合或全部引用方 |
| asset.cache.clear | 空对象；清资产缓存不改登记行 | 全业务 |

业务创建、资产登记和其他运行时写一样经 submit；没有活动执行只是意味着可以等待当前应用窗口结束后立即完成，不另设直写分支。资产 ref 在提交时解析成 commit，避免排队期间分支移动导致实际应用版本变化；物化在应用窗口执行，不提前改写 live 缓存。启动部署参数、账号和登录不进入本版命令类型。

资产包需提供两个只读解析口，console-api 不得通过 updateRef 或 materialize 来实现预校验：

```ts
/** 从 asset-registry 包导出；登记时按 url/ref 解析固定 commit，只读 git，不写登记行或缓存 */
export function resolveRef(
  url: string,
  ref: string,
  credential?: string,
): string;

export interface ResolvedAssetRef {
  /** 可直接交回 register/updateRef 的 40 位 commit */
  commit: string;
  /** false=与当前登记 commit 相同，无需入队或重新物化 */
  changed: boolean;
}

export interface AssetRegistry {
  /** 更新前按 asset_id 读取内部 url 并固定 commit；校验资产存在和 shared_immutable，不写 DB/缓存 */
  resolveUpdateRef(
    asset_id: string,
    ref: string,
    opts?: { credential?: string },
  ): ResolvedAssetRef;
}
```

登记命令先用 resolveRef 固定 input.ref，再用 computeAssetId 判断是否有在役引用；更新命令先调 resolveUpdateRef，changed=false 时直接幂等返回。真正应用仍调用既有 register/updateRef，传入固定 commit。私有资产命令只保存 credential_key，提交和应用时分别从当前通用安全桶解析真值，不把凭据复制进队列 payload。

能够立即应用时，路由保持现有同步成功状态码和响应体，创建详情、资产 meta 等从 applied.result 取得；只有仍被活动执行阻塞时才返回 202 `{ accepted: true }`。提交前已知错误仍按现有 400/403/404/409；立即应用失败则同步返回错误，后台应用失败只写系统日志。控制台不新增状态接口或状态展示，管理 GET 继续读取生效值。

### 9.3 资产上架/下架开关

下架不是删除。`AssetMeta` 新增 `enabled: boolean`；新登记默认 true，既有数据迁移为 true。`AssetRegistry` 新增幂等 `setEnabled(asset_id, enabled): AssetMeta`：下架即 enabled=false，上架即 enabled=true。开关不删除登记行、不改 asset_id/commit、不解除业务绑定、不清物化缓存；重新上架后既有绑定自动恢复可用。既有 `remove` 保持物理删除语义（删登记行并清缓存），与开关是两个独立管理操作，都经 UpdateCoordinator 且屏障为全部引用方。

1. ContextLoader 物化前检查业务绑定的 package/tool/skill 资产；任一 enabled=false 直接失败，错误前缀 `asset_disabled: <asset_id>`，不进入业务程序。失败沿用既有入口语义：run 标 failed、入口任务置 done 不重试、不写 lifecycles 原因列，原因从系统日志排查；业务开启 on_failure 时按既有派生事件通知。
2. 绑定配置校验只对本次新增的绑定拒绝 enabled=false 的资产；已存在的绑定保留，且不阻断业务其他字段的保存。
3. `assets.list` 增加可选 `enabled` 过滤供控制台选择器使用；管理列表默认返回全部并携带状态。
4. 重复登记已存在且 disabled 的资产不自动上架、不借登记更换 ref；共享资产不可更新规则不变。
5. 登记失败时 register 内部回滚的物理删除是私有清理，不作为管理下架或删除入口。
6. 开关的管理端点为 `PUT /api/assets/:id/status`，请求体 `{ "enabled": boolean }`，返回更新后的 AssetMeta；权限与既有 remove 一致，仅属主本人可操作。

### 9.4 失败与重启

1. 命令在提交前完成权限和可前置校验；应用处理器再次做必要的一致性检查，防止 pending 命令组合破坏注册表。
2. 单命令失败标 failed、记录脱敏错误，不自动重试；继续后续命令。新执行在释放屏障后使用仍可用的旧生效配置。
3. registry/env/Pi 更新必须保持单命令原子性。资产 updateRef 沿用既有 commit 回滚与缓存重建语义，不能把一个失败命令写成 done。
4. 服务重启时内存活动计数从 0 开始，不使用历史 lifecycles.running 作为永久阻塞依据；processing 命令恢复为 pending，failed 不恢复。
5. recover 在 entry/exit loop、入口 adapter 和 console API 启动前执行，避免重启后先按旧配置跑新任务。
6. 停止服务时未应用命令保留；不得在 stop 过程中半应用后继续开放执行。

## 10. 运行时与控制台

### 10.1 运行时

- registry 新增专用 Pi 读写方法，原始 JSON 不进入 BusinessProfile、list/getProfile、普通 BusinessPatch 或 API DTO 展开对象。
- ContextLoader 新增平台注入的 BusinessPiRuntimeResolver；存在业务配置时生成并返回 `pi_agent_dir`，不存在时返回 undefined。RunContext 只带目录，不带原始 JSON。
- AgentServeContext 增加可选 pi_agent_dir；buildPiEnv 优先 `ctx.pi_agent_dir ?? deps.pi_agent_dir`。agent 和 compact 必须一致。
- Pi 密钥不加入 Pi env，只存在 models.json；Runner stdin 的 vars/secrets/programs 等字段不包含 AGENT_PI_MODELS。
- 不引入 run 级快照：UpdateCoordinator 保证应用时无活动执行，每业务独立目录避免跨业务覆盖。

### 10.2 控制台

- 创建页使用平台默认；编辑页提供“平台默认 / 业务自定义”。
- 自定义模式显示完整 JSON 编辑器、可输入的 provider/id、在线验证按钮；全局 models 下拉不再限制自定义值。
- 只有验证成功才显示可用的确认保存；任何编辑使验证失效。掩码字段必须重新填写。
- 提供恢复平台默认操作，选择全局模型后通过 DELETE 命令生效。
- 厂商帮助使用问号打开抽屉，按千问/DeepSeek/OpenAI 分标签，提供复制模板和官方文档；不自动合并、保存或验证。
- 页面不展示 pending、update_id、进度或队列状态。统一说明：“当前有任务执行时，修改将在受影响业务空闲后自动生效，后续运行使用新配置；生效前页面显示当前生效值。”
- 资产页显示“已上架/已下架”状态列并提供上架/下架动作；删除维持既有操作与语义。下架提示：“下架后绑定该资产的业务运行时将直接失败（shared 资产可能包含其他用户的业务），重新上架后恢复；登记、绑定与缓存均保留。”
- 其他进入更新队列的业务资料、全局/业务 env 和资产编辑使用同一生效说明，不增加队列面板。

### 10.3 厂商起始模板

模板是 console 的静态帮助数据，不参与平台模型列表和运行判断。模型选择示例分别是 `dashscope/qwen-plus`、`deepseek/deepseek-flash`、`openai/gpt-5.4`。baseUrl 是 API 根，不追加 `/chat/completions` 或 `/responses`。

千问（自定义 DashScope provider，显式模型；contextWindow/maxTokens 是保守控制值，不宣称厂商上限）：

```json
{
  "providers": {
    "dashscope": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "sk-your-dashscope-key",
      "models": [
        {
          "id": "qwen-plus",
          "name": "Qwen Plus",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

DeepSeek（使用 Pi 内置 provider，不重声明 models，以保留内置元数据）：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "sk-your-deepseek-key"
    }
  }
}
```

OpenAI（使用 Pi 内置 provider，不重声明 models）：

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-responses",
      "apiKey": "sk-your-openai-key"
    }
  }
}
```

帮助链接使用官方入口：千问 `https://help.aliyun.com/zh/model-studio/`、DeepSeek `https://api-docs.deepseek.com/`、OpenAI `https://platform.openai.com/docs/api-reference`。模板只保证与当前锁定 Pi 的结构起点一致，用户仍需按账号、区域和厂商文档修改并真实验证。

## 11. 测试与验收

至少覆盖：

1. process-runner 的成功、非零、spawn 失败、超时、取消、输出上限、显式不限制输出和进程组清理；agent-service、workflow-runner 与 SDK 都复用同一实现且行为不回归，不存在第二套生产 spawn。
2. 对 process-runner 与 SDK 执行 npm pack，在隔离目录安装并运行真实 SDK 子程序，证明发布产物能解析公共 process-runner 依赖，模板验收不回归。
3. 探针首 text/thinking delta 后立即终止、只有 header 不成功、exit 0+assistant error 失败、非流式内容成功、无生成退出、超时和新验证取消。
4. 业务原生字段完整保留、内置 provider 简写、显式 models 的 model 归属、坏 JSON/类型/重复 id、掩码占位拒绝。
5. 验证失败不能确认；confirm 不能替换 config/model；过期、跨业务、跨操作者、重复确认和重启后确认均失败。
6. API、日志和错误文本无 sentinel secret；未知非敏感字段可见；普通 env 脱敏测试不回归。
7. Runner 信封无 AGENT_PI_MODELS；agent/compact 使用同一业务目录；未配置业务仍走全局；业务派生失败不 fallback。
8. 统一更新队列：所有运行时管理写入只经同一协调器；更新队列复用 packages/queue 通用能力，入口/出口事件队列既有行为不回归。创建和无引用资产立即应用且保留响应结果；忙时旧 run 继续、等待期新 run 可进入、应用窗口无竞态、多 session 计数、严格全局 FIFO（队首未空闲时后续命令不插队）、失败释放、重启恢复先于事件；业务删除只在空闲后应用。
9. 全局与共享屏障：全局 env 和 cache clear 成为队首后等待全业务空闲；两个资产引用方均活动时不更新，共同空闲后只执行一次；绑定修改只等待本业务；cache clear 不清其他 cache 类别。
10. 资产开关：enabled 迁移默认 true；setEnabled 幂等；下架后绑定业务 ContextLoader 以 asset_disabled 失败、登记/绑定/缓存保留；重新上架后恢复；绑定校验拒绝新绑定 disabled 资产；remove 仍是物理删除；登记失败回滚不产生管理记录。
11. 控制台：验证前不能确认、编辑后失效、掩码字段需重填、模板可复制、资产上架/下架动作与提示存在、无队列状态展示、统一说明文案存在。
12. 相关包与根级 build/test/typecheck/lint/format/circular 全通过；使用构建产物和假 Pi 跑通完整场景。

自动测试不得访问真实厂商。真实厂商验证需要另行取得用户明确授权和测试配置，并接受会产生真实请求与少量费用；未执行时交付报告必须明确说明。
