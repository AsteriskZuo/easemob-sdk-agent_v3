# 共享 Run 执行核与代码同构改造 Spec

> 日期：2026-11-06
> 状态：已实施
> 范围：先完成平台与未来本地运行共用的单次 run 执行核；本 spec 不实现完整本地独立运行。

## 1. 背景与目标

业务包需要支持两种运行模式：

- **平台运行**：平台从业务注册、资产绑定和数据库配置装配上下文，并负责队列、通道、状态与结果扇出。
- **本地运行**：开发者从样例输入、本地资产和本地模型配置装配上下文，直接查看结果、日志与错误。

两种模式必须使用同一份业务代码和同一个核心执行链。差异只能位于上下文来源与最外层适配，不允许出现 `main.local.ts`、`if (local)` 或另一套模型调用路径。

当前 `packages/runtime/src/lifecycle.ts` 同时负责：

1. 平台任务与生命周期状态；
2. run 标识和平台目录布局；
3. `ContextLoader → AgentService.serve → WorkflowRunner.run → close`；
4. scheduler 的 `EntryDriver` 结果适配。

如果未来本地工具复制第 3 项，平台与本地的执行行为必然逐渐漂移。因此先抽取共享执行核，再实现本地运行。

### 本期目标

- 新增一个无数据库、无注册表、无调度器依赖的共享 `run-core` 包。
- 将已经装配好的 `RunContext` 作为执行核输入；执行核不决定上下文来自平台还是本地。
- 平台 `Lifecycle` 改为调用共享 `executeRun`，保持现有行为不变。
- 用测试固化 serve、runner、close 的顺序、参数映射和失败语义。
- 为后续本地运行工具保留可直接复用的包边界，但本期不交付本地 CLI。

### 非目标

本期不实现或修改：

- 本地运行命令、样例输入格式和控制台手动触发；
- 本地 `path` 或共享 `git` 资产来源；
- 平台资产注册、绑定、共享权限与版本治理；
- 本地模型配置格式、密钥配置格式及其对外发布；
- npm 包发布；
- SDK 的 `run/agent` 调用方式；
- 队列、通道串行、事件派生、出口投递与恢复机制；
- 现有超时、日志、重试、保留策略和 close 失败行为。

## 2. 当前代码事实

### 2.1 现有执行顺序

`packages/runtime/src/lifecycle.ts` 当前执行：

```text
task + watcher
→ 计算 business_id/channel_id
→ 生成一次 run_id
→ lifecycle 标记 running
→ 派生并创建 workspace/session_dir/audit 目录
→ ContextLoader.load
→ AgentService.serve
→ WorkflowRunner.run
→ finally: RunningAgentService.close
→ lifecycle 标记终态
→ 返回 scheduler ExecutionResult
```

`run_id` 同时用于 lifecycle 行、workspace、AgentService 和 WorkflowRunner，不能在不同阶段分别生成。

### 2.2 当前上下文

`packages/runtime/src/context-loader.ts` 的 `RunContext` 已包含核心执行所需全部业务运行信息：

- 主程序与全部工具程序映射；
- prompt 与 skills；
- 默认模型与可选 `pi_agent_dir`；
- vars、secrets 与配额；
- business_id 与 channel_id。

它适合成为共享执行核的输入。平台 `ContextLoader` 依赖 `BusinessRegistry`、`AssetRegistry` 和 `EnvProvider`，这些平台装配依赖不能进入共享核。

### 2.3 当前包边界

- `agent-runtime` 依赖 database、registry、scheduler、asset-registry，不适合作为未来独立业务开发工具的直接依赖。
- `agent-service` 与 `agent-workflow-runner` 本身不依赖平台数据库。
- 上述运行包目前均为 private；本期只建立正确源码边界，不把“已抽包”误称为“已可 npm 安装”。

## 3. 架构决策

### 决策 1：新增 `@asteriskzuo/agent-run-core`

新包目录：

```text
packages/run-core/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── context.ts
│   └── execute-run.ts
└── tests/
    └── execute-run.test.ts
```

选择新包而不是放入 `runtime` 的原因：

- `runtime` 继续负责平台生命周期与注册表装配；
- 未来本地工具可以依赖 `run-core`，无需带入 database、registry 和 scheduler；
- 依赖方向可以直接通过 package.json 和测试检查，不靠开发者自律。

新包本期仍为 `private: true`。后续本地工具需要对外分发时，再统一确定 `run-core` 及其运行依赖的发布策略。

### 决策 2：执行核接收 `RunContext`，不接收 `ContextLoader`

两条供给路径为：

```text
平台：BusinessRegistry/AssetRegistry/EnvProvider
      → ContextLoader.load ────────┐
                                   ├→ RunContext → executeRun
本地：本地资产与配置文件            │
      → LocalContextLoader（后续） ─┘
```

执行核不知道数据库、本地文件、资产 URL 或平台绑定。这样后续增加本地 `path`、共享 `git` 资产来源时，不需要修改执行核和业务 SDK。

### 决策 3：平台策略留在 Lifecycle

以下内容继续由 `packages/runtime/src/lifecycle.ts` 负责：

- `EntryDriver` 适配；
- 从 task/watcher 获取事件和业务；
- `buildBusinessChannelId`；
- 只生成一次 `run_id`；
- 平台 workspace、session、audit 路径派生与目录创建；
- lifecycle 数据库状态；
- 平台模块日志；
- `RunOutcome → ExecutionResult` 映射。

共享核不依赖 `node:fs`、`node:path`、全局 logger 或数据库。调用方必须在调用前创建 workspace、session_dir 和 audit 父目录。

### 决策 4：本期只做行为保持型重构

不顺手修复现有生命周期问题。尤其 close 失败时：

- runner 已返回 outcome、close 随后失败：close 错误上抛，平台当前不会继续写正常终态；
- runner 与 close 均失败：runner 错误钩子先执行，finally 中 close 错误按当前 JavaScript 控制流覆盖 runner 原错。

这些行为需要用特征测试记录，以防重构无意改变；它们不是本期认可并重新设计的理想语义。后续若要修改，必须另立行为变更 spec。

## 4. 包依赖与类型归属

### 4.1 新包依赖

`@asteriskzuo/agent-run-core` 仅允许具有以下运行依赖：

```text
@asteriskzuo/agent-contracts
@asteriskzuo/agent-service
@asteriskzuo/agent-workflow-runner
```

禁止依赖：

```text
@asteriskzuo/agent-database
@asteriskzuo/agent-registry
@asteriskzuo/agent-scheduler
@asteriskzuo/agent-asset-registry
app/server
```

依赖方向：

```text
agent-run-core → agent-service / agent-workflow-runner / agent-contracts
agent-runtime  → agent-run-core
app/server     → agent-runtime
```

不得形成反向依赖或循环依赖。

### 4.2 RunContext 移动

将 `RunContext` 的权威定义移动到 `packages/run-core/src/context.ts`。

`packages/runtime/src/context-loader.ts` 改为从 `agent-run-core` 导入，并继续 re-export 该类型，避免本期无意义地修改所有既有类型引用。`ContextLoader` 接口本身仍归 runtime。

## 5. 共享契约

以下类型是本期的完整包间契约。实现时不得擅自增加平台状态、队列任务或本地资产字段。

### 5.1 RunContext

```ts
import type { SkillRef } from "@asteriskzuo/agent-service";

export interface RunContext {
  /** 当前业务标识；由上下文装配方提供，并传给 WorkflowRunner。 */
  business_id: string;

  /** 业务通道标识；AgentService 用作会话映射键。 */
  channel_id: string;

  /** 主业务程序入口 JS 的绝对路径。 */
  program: string;

  /** 程序名到可执行 JS 绝对路径的完整映射，含 main、check 与工具。 */
  programs: Record<string, string>;

  /** 业务提示词总纲；允许空字符串，由 AgentService 原样消费。 */
  prompt: string;

  /** 当前 run 可使用的 skill 白名单，路径由装配方完成解析。 */
  skills: SkillRef[];

  /** 默认模型 provider/id；空字符串表示未配置模型。 */
  model: string;

  /** 含生效 models.json 的 Pi 配置目录；undefined 表示未配置模型。 */
  pi_agent_dir?: string;

  /** 注入业务进程的非机密配置。 */
  vars: Record<string, string>;

  /** 注入业务进程的机密配置；执行核不得记录其值。 */
  secrets: Record<string, string>;

  /** main 超时分钟数与每 run agent 调用上限。 */
  quota: { timeout_minutes: number; max_agent_calls: number };
}
```

### 5.2 ExecuteRunRequest

```ts
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";

export interface ExecuteRunRequest {
  /** 已装配完成的运行上下文；执行核不再查询注册表或本地资产。 */
  context: RunContext;

  /** 已校验的完整业务事件；原样传给 WorkflowRunner。 */
  event: EventEnvelope;

  /** 调用方生成的 run_ + 26 位 ULID；同一次执行不得重新生成。 */
  run_id: string;

  /** 已创建的 run 工作目录绝对路径，同时供 Pi 与业务进程使用。 */
  workspace: string;

  /** 已创建的通道级 Agent 会话目录绝对路径。 */
  session_dir: string;

  /** run 级模型请求审计文件绝对路径；父目录由调用方创建。 */
  audit_log_path: string;
}
```

### 5.3 ExecuteRunDeps

```ts
import type { AgentService } from "@asteriskzuo/agent-service";
import type { WorkflowRunner } from "@asteriskzuo/agent-workflow-runner";

export interface ExecuteRunDeps {
  /** 每 run 启动并关闭 per-run socket 服务。 */
  agentService: AgentService;

  /** 执行 check-input → main → check-output 的共享 WorkflowRunner。 */
  runner: WorkflowRunner;
}
```

### 5.4 ExecuteRunHooks

```ts
export interface ExecuteRunHooks {
  /** serve 失败时同步调用；用于平台状态与日志，不替代原错误上抛。 */
  onServeError?(error: unknown): void;

  /** runner 抛错时、close 前同步调用；业务 failed/timeout 返回值不触发。 */
  onRunnerError?(error: unknown): void;
}
```

hook 是平台适配点，不用于重试、吞错或转换错误。hook 自身抛错不在核心中捕获，属于调用方内部错误。

### 5.5 executeRun

```ts
import type { RunOutcome } from "@asteriskzuo/agent-workflow-runner";

export function executeRun(
  request: ExecuteRunRequest,
  deps: ExecuteRunDeps,
  hooks?: ExecuteRunHooks,
): Promise<RunOutcome>;
```

返回完整 `RunOutcome`，不得提前压缩成 scheduler 的 `ExecutionResult`，否则平台会丢失 `reason` 和 `failed_at`。

`packages/run-core/src/index.ts` 导出上述公共类型与函数，不导出其他平台策略。

## 6. 执行行为契约

### 6.1 serve

执行核首先调用：

```ts
const handle = await deps.agentService.serve({
  run_id: request.run_id,
  channel_id: request.context.channel_id,
  workspace: request.workspace,
  prompt: request.context.prompt,
  skills: request.context.skills,
  model: request.context.model,
  session_dir: request.session_dir,
  audit_log_path: request.audit_log_path,
  quota: { max_agent_calls: request.context.quota.max_agent_calls },
  ...(request.context.pi_agent_dir !== undefined
    ? { pi_agent_dir: request.context.pi_agent_dir }
    : {}),
});
```

serve 失败时：

1. 调用 `onServeError`（若提供）；
2. 原样上抛错误；
3. 不调用 runner；
4. 不调用 close，因为尚未获得有效 handle。

### 6.2 runner

serve 成功后调用：

```ts
deps.runner.run({
  program: request.context.program,
  programs: request.context.programs,
  event: request.event,
  business_id: request.context.business_id,
  config: request.context.vars,
  secrets: request.context.secrets,
  endpoint: handle.endpoint,
  quota: { timeout_minutes: request.context.quota.timeout_minutes },
  run_id: request.run_id,
});
```

必须保持：

- event 原对象透传；
- `run_id` 始终显式传入；
- `pi_agent_dir` 仅传给 serve，不进入 Runner 请求；
- `max_agent_calls` 仅传给 serve，不进入 Runner 配额；
- secrets 只进入 Runner 请求，不写核心日志。

### 6.3 close 与结果

控制流保持：

```text
try
  → await runner.run
catch
  → onRunnerError
  → 原样抛出
finally
  → await handle.close
→ return RunOutcome
```

要求：

- serve 成功后，close 恰好等待一次；
- runner 返回 success/failed/timeout 或抛错时都执行 close；
- 业务 failed/timeout 是正常返回值，不触发 `onRunnerError`；
- runner 抛错时，`onRunnerError` 先于 close；
- 不重试 serve、runner 或 close；
- 不吞掉或包装 close 错误；
- close 完成后才返回完整 outcome。

## 7. 平台 Lifecycle 改造

`createLifecycle` 保留现有外层流程，仅替换执行部分：

1. 计算 business_id/channel_id/run_id，创建平台 logger；
2. `markRunning` 并记录 run 开始；
3. 派生路径并创建目录；
4. 调用 `ContextLoader.load` 获得 `RunContext`；
5. 调用共享 `executeRun`；
6. 正常返回后 `markTerminal` 并记录终态；
7. 返回 `{ status, output }`。

目录创建、load 和 serve 失败共用现有“上下文组装或 serve 失败”打标与日志：

- 目录创建/load 仍由 Lifecycle 的 setup catch 处理；
- serve 失败通过 `onServeError` 接入同一处理函数。

runner 抛错通过 `onRunnerError` 保留现有“runner 平台错误”打标与日志，且该处理必须发生在 close 前。

`await executeRun` 外不得再增加统一 catch，否则会改变 close 失败的现有状态语义。

## 8. 对未来本地运行的约束

本期不实现本地工具，但后续设计和实现必须遵守：

1. 本地装配器输出同一个 `RunContext`，直接调用同一个 `executeRun`。
2. 本地工具依赖 `agent-run-core`，不得依赖 `agent-runtime`、app/server 或 platform.db。
3. 本地目录策略、样例输入和配置来源可以不同，但 serve、WorkflowRunner、close 不得复制。
4. 业务继续使用 `sdk.run("工具名")` 与 `sdk.agent({ skills: [...] })`；不增加强制 `get_tool/get_skill` 前置调用。
5. 第一期本地资产只实现显式 `path` 来源；后续共享资产增加 `git` 来源，不能改变 `RunContext` 与业务代码。
6. 本地模型配置、path 资产校验和 CLI 发布边界需在下一阶段基于本 spec 另行收敛，不能藏在本次重构中顺带决定。

## 9. 测试要求

### 9.1 run-core 单元测试

`packages/run-core/tests/execute-run.test.ts` 至少覆盖：

1. 正常顺序为 `serve → runner → close`，返回完整 outcome；
2. serve 参数完整映射，含 quota、session、audit；
3. `pi_agent_dir` 有值时透传，undefined 时字段不存在；
4. Runner 参数完整映射，event 与 run_id 不变；
5. serve 失败触发 `onServeError`，不执行 runner/close，原错误上抛；
6. runner 返回 success/failed/timeout 均 close 一次，不触发错误 hook；
7. runner 抛错顺序为 `onRunnerError → close`，close 成功时原错误上抛；
8. runner 返回后 close 失败时错误上抛，不触发两个错误 hook；
9. runner 与 close 均失败时记录当前错误覆盖行为；
10. secrets 不出现在核心添加的任何错误文本中。

### 9.2 runtime 回归测试

保留并运行现有 `packages/runtime/tests/lifecycle.test.ts`，必要时补充：

- lifecycle 行仍使用同一个 run_id；
- workspace/session/audit 路径与改造前一致；
- load、serve、runner 失败的平台状态不变；
- success/failed/timeout 的 `failed_at` 与终态映射不变；
- scheduler 返回值仍只有 status/output，不新增 usage 或 reason。

### 9.3 平台集成与静态检查

至少完成：

- `agent-run-core` build、typecheck、test；
- `agent-runtime` build、typecheck、test；
- server 相关集成测试；
- 全仓 TypeScript、循环依赖与 ESLint 检查；
- 检查 run-core package.json，确认没有数据库、注册表和调度器依赖。

## 10. 验收标准

本期全部满足才算完成：

- [x] 新 `agent-run-core` 包存在，且不依赖数据库、注册表、资产注册表、scheduler 或 app/server。
- [x] `RunContext` 的权威定义位于 run-core。
- [x] 平台 Lifecycle 已调用共享 `executeRun`，不再自行复制 serve/runner/close 编排。
- [x] 平台路径、状态、日志和 scheduler 映射保持现有行为。
- [x] run-core、runtime 与 server 相关测试通过，全仓静态检查通过。
- [x] 未修改业务包、SDK 调用方式、队列、资产、模型配置和控制台。
- [x] 未把本期成果描述为“业务包已经能够独立运行”。

## 11. 后续衔接

本期完成并验证后，下一阶段才进入最小本地闭环：

```text
样例事件 + 本地 path 资产 + 本地模型配置
→ LocalContextLoader
→ RunContext
→ 同一个 executeRun
→ 终端显示 RunOutcome、业务日志与错误
```

该阶段需要单独明确本地 CLI 的发布方式、模型配置共享位置、path 资产构建与校验规则，以及 Jira 真实业务验收数据。第二阶段共享 `git` 资产只扩展上下文装配器，不再修改本 spec 的执行核。
