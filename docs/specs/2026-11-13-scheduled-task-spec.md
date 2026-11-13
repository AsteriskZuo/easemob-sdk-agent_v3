# Spec：平台定时任务规则（业务包周期性无事件 run）

- 日期：2026-11-13
- 状态：按已定决策 D10 细化（用户 2026-11-13 认可方案并授权继续开发），实施前自查通过
- 背景出处（非必读）：`docs/specs/2026-11-12-sdk-log-analysis-spec.md` 决策 D9/D10——源码仓 bare 缓存的保活机制

## 1. 背景与问题

sdk-log-analysis 业务包的源码仓采用「远端 URL + 裸仓缓存 + detached worktree」方案（决策 D9）。实测冷克隆 emclient-linux 超过 20 分钟，而热仓 worktree add 仅 1.2–1.9s。因此**仓必须跨 run 常驻缓存，慢操作（clone/fetch）挪到闲时执行**。

平台目前没有任何「业务包周期性动作」机制：入口循环只消费队列事件，没有事件就没有 run。需要一个通用规则：**业务包在清单里声明周期性动作（名称/节奏/程序名），平台按节奏自动触发、或控制台手动点击触发一次「无事件 run」**。预热脚本只是该规则的第一个消费者——规则本身与预热内容完全解耦，平台不了解业务，只负责按契约执行程序。

## 2. 目标与非目标

目标：
1. 业务包经 `agent-package.json` 声明定时任务（程序名 + 触发节奏 + 可选超时），平台自动周期触发。
2. 控制台可查看每个业务包的定时任务清单与最近运行状态，并可手动点击「立即执行」。
3. 定时 run 复用既有执行链（ContextLoader → AgentService.serve → WorkflowRunner → lifecycle 打标），在控制台 run 记录可见，可排查问题。
4. 本地独立运行对等：不新增 local-runner 代码，用管道喂信封即可本地执行同一程序（方法写进 local-run guide）。

非目标：
- 不做 cron 表达式解析——用「间隔分钟数 + 上次运行时间」判定到期，最小够用。
- 不做失败自动重试——失败留痕，下一次到期自然再试；不做重试风暴。
- 不做定时任务间的编排/依赖（A 完了触发 B）——本期每个任务独立。
- 不改事件队列/扇出/出口投递——定时 run 永不入队，无派生事件。
- 不开放「运行中修改节奏」——改声明 = 重新登记资产。

## 3. 决策表

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| D1 | 声明位置与形状 | `agent-package.json` 顶层新增可选 `scheduled_tasks: ScheduledTaskDecl[]`（package 形态专属，与 `pi_tools` 平级）。每项：`name`（任务名）、`program`（程序名，必须 ∈ 同清单 `programs` 键）、`every_minutes`（间隔分钟，整数 ≥1）、`timeout_minutes`（可选，整数 ≥1，缺省用业务/全局 quota） | 清单随资产走，无 DB 变更；登记期即可 fail-fast（程序名在清单内可校验） |
| D2 | 到期判定与状态存哪 | **零新表**：复用 `lifecycles` 表——任务 channel = `buildBusinessChannelId(source, task_name, business_id)`，到期 = `now ≥ 该任务最近一次 run 的 created_at + every_minutes`（任意 source，手动执行也刷新基准）；无记录 = 到期；最近一次 status 仍 `running`（crash 残留）= 跳过不堆积 | 定时 run 天然要在控制台可见，打标本来就要写 lifecycles；再建状态表 = 双写一致性负担 |
| D3 | 合成事件 | 复用 `EventSource` 既有枚举：周期触发 `source="cron"`，手动触发 `source="manual"`（contracts 零改动）。`session_id = 任务名`，`event_type = "scheduled." + 任务名`，`payload = { task_name, trigger }`，`event_id/correlation_id = newEventId()`，`hop_count = 0`，`timestamp = now`。永不入队：无 watcher 匹配、无扇出、无出口投递 | 信封是 runner 的既有输入形状（`req.event` 用于目录键与段校验），合成一个合规信封比改 runner 签名动得少 |
| D4 | 执行链与 check 阶段 | 定时 run **跳过 check-input/check-output 与契约探测**——check 阶段是事件契约校验，对无事件任务无意义，拿合成事件过业务的 check-input 必然误杀。`RunRequest` 新增 `phases?: "all" \| "main-only"`（缺省 `"all"` = 现状）；`"main-only"` 只跑 main（全量信封），`failed_at` 恒 `"main"` | 复用 runner 的全部进程纪律（目录/env 隔离/超时/stdout 结果解析），只差跳过两段 check |
| D5 | 并发与屏障 | ① 同任务 in-flight 内存集合防重叠（上一次没跑完，tick/手动都不发起新的）；② 整体过 updates RunGate（`gate.run(business_id, fn)`）——应用屏障纪律与事件 run 一致，资产更新期间不发起定时 run | 与 entry-loop 同一套纪律，不发明新并发模型 |
| D6 | 手动触发 | console-api 新增：`GET /api/businesses/{id}/scheduled-tasks`（清单+各自最近 run 状态）、`POST /api/businesses/{id}/scheduled-tasks/{name}/run`（立即执行，返回 `{run_id}`；任务在跑 → 409）。控制台业务详情页新增「定时任务」区：表格（名称/程序/节奏/最近状态/最近时间）+ 「立即执行」按钮 | 用户明确要求「手动点击执行任务」；只读列表 + 一个按钮，UI 最小 |
| D7 | 本地对等 | local-runner **零改动**。本地预热 = 管道喂信封直接运行程序：`echo '{…}' \| node dist/apps/warmup/index.js`，信封含 `config/secrets/cacheDir`，`cacheDir` 指向本地 workspace 的 `businesses/{bid}/cache`（与 T4 e2e seed 布局一致）。方法增补进 `docs/refs/2026-11-09-local-run-guide.md` | 定时任务上下文无事件、形状极简，手工构造信封成本远低于给 local-runner 加命令；本地/平台预热共用同一 bare 缓存布局 |

## 4. 改动清单（按包）

### 4.1 contracts

零改动。`EventSource` 已含 `"cron" | "manual"`（`packages/contracts/src/envelope.ts:7-8`）。

### 4.2 asset-registry（`packages/asset-registry/src/validate.ts`）

- `AssetManifest` package 形态新增 `scheduled_tasks?: ScheduledTaskDecl[]`，导出类型：
  ```ts
  export interface ScheduledTaskDecl {
    name: string; // 任务名：非空、同清单内唯一；必须过 channel 段规则（不得含 "__"、/ \ : 与控制字符）——它直接用作 session_id 段
    program: string; // 程序名：必须 ∈ 同清单 programs 键（登记期 fail-fast）
    every_minutes: number; // 触发间隔分钟：整数 ≥1（tick 粒度 60s，小于 1 无意义）
    timeout_minutes?: number; // 可选超时（分钟，整数 ≥1）：缺省用业务/全局 quota；预热类冷启动耗时可能超默认值，业务可自提
  }
  ```
- 校验（package 形态；tool/skill 形态出现 → `validation_failed` 防误配，照 `pi_tools` 同款判法）：
  - 数组非空；`name` 非空字符串、无重复、过段规则；`program` 非空且 `program in manifest.programs`；`every_minutes` 整数 ≥1；`timeout_minutes`（若有）整数 ≥1。任一不满足 → `validation_failed: scheduled_tasks ...`，全量收集报错。
  - 段规则判定：与 `assertSafeSegment` 同口径（非空、不含 `__`、不含 `/ \ :` 与控制字符）。asset-registry 不依赖 contracts 则内联等价正则，注释标注「与 contracts assertSafeSegment 同规则，改动需同步」。

### 4.3 workflow-runner（`packages/workflow-runner/src/runner.ts`）

- `RunRequest` 新增 `phases?: "all" | "main-only"`（注释：缺省 `"all"` = 三段编排现状；`"main-only"` 仅定时任务用——跳过契约探测与 check-input/check-output，只跑 main 全量信封；事件 run 严禁使用）。
- `run()` 内：契约探测与两段 check 的执行条件改为 `probe.kind` 计划生成后，`phases === "main-only"` 时直接跳过（记一条 bizSink info：`"main-only 模式：跳过契约校验阶段（定时任务）"`）；main 阶段不变；`extractMetrics` 不变（main 产出仍剥离 metrics）。
- `RunOutcome.failed_at` 在 main-only 下恒为 `"main"`（现状自然成立，无需特判）。

### 4.3.1 run-core（`packages/run-core/src/execute-run.ts`）

- `ExecuteRunRequest` 新增 `phases?: "all" | "main-only"`（注释同 4.3 纪律），条件透传给 `runner.run`；事件 run 调用方不传，行为不变。

### 4.4 runtime（新文件 `packages/runtime/src/task-scheduler.ts`，`index.ts` 导出）

`createTaskScheduler(deps)`，接口：

```ts
interface TaskSchedulerDeps {
  registry: BusinessRegistry; // 枚举业务（list）与 profile（getProfile/package_asset_id）
  assets: AssetRegistry; // 读包清单 scheduled_tasks（凭据解析纪律同 context-loader：私有资产 secrets 优先 vars 兜底）
  env: EnvProvider; // 两桶配置：凭据解析用（复用 context-loader 的 credentialFor 模式）
  loader: ContextLoader; // 复用：定时 run 的 RunContext 与事件 run 同源（vars/secrets/skills/quota/pi 配置全一致）
  runner: WorkflowRunner; agentService: AgentService; // 复用 executeRun 执行核
  lifecycle: LifecycleStore & LifecycleWriter; // 打标（createLifecycle 同款 store，bootstrap 另建实例即可）
  workspaceRoot: string; db: Database; // 目录布局与到期查询（lifecycles 表）
  gate?: RunGate; // updates 屏障；缺省直通
  tickIntervalMs?: number; // 到期扫描间隔，缺省 60_000；测试注入小值
  now?: () => Date; // 测试注入时钟
}
interface TaskScheduler {
  start(): void; // 幂等：启动 tick 循环
  stop(): Promise<void>; // 停 tick、等在飞任务落定（不打断执行中的 run）
  /** 手动立即执行一次（console-api 用）。成功返回 run_id；任务不存在抛错；同任务在跑抛错（调用方映射 409） */
  runNow(business_id: string, task_name: string, trigger: "manual"): Promise<{ run_id: string }>;
  /** 任务清单 + 各自最近 run 状态（console-api 用）；业务不存在/包无声明 → 空数组 */
  describeTasks(business_id: string): Promise<TaskView[]>;
}
```

执行逻辑（`execute(business_id, decl, trigger)` 与 lifecycle.execute 同构）：
1. `run_id = run_${newUlid()}`；`event_id = newEventId()`；合成事件按 D3；`channel_id = buildBusinessChannelId(trigger === "manual" ? "manual" : "cron", decl.name, business_id)`。
2. 打标 running（lifecycleStore.markRunning）；目录：`workspace = {workspaceRoot}/businesses/{bid}/runs/{source}/{task_name}/{run_id}`，`session_dir = businesses/{bid}/cache/agent-sessions/{source}/{task_name}`，`audit_log_path = workspace/audit/llm-requests.jsonl`（与 lifecycle.ts 布局同构，source/session 两级键换成 cron/manual + 任务名）。
3. `ctx = loader.load(business_id, channel_id)`；`program = ctx.programs[decl.program]`，未命中 → 打 failed（`reason: 定时任务程序未物化: {decl.program}`）并返回（登记期已拦，运行期兜底）。
4. `executeRun({context: {...ctx, program, quota: {...ctx.quota, ...(decl.timeout_minutes !== undefined ? { timeout_minutes: decl.timeout_minutes } : {})}}, event, run_id, workspace, session_dir, audit_log_path}, {agentService, runner}, hooks)`，`hooks` 与 lifecycle.ts 同款（serve/runner 错误打 failed + 日志）。
5. 终态 markTerminal；`outcome.metrics` 非空则 `createRunMetricsStore(db).record(...)`（内部自建，与 createLifecycle 同款；预热耗时等指标进统计）。
6. **不扇出**——无 queue、无派生事件。

tick 循环：
- 每 `tickIntervalMs`：遍历 `registry.list()` → 每个 profile 的包清单 `scheduled_tasks`（读取方式：遍历前快照 `assets.list({})` 元数据表 + `assets.get(id, credentialFor)`，与 context-loader 第 3 步同模式；读取异常（如凭据缺失）→ warn 日志 + 跳过该业务，绝不让 tick 崩溃）。
- 到期判定按 D2（SQL：`SELECT status, created_at FROM lifecycles WHERE business_id=? AND channel_id IN (?, ?) ORDER BY created_at DESC LIMIT 1`，两 channel = cron/manual 同任务）。
- 到期且不在 in-flight → `gate.run(business_id, () => execute(...,"cron"))`，in-flight 加入/移除用 finally。
- 上次 run 仍 `running`：warn 日志「上次运行未完结（可能为 crash 残留），本次跳过」，不发起。
- 手动 `runNow`：同样过 gate + in-flight 检查，不等到期。

### 4.5 app/server（`app/server/src/bootstrap.ts`）

- 装配：`createTaskScheduler`（接线 registry/assets/env/loader/runner/agentService/lifecycle store/workspaceRoot/db/gate=updatesCoordinator），`start()` 在 `entryLoop.start()` 之后；`stop()` 挂在优雅停链（consoleApi stop 之后、entryLoop stop 之前均可，注释说明等在飞任务落定）。
- config 不新增 env 项（tick 60s 为平台常量）；`configView` 不变。

### 4.6 console-api（`packages/console-api/src/`）

- 新增两个路由（挂在既有 business 路由旁，鉴权与错误响应模式照现有路由）：
  - `GET /api/businesses/{business_id}/scheduled-tasks` → `200 { tasks: TaskView[] }`；业务不存在 → 404。
  - `POST /api/businesses/{business_id}/scheduled-tasks/{name}/run` → `202 { run_id }`；业务/任务不存在 → 404；任务在跑 → 409 `{ error }`。
- console-api 工厂 deps 新增 `taskScheduler: TaskScheduler`（bootstrap 注入）；`TaskView` 形状：`{ name, program, every_minutes, timeout_minutes?, last_run?: { run_id, status, created_at, finished_at?, reason? } }`。

### 4.7 console（`app/console/src/pages/BusinessEditPage.tsx`）

- 新增「定时任务」区（条件渲染：列表非空才显示）：表格列 = 名称 / 程序 / 节奏（每 N 分钟）/ 超时 / 最近状态 / 最近运行时间；行尾「立即执行」按钮（点击 → POST → 按钮转 loading → 完成后刷新列表；409 提示「该任务正在运行」）。
- API 调用加进 `app/console/src/api/client.ts`（照现有方法风格）。

### 4.8 sdk-log-analysis 业务仓（独立仓，`business/sdk-log-analysis/`）

- `agent-package.json`：新增 programs 键 `"warmup": "dist/apps/warmup/index.js"` 与声明：
  ```json
  "scheduled_tasks": [{ "name": "warmup", "program": "warmup", "every_minutes": 720, "timeout_minutes": 60 }]
  ```
  （每 12 小时预热，超时 60 分钟——冷克隆实测约 20 分钟，留 3 倍余量。）
- 新程序 `package/apps/warmup/index.ts`：从 stdin 信封读 `config.sdk_repo_url` / `config.sdk_repo_account` / `secrets` / `cacheDir`，复用 `worktree.ts` 已导出件（`repoSlug`/`repoCacheDir`/`withRepoLock`/`resolveGitCredentials`，**不改任何既有签名，只 import**）：`withRepoLock(cacheDir)` 内——无缓存 → 首克隆（临时目录 + rename 协议，照 D9）；有缓存 → `git fetch origin`（不带 tags）；随后机会性 prune。输出 `sdk.return({ repo, action: "cloned"|"fetched", duration_ms, ... })`（+ `metrics` 保留键：预热动作数与耗时进平台统计；SDK 出口是 `sdk.return`，无 `ok` 方法）；任何失败 `sdk.fail(...)`。
- 不新增依赖；凭据解析规则与主流程序完全一致（决策 D11）。

### 4.9 不需要改动的部分（明确排除）

- **local-runner**：零改动（D7）。
- **jira-ticket-review 业务仓**：零感知——不声明 `scheduled_tasks` 即无任务。
- **contracts / queue / channel / scheduler 包**：合成事件复用既有枚举；定时 run 不入队，scheduler 包的两条循环零改动。
- **数据库**：零迁移——复用 `lifecycles` 表（D2）。
- **sdk**：信封形状已有全部字段（`config/secrets/cacheDir`），零改动。

## 5. 合成事件精确形状

```jsonc
{
  "contract_version": "v1",
  "source": "cron",              // 周期 = "cron"；手动 = "manual"（EventSource 既有枚举）
  "event_id": "evt_<ulid>",      // newEventId()；仅留痕，不入队不当幂等键
  "event_type": "scheduled.warmup", // "scheduled." + 任务名
  "timestamp": "<ISO 8601 带时区>",
  "session_id": "warmup",        // = 任务名（过 assertSafeSegment）
  "correlation_id": "evt_<ulid>", // = event_id（无派生链）
  "hop_count": 0,
  "payload": { "task_name": "warmup", "trigger": "cron" } // 业务可读；平台不解释
}
```

## 6. 测试要求

- asset-registry：`scheduled_tasks` 合法（单/多任务、timeout 缺省）与非法（非数组、空数组、name 空/重复/含 `__`/含非法字符、program 不在 programs 键、every_minutes 非整数/<1、timeout_minutes 非法、tool 形态误配）用例。
- workflow-runner：`phases: "main-only"`——有 check 程序的资产也只跑 main（bizSink 记录跳过、产出正常解析、metrics 仍剥离）；缺省 `"all"` 行为与现状逐点一致（回归）。
- runtime task-scheduler：
  - 到期/未到期/无记录（立即到期）/上次 running 跳过/手动执行刷新 cron 到期基准（D2 的 IN 两 channel 查询）；
  - 合成事件形状与 channel_id（cron/manual 两段）断言；
  - in-flight：同任务执行中再触发（tick 与 runNow 双路径）→ 不重叠；
  - 程序名未物化 → failed 打标不抛穿；
  - timeout_minutes 覆盖 quota 生效（runner 收到覆盖值）；
  - 清单读取异常（凭据缺失）→ 跳过该业务、tick 存活；
  - stop() 等在飞落定。
- console-api：两路由 200/404/409 与 TaskView 形状。
- app/console：组件渲染 + 按钮交互（既有测试模式照抄；若该页无测试基建则手动验证记录于交付说明）。
- sdk-log-analysis 业务仓：warmup 冷/热两条路径（mock git 层，照 worktree.ts 既有测试模式）+ 契约（agent-package.json）登记校验。
- 回归：全仓测试绿色；事件 run 行为不变（既有 lifecycle/runner 测试全绿即证据）。

## 7. 影响与兼容性

- 既有业务（jira-ticket-review）零感知：不声明即无任务；`phases` 缺省 `"all"`，事件 run 链零变化。
- 向后兼容：所有新字段可选；无 DB 迁移；无 env 新增。
- 风险与缓解：① 定时 run 与事件 run 并发共用 `task_concurrency` 之外的资源——定时 run 不过入口信号量，但过 RunGate 屏障与 pi/agent-service 资源；预热类任务应选低峰节奏（业务自律，平台不预判）。② crash 残留 running 会让任务停摆——运维走平台既有重置途径（platform-ops skill），spec 不新增机制。③ 业务把重活塞进高频任务会拖垮机器——`every_minutes ≥1` + tick 60s 是硬下限，更细的治理不做。

## 8. 验收标准

1. 全仓构建 + 测试通过（含新增用例），事件 run 回归全绿。
2. sdk-log-analysis 登记后：控制台业务详情可见「定时任务」区（warmup/每 720 分钟）；点击「立即执行」→ 出现 run 记录（channel `manual__warmup__sdk-log-analysis`），热仓路径秒级完成，bare 缓存 fetch 生效。
3. 手动执行后，距上次 run 未达 720 分钟时 tick 不再触发（到期基准含 manual，D2）。
4. 本地对等：`echo 信封 | node dist/apps/warmup/index.js`（cacheDir 指向 `.local-run/.../cache`）成功预热同一 bare 缓存，与平台预热产物布局一致。
5. 平台预热与事件 run 的 fetch 共用同一把 `withRepoLock` 锁（业务仓测试断言锁路径一致），无并发冲突。
