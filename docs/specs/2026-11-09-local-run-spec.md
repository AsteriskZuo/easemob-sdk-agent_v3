# 业务包本地运行（第一期：最小本地闭环）Spec

> 日期：2026-11-09
> 状态：已实施（2026-11-09，实施计划 docs/plans/2026-11-09-local-run-plan.md）
> 范围：本地装配器 + 配置文件 + 回放文件 + 上下文等值 diff + 本地 CLI；不做 npm 发布与二期共享资产。
> 前置：`docs/specs/2026-11-06-shared-run-execution-spec.md`（已实施），本 spec 的本地运行必须复用其 `executeRun` 与 `RunContext` 契约。

## 1. 背景与目标

业务包需要支持本地独立运行，目标场景是**复现平台某次真实执行**：把平台出问题（或待验证）的那次 run 搬到本地，用同一份业务代码、同一个执行核跑出可对照的结果，用于快速、低风险调试。

核心思路（已与需求方对齐）：

- **LocalContextLoader 是「复现器」**：输入 = 本地配置文件 + 回放事件文件，输出 = 与平台某次 run **结构一致且值等值**的 `RunContext`。
- **等值可机器判定**：提供上下文 diff 工具，比较平台生成的上下文与本地生成的上下文；diff 通过即证明本地装载无问题，剩余问题只可能来自执行环境或副作用，排查方向收敛。
- **不管下游**：本地运行不涉及队列、通道串行、状态机、结果扇出与出口投递适配，只保证执行输出符合契约（`RunOutcome`）。
- **业务包零适配**：业务代码继续只用 `sdk.run` / `sdk.agent`，不感知上下文来源。

### 本期目标

1. 本地配置文件契约（业务资料、vars/secrets、path 资产、模型配置的本地等价物）。
2. 回放事件文件契约与导出方式（从平台数据库导出真实事件信封）。
3. `LocalContextLoader`：配置文件 + 回放文件 → `RunContext`，装配语义与平台 `ContextLoader` 逐条对齐。
4. 上下文等值 diff 工具：规范化后比较平台上下文与本地上下文。
5. 本地 CLI：`装配 → executeRun → 终端输出 RunOutcome/日志/错误`。
6. 出口副作用护栏：本地回放时防止出口工具真实外发。

### 非目标

本期不实现或修改：

- npm 包发布与对外分发（所有相关包维持 `private: true`）；
- 共享资产的 `git` 来源（二期，只扩展装配器）；
- 平台侧任何行为：队列、通道、调度、状态机、结果扇出、出口投递、控制台；
- 业务包代码、SDK 调用方式、run-core 执行核；
- 控制台手动触发本地运行；
- 平台模型配置（`AGENT_PI_MODELS`、业务自定义 Pi 配置）的管理面改造。

## 2. 当前代码事实（已核实）

### 2.1 平台装配逻辑

`packages/runtime/src/context-loader.ts` 的 `ContextLoader.load(business_id, channel_id)` 按以下顺序装配（行号为 2026-11-09 核实值）：

1. `registry.getProfile(business_id)` 取业务资料：`prompt`、`model`、`entry_program`、`package_asset_id`、`tool_asset_ids`、`skill_asset_ids`、`timeout_minutes?`、`max_agent_calls?`；不存在抛 `business_not_found`（context-loader.ts:41-44）。
2. `env.getFor(business_id)` 取 vars/secrets 两桶（context-loader.ts:47）。
3. 资产物化：包在前、工具随后、skill 最后；私有资产凭据按 `credential_key` 从两桶取值（secrets 优先、vars 兜底）；任一绑定资产已下架抛 `asset_disabled`（context-loader.ts:66-81）。
4. 名解析：`entry_program` 经 `resolveResource` 解析出主程序绝对路径；`programs` = 全部资产 programs 的并集（名→物化绝对路径，同名按资产顺序首个命中）；`skills` = 绑定 skill 资产技能并集（同名首个命中去重）（context-loader.ts:96-124）。
5. `piResolver.resolvePiAgentDir(business_id)` 每次 run 原子生成业务派生 Pi 目录；未配置返回 `undefined`（context-loader.ts:128）。
6. `quota` = 业务覆盖值 ?? 全局默认（装配根注入 `task_timeout_minutes` / `max_agent_calls`）（context-loader.ts:140-145）。

### 2.2 回放事件来源

- 平台数据库 `entry_tasks` 表 `event` 列存**完整事件信封 JSON**（`packages/queue/src/task-queue.ts:87-97` 建表，`:106-113` 落库前过 `validateEnvelope`）。导出 SQL：`SELECT event FROM entry_tasks WHERE event_id = '<event_id>';`
- 信封契约见 `packages/contracts/src/envelope.ts`：`contract_version` 恒 `"v1"`，`source` 枚举 `wecom|jira|github|webhook|cron|internal|manual`，必填 `event_id/event_type/timestamp/session_id/correlation_id/hop_count/payload`。
- 业务 run 日志开头有一行「临时调试：平台实际调用 Runner 的 RunRequest」（已核实，平台写入、字段含 program/programs/event/config/secrets 脱敏值/quota）。它是临时调试输出而非稳定契约，且缺 serve 侧字段（prompt/skills/model/pi_agent_dir），**不作为**回放或 diff 来源（约束见 §3 决策 4）。
- 注意数据保留策略：`done` 任务会被 `purge` 清理，`dead` 不删（task-queue.ts:212-225）——可回放窗口受平台保留策略约束，导出应及时。

### 2.3 执行核与构造依赖

- `executeRun(request, deps, hooks?)` 已就位（`packages/run-core/src/execute-run.ts`），`RunContext` 权威定义在 `packages/run-core/src/context.ts`。
- `deps` 需要 `AgentService` 与 `WorkflowRunner` 实例，平台构造方式见 `app/server/src/bootstrap.ts`：`createAgentService`（依赖 `pi_cli_path`、`pi_env` 等）、`createWorkflowRunner({ workspaceRoot })`。本地 CLI 装配根需要自行提供这些构造参数。
- `executeRun` 要求调用方先生成 `run_id`（`run_` + 26 位 ULID）并创建 `workspace`、`session_dir` 与 audit 父目录；本地目录策略由本 spec 定义（§6.3）。

### 2.4 业务包事实

- 包清单 `agent-package.json`：`programs`（名→相对 dist 产物路径）、`requires.tools/skills`；程序入口必须是 `.js` 产物（`packages/asset-registry/src/validate.ts:44-65`）。
- 资产三种 kind：`package | tool | skill`；skill 资产清单含 `skills: string[]` 技能名列表。

## 3. 架构决策（已定）

### 决策 1：新增 private 包 `@asteriskzuo/agent-local-runner`

目录：

```text
packages/local-runner/
├── package.json          # private: true，本期不发布
├── tsconfig.json
├── src/
│   ├── index.ts          # 公共导出
│   ├── config.ts         # 本地配置文件加载与校验（§4）
│   ├── replay.ts         # 回放事件文件加载与校验（§5）
│   ├── local-context-loader.ts  # RunContext 装配（§6）
│   ├── context-diff.ts   # 上下文等值 diff（§7）
│   └── cli.ts            # 命令入口（§8）
└── tests/
    └── ...
```

允许的运行依赖：

```text
@asteriskzuo/agent-contracts
@asteriskzuo/agent-run-core
@asteriskzuo/agent-service
@asteriskzuo/agent-workflow-runner
@asteriskzuo/agent-logger   # 实施期补充：agent-service 的 serve 使用 logger 全局外观，
                            # 本地 CLI 装配根必须 initLogger（对齐平台 bootstrap）；叶子包，无平台耦合
```

禁止依赖（与 run-core 同纪律，用 package.json + 测试检查）：

```text
@asteriskzuo/agent-database
@asteriskzuo/agent-registry
@asteriskzuo/agent-scheduler
@asteriskzuo/agent-asset-registry
app/server
```

### 决策 2：业务代码零改动

本地运行不新增 SDK API、不要求业务包增加任何文件。配置文件与回放文件由开发者维护在业务仓内（建议 `.local-run/` 目录并加入 `.gitignore`），业务构建产物（`dist/`）即 path 资产来源。

### 决策 3：diff 是验收工具，不是执行前置

上下文 diff 用于**判定装载正确性**，独立成子命令（§8），不作为 `run` 的强制前置——开发迭代时允许在 diff 有告警的情况下继续执行。

### 决策 4：输入来源统一性约束（业务无关）

本地运行的**全部**输入只允许来自三类平台层统一产出，严禁依赖任何业务自己的输出：

1. **平台数据库** `platform.db`：回放事件（`entry_tasks.event`，信封契约统一，与业务无关）；
2. **平台上下文快照**（本期新增，§7.1）：由 Lifecycle 在 `load` 成功后落盘，内容就是 `RunContext`——它本身就是业务无关的执行契约，快照因此天然业务无关；
3. **开发者维护的本地配置文件**（§4）：平台注册表/env 的本地等价物。

明确禁止的输入来源：

- `businesses/{id}/logs/**` 下的业务日志——那是业务经 `sdk.log` 的自有输出，格式随业务而变；若从它解析装载输入，每接一个业务就要重写一次装载器，不可接受；
- `businesses/{id}/data/**` 下的业务持久数据——属业务内部状态；
- 业务 run 日志开头的「临时调试：平台实际调用 Runner 的 RunRequest」行——虽是平台写入，但它是临时调试输出而非稳定契约，且只有 Runner 入参视角（缺 prompt/skills/model/pi_agent_dir），**diff 与回放均不依赖它**；该行的去留不在本期范围。

凡「本地运行需要某个新输入」，先问它能否归入上述三类平台统一产出；归入不了的，先回平台层补统一产出（改造或新增日志），而不是在装载器里开业务分支。

## 4. 本地配置文件契约

文件名建议 `.local-run/config.json`，路径可用 CLI 参数覆盖。完整形状：

```jsonc
{
  // 业务资料（对应平台 BusinessProfile）
  "business_id": "jira-ticket-review",
  "channel_id": "jira:HIM-12345",        // 回放时建议与平台 run 一致（影响会话映射键）
  "prompt": "……业务提示词总纲……",
  "entry_program": "main",
  "model": "qwen/qwen3.8-max",

  // path 资产：名 → 本地绝对/相对路径（相对 = 相对配置文件所在目录）
  // 顺序即名解析优先级，与平台「包在前、工具随后、skill 最后」对齐
  "assets": {
    "package": { "path": "." },           // 业务仓根，内含 agent-package.json 与 dist/
    "tools": [{ "name": "wecom-notify", "path": "../shared-tools/wecom-notify" }],
    "skills": [{ "name": "review-guide", "path": "../shared-skills/review-guide" }]
  },

  // 两桶配置（对应平台 env.getFor）；secrets 只在本地，严禁提交 git
  "vars": { "JIRA_PROJECT": "HIM" },
  "secrets": { "JIRA_PASSWORD": "……", "WECOM_WEBHOOK": "……" },

  // 模型配置：含生效 models.json 的目录（对应平台 pi_agent_dir 派生目录）
  // 可直接引用平台派生产物 businesses/{id}/cache/pi/agent，或本地手写目录
  "pi_agent_dir": "./.local-run/pi/agent",
  // AgentService/WorkflowRunner 构造参数（对应 app/server 装配根）
  "pi_cli_path": null,                     // null = 缺省解析（同平台缺省行为）
  "pi_env": {},                            // 传给 pi 子进程的环境覆盖

  // 配额（对应平台业务覆盖 ?? 全局默认的最终生效值）
  "quota": { "timeout_minutes": 30, "max_agent_calls": 50 },

  // 本地运行根目录（§6.3；可选，缺省 = 配置文件所在目录的 workspace/）
  "workspace_root": "./.local-run/workspace",

  // 出口护栏（§9）：被 stub 的工具不真实执行；stub_outputs 配置各替身的固定输出（未配置默认 {}）
  "stub_tools": ["wecom-notify"],
  "stub_outputs": { "wecom-notify": { "delivered": true } }
}
```

校验规则（fail-fast，装载前完成）：

- 必填：`business_id`、`channel_id`、`entry_program`、`model`、`assets.package`、`quota`；
- `assets.*.path` 必须存在且为目录；package 资产必须能读到 `agent-package.json` 且其 `programs[entry_program]` 指向的 `.js` 产物存在（不存在提示先 `npm run build`）；
- `pi_agent_dir` 存在时必须含 `models.json`；
- `stub_tools` 中的名字必须出现在解析后的 `programs` 映射里，否则报错（防止拼写错误导致护栏静默失效）；
- 未知字段报错（防拼写漂移），与平台「机械校验」风格一致。

## 5. 回放事件文件契约

### 5.1 文件格式

单个 JSON 文件，内容即完整 `EventEnvelope`（过 `validateEnvelope` 才算合法）：

```json
{
  "contract_version": "v1",
  "source": "jira",
  "event_id": "jira:HIM-12345:2026-11-08T10:00:00.000Z",
  "event_type": "jira:issue_updated",
  "timestamp": "2026-11-08T10:00:00.000+08:00",
  "session_id": "HIM-12345",
  "correlation_id": "jira:HIM-12345:2026-11-08T10:00:00.000Z",
  "hop_count": 0,
  "payload": { "……": "……" }
}
```

### 5.2 获取方式

- **首选**：CLI 子命令 `export-event`，从平台数据库导出（只读）：
  ```bash
  agent-local export-event --db <workspace>/platform/data/platform.db \
    --event-id <event_id> --out .local-run/events/HIM-12345.json
  ```
  实现：只读打开 SQLite，`SELECT event FROM entry_tasks WHERE event_id = ?`，写出原样 JSON。注意：本条依赖**只读访问 platform.db 文件**，不引入 `@asteriskzuo/agent-database` 包依赖，用最小只读查询实现（该数据库非本地运行依赖，仅导出用）。
- **兜底**：开发者手写样例事件文件（不依赖平台），契约相同。

## 6. LocalContextLoader 装配规则

### 6.1 与平台逐条对齐

输入 = 配置文件 + 回放文件；输出 = `RunContext`。与平台 `ContextLoader.load`（§2.1）的对齐关系：

| RunContext 字段 | 平台来源 | 本地来源 |
| --- | --- | --- |
| `business_id` / `channel_id` | 参数 | 配置文件 |
| `program` / `programs` | 资产物化 + resolveResource + 名解析 | path 资产目录 + 读各自清单 + 同名首个命中（同顺序：包→工具→skill） |
| `prompt` | profile.prompt | 配置文件 |
| `skills` | skill 资产技能并集 | 同上，从 path skill 资产清单解析 |
| `model` | profile.model | 配置文件 |
| `pi_agent_dir` | piResolver 派生目录 | 配置文件 `pi_agent_dir`（存在性校验，不做原子再生成） |
| `vars` / `secrets` | env.getFor | 配置文件 |
| `quota` | 业务覆盖 ?? 全局默认 | 配置文件（要求填**最终生效值**） |

本地不做：凭据解析（path 资产无需凭据）、上下架检查、注册表查询。名解析逻辑（同名首个命中、相对路径拼资产根）必须复刻平台语义，建议把名解析实现为可单测的纯函数并与平台用例对齐。

### 6.2 stub 应用点

`stub_tools` 护栏在**装配完成之后、生成执行请求之前**应用：被 stub 的工具名在 `programs` 映射中替换为 local-runner 内置替身程序路径（§9）。**上下文 diff 在 stub 应用之前的「等值上下文」上进行**（§7），否则护栏会污染等值判定。

### 6.3 本地目录策略

本地复用平台的目录派生规则（`packages/runtime/src/lifecycle.ts:63-72`），只替换根目录。设本地运行根 `local_root`（默认 `.local-run/workspace/`，可用配置 `workspace_root` 覆盖）：

```text
businessRoot  = {local_root}/businesses/{business_id}
workspace     = {businessRoot}/runs/{event.source}/{event.session_id}/{run_id}
session_dir   = {businessRoot}/cache/agent-sessions/{event.source}/{event.session_id}
audit_log_path= {workspace}/audit/llm-requests.jsonl
```

关键点：`createWorkflowRunner({ workspaceRoot: local_root })` 内部会按同一规则自行派生 `runs/`、`logs/`、`data/`（`packages/workflow-runner/src/runner.ts:182-196`）并注入 `dataDir`，因此 CLI 只需把**同一个 local_root** 同时传给 WorkflowRunner 和上述三处路径派生，布局即与平台逐层一致。CLI 在调用 `executeRun` 前创建 workspace、session_dir 与 audit 父目录（执行核契约要求调用方创建）。`run_id` 由 CLI 每次生成（`run_` + 26 位 ULID，与平台同规则）。

**注意**：这同时意味着本地会真实创建业务级 `data/` 持久目录——回放重复执行时业务状态（如去重记录）会同平台一样累积，属预期行为；需要干净重放时由开发者自行删除对应 `data/{source}/{session_id}/` 目录。

## 7. 上下文等值 diff

### 7.1 平台上下文快照的获取

diff 需要平台侧的真实上下文作为基准。本期在 `packages/runtime` 增加一个**调试快照钩子**（已确认，原决策点 D1）：Lifecycle 在 `load` 成功后把 RunContext 落盘为 JSON（`{WS}/businesses/{bid}/logs/context-snapshots/{run_id}.json`），由环境变量开关控制（默认关闭）。这是本期对平台侧唯一的改动，属调试辅助、不改变执行行为。

快照由平台 Lifecycle 层写入、内容就是 `RunContext` 本身，天然业务无关——满足 §3 决策 4 的统一性约束。不采用「从 run 日志的 RunRequest 调试行解析」的替代方案：那是 Runner 入参视角，缺 prompt/skills/model/pi_agent_dir 等 serve 侧字段，不完整。

### 7.2 规范化规则：内容 digest 比较（不做路径字符串比较）

平台与本地的程序/skill 物理路径必然不同（物化缓存根 vs 本地 path 根），字符串重写既脆弱又需要额外维护 asset_id ↔ 本地名映射。因此等值的精确定义采用**内容等值**：

1. **路径类字段转 digest**：`program`、`programs.*`（文件）→ 目标文件内容的 sha256；`skills.*.path`（目录）→ 目录内全部文件的 `(相对路径, 文件 sha256)` 按路径排序后再取 sha256；`pi_agent_dir` → 其内 `models.json` 内容 sha256。比较键 = 程序名 / 技能名，值 = digest。键集合不同或同名 digest 不同都算差异。
2. **数组序**：`skills` 数组按 `name` 排序后比较。
3. **secrets 脱敏**：比较值是否相等，diff 输出中值一律替换为 `"***"`，只报告「一致 / 不一致 / 缺失」。
4. **直比字段**：`business_id`、`channel_id`、`prompt`、`model`、`vars`、`quota` 直接比较值。

### 7.3 diff 输出

逐字段报告：`相等` / `不等（两侧规范化值）` / `仅平台有` / `仅本地有`。退出码：全部相等 = 0，有差异 = 1，快照或配置非法 = 2。

## 8. 本地 CLI

命令形态（包内 bin，monorepo 内使用；npm 发布形态属非目标）：

```bash
agent-local run --config .local-run/config.json --event .local-run/events/HIM-12345.json
agent-local diff --config .local-run/config.json --snapshot <平台快照.json>
agent-local export-event --db <platform.db> --event-id <id> --out <file>
```

`run` 行为：

1. 加载并校验配置（§4）与回放事件（§5.1）；
2. 装配 RunContext（§6.1），应用 stub（§6.2）；
3. 生成 run_id、创建目录（§6.3）；
4. 构造 `AgentService` / `WorkflowRunner`（构造参数来自配置文件），调用 `executeRun`；
5. 终端输出：`RunOutcome`（status/reason/failed_at/output）、业务日志与 audit 文件路径、错误堆栈；
6. 退出码：success = 0，failed/timeout = 1，装配/执行异常 = 2。

## 9. 出口副作用护栏

本地回放真实事件时，业务 main 里对出口工具的 `sdk.run` 调用会**真实再执行一遍**（发企微、回写 Jira），造成重复外发。上下文等值挡不住这个——出口调用是契约允许的正常路径。

机制：配置文件 `stub_tools` 列出的工具名，在装配后被替换为 local-runner 内置替身程序。替身程序行为遵守 SDK 结果协议（`packages/sdk/src/result.ts` 的 `exitWith` 同形）：从 stdin 读入参；**stdout 只写结果信封** `{contract_version:"v1", ok:true, output: <固定输出>}` 并以退出码 0 结束；`[stub]` 标记与被 stub 的工具名、入参摘要写 **stderr**（平台采集进业务日志，不污染结果通道）。固定输出按 `stub_outputs` 配置（键 = 工具名、值 = output 的 JSON，已确认，原决策点 D2 取 b 方案）；未配置的被 stub 工具默认 `output: {}`。

## 10. 测试要求

1. **local-context-loader**：每个 RunContext 字段的装配映射；名解析同名首个命中、包→工具→skill 顺序；配置非法的各类 fail-fast；stub 替换与拼写错误检测。
2. **context-diff**：规范化路径重写（平台物化根 ↔ 本地 path 根）、skills 排序、secrets 脱敏、三类差异报告与退出码。
3. **replay/export**：export-event 只读导出与 validateEnvelope 校验；非法回放文件报错。
4. **cli run 端到端**：用 `templates/agent-package` 构建产物 + 样例事件 + 替身模型（或 mock AgentService）跑通 `run`，断言 `executeRun` 被以正确参数调用、目录结构正确、退出码映射正确。
5. **平台侧**：快照钩子开关默认关闭、开启后落盘内容 = `load` 返回值；lifecycle 既有测试全绿。
6. 包边界检查：local-runner 的 package.json 无禁止依赖；全仓 build/typecheck/circular/ESLint/docs:check 通过。

## 11. 验收标准

- [ ] `agent-local export-event` 能从真实 platform.db 导出合法信封；
- [ ] 用 jira-ticket-review 业务的一次真实历史 run：快照 diff 通过（规范化后全等）；
- [ ] `agent-local run` 回放同一事件，业务代码零改动跑完，终端可见完整 RunOutcome 与日志路径；
- [ ] stub 的工具未真实外发，且业务能消费替身输出继续执行；
- [ ] 平台侧除快照钩子外零行为变化，全部既有测试通过。

## 12. 决策记录（2026-11-09 已全部确认）

| # | 位置 | 问题 | 结论 |
| --- | --- | --- | --- |
| D1 | §7.1 | 平台侧新增调试快照钩子（环境变量开关，默认关） | 接受 |
| D2 | §9 | stub 替身返回值形态 | b) 每工具可配置固定输出（`stub_outputs`），未配置默认 `{}` |
| D3 | §4 | 配置文件含 secrets 的存放纪律 | 单文件 + `.local-run/` 入 `.gitignore` + 提供 `config.example.json` |
| D4 | §5.2 | export-event 直接只读访问 platform.db | 接受（最小只读查询，不依赖 database 包） |
| D5 | §6.1 | quota 要求填最终生效值（不做本地侧默认值推导） | 接受（diff 以最终值比较，推导规则留在平台） |

另确认统一性约束（§3 决策 4）：本地运行输入只许来自平台层统一产出（platform.db / 上下文快照 / 本地配置文件），严禁解析业务日志或业务数据目录；需要新输入时先回平台层补统一产出。

## 13. 后续衔接（非本期）

- 二期共享资产 `git` 来源：只扩展 local-context-loader 的资产来源分支，`RunContext`、业务代码、执行核不变；
- npm 发布策略：run-core 及运行依赖统一确定发布边界后，CLI 才对外分发；
- 控制台手动触发本地运行 / 平台内「一键导出回放包」（配置快照 + 事件 + 资产版本锚定）产品化。
