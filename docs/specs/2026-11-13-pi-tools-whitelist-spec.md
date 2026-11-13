# Spec：pi 内置工具白名单（业务级 opt-in）+ 工作区路径守卫

- 日期：2026-11-13
- 状态：待用户确认后实施
- 背景出处（非必读）：`docs/specs/2026-09-29-t11-agent-service-spec.md` §49 不做清单——「pi 工具白名单开放（v1 恒 `--no-tools`，后续作为业务资料字段再开）」。本 spec 即该「后续」。

## 1. 背景与问题

平台 agent-service 当前对 pi 子进程恒装配 `--no-tools`（`packages/agent-service/src/pi-runner.ts` 两处），业务包的 agent 调用是纯提示词推理，不能使用 pi 内置工具。

`sdk-log-analysis` 业务包（docs/specs/2026-11-12-sdk-log-analysis-spec.md）的 agent 需要在大模型侧读源码仓库文件（read/grep/glob）才能完成根因分析。`--no-tools` 成为该业务 e2e 的唯一平台缺口。

**已实证的安全问题**：pi 的 read/grep/glob 工具没有工作区围栏——绝对路径与 `../` 穿越均可读到工作区外文件（2026-11-13 沙箱测试，真实模型 + `--tools read` 验证，记录在 dailylog/AsteriskZuo/2026-11-13.md 07:40 条目）。因此开放工具必须同步加路径守卫。

## 2. 目标与非目标

目标：
1. 业务包可通过清单声明 opt-in 的 pi 内置工具白名单；声明后 agent/compact 装配 `--tools <名单>` 替代 `--no-tools`。
2. 开放工具时平台统一注入路径守卫 extension，阻断工作区外路径访问，fail-closed。
3. 本地运行（local-runner）与平台输出一致：同一字段、同一校验、同一装配行为。

非目标：
- 不开放 pi 的写类/执行类工具（bash/edit/write/ls/find 等一律不在 v1 枚举内）。
- 不做「业务运行中动态改工具名单」——名单是静态清单字段，改名单 = 重新登记资产。
- 不替换业务工具资产机制（`requires.tools` 是业务代码组件，与 pi 内置工具无关，本 spec 不动）。

## 3. 决策表

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| D1 | 声明位置 | `agent-package.json` 顶层新增可选字段 `pi_tools: string[]`（package 形态专属，与 `requires` 平级） | T11 钦定「业务资料字段」路线；清单随资产走，无 DB 变更。不与 `requires.tools`（业务工具资产名）混用，语义不同 |
| D2 | v1 允许枚举 | 仅 `read`、`grep`、`glob` 三个 | 日志分析最小需求；只读类、无执行面；后续扩枚举是改平台常量 + 登记校验，向后兼容 |
| D3 | 未声明的行为 | 保持现状：`--no-tools` | 既有业务（jira-ticket-review）零感知 |
| D4 | 路径守卫形态 | 平台 extension `packages/agent-service/extensions/path-guard.js`（plain JS 不经构建），经 `--no-extensions` + `-e` 白名单注入，业务不可摘除 | 与审计 extension 同款机制；pi extension API 的 `tool_call` 事件支持 `block:true` 阻断执行（types.d.ts ToolCallEventResult 已核实） |
| D5 | 守卫判定口径 | 拦 read/grep/glob 三类；逐调用检查 `event.input.path`：resolve 后必须位于 pi 子进程 cwd（= run workspace）之内；缺 path / 非字符串 / 判定异常 → 一律 block（fail-closed） | 越界读是本问题的唯一攻击面；fail-closed 与 T11 hooks 纪律①一致 |
| D6 | compact 形态 | 与 agent 同名单同纪律（`whitelistFlags(piTools)` 两形态共用） | 保持「agent / compact 命令行 flag 公共集」的既有设计 |
| D7 | 本地运行对等 | local-runner `config.json` 新增可选 `pi_tools`（同枚举校验），装载进本地 RunContext，装配链与平台同源 | 本地/平台上下文输出一致原则（项目核心原则） |

## 4. 改动清单（按包）

### 4.1 asset-registry（`packages/asset-registry/src/validate.ts`）

- `AssetManifest` package 形态新增 `pi_tools?: string[]`；tool/skill 形态出现清单顶层 `pi_tools` 字段 → `validation_failed`（防误配）。
- 校验规则：存在时必须是非空字符串数组；每项为字符串且 ∈ 平台枚举 `["read","grep","glob"]`（常量定义在本包导出，供 console-api/runtime 复用）；不满足 → `validation_failed: pi_tools ...`。
- 缺省保持 `undefined`（不归一），与 D3 对应。

### 4.2 runtime（`packages/runtime/src/context-loader.ts`）

- `load()` 组装 RunContext 时：取**包资产**清单的 `pi_tools`（工具/skill 清单无此字段），原样放入 RunContext 新字段。

### 4.3 run-core（`packages/run-core/src/context.ts`、`execute-run.ts`）

- `RunContext` 新增 `pi_tools?: string[]`：业务声明的 pi 内置工具白名单；缺省 undefined = 不开放（`--no-tools`）。
- `execute-run.ts` serve 透传：`...(context.pi_tools !== undefined ? { pi_tools: context.pi_tools } : {})`。

### 4.4 agent-service（`packages/agent-service/src/index.ts`、`pi-runner.ts`）

- `AgentServeContext` 新增 `pi_tools?: string[]`（注释：业务的 pi 内置工具白名单；undefined = `--no-tools`；非空 = `--tools` + 路径守卫 extension）。
- `whitelistFlags(piTools?: string[])`：
  - 空/undefined → 现状数组不变（含 `--no-tools`）。
  - 非空 → `--no-tools` 替换为 `--tools`, 逗号连接名单；并在审计 extension 之后追加 `-e <path-guard.js>`。其余 flag（`--no-skills`、`--no-extensions`、`--no-prompt-templates`、`--no-context-files`）不变。
- 新增 `resolvePathGuardExtensionPath()`：与 `resolveAuditExtensionPath()` 相同的向上查找逻辑，定位 `extensions/path-guard.js`，找不到抛错。
- `runAgentOp` 装配处、`pi-compact.ts` 的 `whitelistFlags()` 调用点均传入 ctx.pi_tools（D6）。

### 4.5 新增 extensions/path-guard.js

- plain JS、不经构建（pi 经 jiti 加载），默认导出 `function pathGuard(pi)`。
- `pi.on("tool_call", handler)`：
  - 仅处理 `toolName ∈ {read, grep, glob}`；其余工具直接放行（它们不在任何白名单内，正常不会出现；出现即视为异常 → block）。
  - 提取 `event.input.path`：缺失或非字符串 → `{block: true, reason: "path-guard: 缺少 path 参数"}`。
  - `resolve(process.cwd(), path)` 后做前缀判定（等于 cwd 或以 cwd + sep 开头）：越界 → `{block: true, reason: "path-guard: 路径越出工作区: <path>"}`。
  - 判定逻辑自身抛异常 → catch 后返回 `{block: true}`（fail-closed，不依赖 pi 对 handler 抛错的语义）。
- 不设开关、不读 env；业务无法摘除（由装配处 `--no-extensions` + `-e` 保证）。

### 4.6 local-runner（`packages/local-runner/src/config.ts`、`local-context-loader.ts`）

- `LocalRunConfig` 新增可选 `pi_tools: string[]`：同 4.1 枚举校验（非法值报 `配置字段 config.pi_tools 非法：...`）；缺省 undefined。
- 本地上下文装载把 `pi_tools` 放进本地 RunContext，装配链与平台同源（local-runner 复用 agent-service serve），无需额外装配改动。

### 4.7 不需要改动的部分（明确排除）

- **console-api / 数据库**：pi_tools 是清单内字段，登记时经 asset-registry 校验；绑定校验无对应物（不像 requires.tools 需要绑定工具资产），无表结构变更、无迁移。
- **jira-ticket-review 业务仓**：零改动、零配置——不声明 pi_tools 即维持 `--no-tools`，行为与今天完全一致。
- **sdk-log-analysis 业务仓**：仅 `agent-package.json` 加一行 `"pi_tools": ["read","grep","glob"]`，无代码改动。
- **socket 契约**：业务进程经 SDK 调用 agent op 的请求/响应形状不变；pi_tools 是装配层字段，业务不可见。

## 5. 测试要求

- asset-registry：pi_tools 合法/非法（非数组、空数组、非字符串项、枚举外值、tool 形态误配）用例。
- runtime：context-loader 把包清单 pi_tools 放进 RunContext；未声明时字段缺省。
- run-core：execute-run serve 透传 pi_tools。
- agent-service：
  - 未声明 → args 含 `--no-tools`、不含 `--tools`/path-guard（现状保持）。
  - 声明 → args 含 `--tools read,grep,glob`、含 `-e <path-guard.js>`、不含 `--no-tools`；agent/compact 两形态。
  - path-guard.js 单测：直接驱动 handler 模拟 tool_call 事件——workspace 内相对/绝对路径放行，越界绝对路径、`../` 穿越、缺 path 均 block；handler 内部异常 block。
- local-runner：config pi_tools 校验用例（合法装载 + 非法报错）。
- 回归：全仓测试保持绿色（改动全部 additive，既有行为不变）。

## 6. 影响与兼容性

- 对既有业务：jira-ticket-review 零影响（D3）；其 local-run config 无需加字段。
- 对 sdk-log-analysis：解除 e2e 唯一平台缺口，T4 收尾解锁。
- 向后兼容：所有新字段可选；命令行仅在声明名单后变化；无 DB 迁移。
- 风险：path-guard 误判会 block 合法调用——判定口径保守（只查 input.path 单一字段），且 block 原因会回给模型使其改试工作区内路径，属可恢复失败。

## 7. 验收标准

1. 全仓构建 + 测试通过（含新增用例）。
2. 审查工单业务的既有 local-run / 平台 run 行为不变（它的测试全绿即为证据）。
3. sdk-log-analysis 打桩 e2e 在平台改动后跑通（agent 步不再因 `--no-tools` 失败）。
4. 沙箱复测：`--tools read,grep,glob` + path-guard 下，读工作区外文件被 block，读工作区内文件成功。
