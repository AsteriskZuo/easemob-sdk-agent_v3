# 业务包本地运行（第一期）实施计划

> 日期：2026-11-09
> Spec：`docs/specs/2026-11-09-local-run-spec.md`（自包含，执行只读 spec + 本计划）
> 执行方式：子代理分波执行；所有任务完成后主代理统一验收、更新本文件复选框、单次提交。

## 全局纪律

- 所有包维持 `private: true`，不做 npm 发布；
- 子代理**不执行 git commit**，代码留在工作区由主代理统一提交；
- 代码注释风格对齐所在包现状（中文 docstring 为主）；
- 触碰 spec 未覆盖的既有契约时停下来上报，不自行变更；
- 并行波次的子代理只跑自己模块的测试文件，不跑全量 build（避免 dist 竞争）；最终全量检查由主代理在收尾任务执行。

## 包骨架约定（T2 建立，后续任务遵循）

```text
packages/local-runner/
├── package.json      # name @asteriskzuo/agent-local-runner, private, type:module, bin: agent-local → dist/src/cli.js
├── tsconfig.json     # 对齐 packages/run-core/tsconfig.json
├── src/
│   ├── index.ts      # 公共导出：loadConfig / loadReplayEvent / assembleRunContext / applyStubTools / diffContexts / exportEventFromDb
│   ├── config.ts     # §4 配置加载校验
│   ├── replay.ts     # §5 回放文件加载 + export-event（node:sqlite 只读）
│   ├── local-context-loader.ts  # §6.1 装配 + §6.2 stub 应用
│   ├── name-resolve.ts          # 名解析复刻（对齐 packages/asset-registry/src/resolve.ts 语义）
│   ├── stub.ts                  # stub 文件生成器（见「关键跨任务契约」stub 协议）
│   ├── context-diff.ts          # §7 内容 digest 比较
│   └── cli.ts        # §8 三个子命令
└── tests/            # 每模块一个 .test.ts
```

测试脚本对齐 run-core 的 package.json（esbuild → dist-test → jest --config ../../jest.compiled.config.mjs）。依赖只允许：`@asteriskzuo/agent-contracts`、`@asteriskzuo/agent-run-core`、`@asteriskzuo/agent-service`、`@asteriskzuo/agent-workflow-runner`；devDependencies 对齐 run-core。

## 关键跨任务契约（避免并行分叉）

- **stub 协议**（T4 消费、T5 实现）：`applyStubTools(context, config)` 为每个被 stub 的工具**生成独立 js 文件** `{local_root}/.local-run-stubs/{工具名}.js`（每次 run 前重新生成），内容硬编码该工具的固定输出，并把 `programs[工具名]` 替换为该文件路径。生成的 stub 文件协议：读 stdin 后忽略内容；stdout 只写一行 JSON `{"contract_version":"v1","ok":true,"output":<固定输出>}` 后 `exit(0)`；stderr 写 `[stub] <工具名> <入参摘要>`。固定输出来自 `config.stub_outputs[工具名]`，未配置默认 `{}`。选择「每工具生成文件」而非「单一替身 + 传参」的原因：sdk.run 的 spawn 链路不支持向子程序注入自定义 argv/env，生成文件零传参、无残留语义。spec §9 的机制描述按此细化（实现细节，不改变契约）。

- **快照格式**（T1 产出、T6 消费）：Lifecycle 在 `load` 成功后、executeRun 前，若 `AGENT_CONTEXT_SNAPSHOT=1` 则写 `{businessRoot}/logs/context-snapshots/{run_id}.json`，内容 = `JSON.stringify(runContext, null, 2)`（含 secrets 原值——文件落平台 workspace 本地盘，与平台现有 secrets 处理同级；diff 输出时脱敏）。写失败只 warn 不中断 run。
- **diff 输入**（T6）：`agent-local diff --config <path> --snapshot <path>`；本地侧上下文 = assembleRunContext 的 **stub 应用前**结果。
- **export-event**（T3）：`new DatabaseSync(dbPath, { readOnly: true })`，`SELECT event FROM entry_tasks WHERE event_id = ?`，找不到报错退出码 2；写出前过 `validateEnvelope`。
- **目录派生**（T7）：严格按 spec §6.3，复用 lifecycle.ts:63-72 的同构派生；`createWorkflowRunner({ workspaceRoot: local_root })`。

## 任务

### T1：平台快照钩子（packages/runtime）

- [x] Lifecycle 在 `ContextLoader.load` 成功后按上述「快照格式」落盘（env `AGENT_CONTEXT_SNAPSHOT=1` 开启，默认关）；
- [x] 快照写失败仅 warn，不改变 run 行为；
- [x] 测试：默认关闭无文件；开启后落盘内容 = load 返回值；写失败不影响终态；
- [x] 环境变量登记：查平台 env 契约文档（docs/configuration.md 或 handbook）把 `AGENT_CONTEXT_SNAPSHOT` 按现有约定登记。

### T2：包骨架 + config.ts

- [x] 按「包骨架约定」建包（package.json/tsconfig/index.ts 空导出占位）；
- [x] config.ts：加载 + 校验（spec §4 全部规则，含 stub_tools 必须能命中解析后 programs 的校验——注意此项依赖名解析，可放在 loader 里做，config.ts 只做形状/存在性校验）；
- [x] 路径字段（assets.*.path、pi_agent_dir、workspace_root）解析为绝对路径（相对 = 配置文件所在目录）；
- [x] 测试：合法配置、各类非法配置的报错文案。

### T3：replay.ts + export-event

- [x] loadReplayEvent：读 JSON → validateEnvelope → 返回 EventEnvelope；
- [x] exportEventFromDb：node:sqlite readOnly 查询 → validateEnvelope → 写文件（pretty JSON）；
- [x] 测试：合法/非法信封、event_id 不存在、db 文件不存在。

### T4：name-resolve.ts + local-context-loader.ts

- [x] name-resolve.ts：复刻 resolve.ts 语义（程序=programs 名→join(root, rel)；skill=技能目录 join(root, name)；按资产顺序首个命中；全无抛 resource_not_found），并附与平台用例对齐的测试；
- [x] assembleRunContext(config)：按 spec §6.1 对齐表装配 RunContext（顺序：包→工具→skill；programs 并集同名首中；skills 并集同名首中去重）；读各资产清单（package/tool 读 agent-package.json，skill 资产读其清单的 skills 列表——skill 资产清单文件名需先核实 asset-registry validate.ts 的约定）；
- [x] applyStubTools(context, config)：按「关键跨任务契约」生成 stub 文件并替换 programs、返回新 context；
- [x] 校验：stub_tools 命中检查在此做；
- [x] 测试：对齐 spec §10.1。

### T5：stub 生成器（stub.ts）

- [x] 导出 `stubFileContent(tool: string, output: unknown): string`：生成独立 stub js 文件内容（协议见「关键跨任务契约」：stdout 结果信封、stderr [stub] 标记含工具名与入参摘要）；
- [x] 测试：生成的内容写到临时文件后能被 `node` 直接执行、stdin 任意输入均输出正确信封。

### T6：context-diff.ts

- [x] 按 spec §7.2 实现内容 digest 比较（文件 sha256；skill 目录递归 digest；pi_agent_dir → models.json digest；skills 按名排序；secrets 脱敏；直比字段）；
- [x] 输出：逐字段报告 + 退出码语义（全等 0 / 有差异 1 / 输入非法 2）由 cli 层实现，context-diff.ts 返回结构化报告；
- [x] 测试：全等、各类型差异、键集合不同、secrets 脱敏不落值。

### T7：cli.ts 三命令

- [x] `export-event`：接 T3；
- [x] `diff`：loadConfig → assembleRunContext（stub 前）→ diffContexts(snapshot) → 打印报告 + 退出码；
- [x] `run`：loadConfig → loadReplayEvent → assembleRunContext → applyStubTools → 目录派生与创建（spec §6.3）→ 构造 AgentService（pi_cli_path/pi_env/mapping=JSON 文件实现，落 `{local_root}/agent-session-mapping.json`）与 WorkflowRunner → executeRun → 终端输出 RunOutcome/日志路径/错误 → 退出码（success 0 / failed·timeout 1 / 异常 2）；
- [x] argv 解析不引依赖（node:util parseArgs）；
- [x] 测试：argv 解析、退出码映射（executeRun 可注入假实现）。

### T8：端到端验收（主代理执行）

- [x] templates/agent-package 构建产物 + 手写样例事件 + 替身 pi（或跳过 agent 调用的路径）跑通 `agent-local run`；
- [x] 全仓 build/typecheck/circular/ESLint/docs:check；
- [x] local-runner 依赖边界检查（无 database/registry/scheduler/asset-registry/app-server）；
- [x] 更新本文件复选框、dailylog，单次提交。

## 任务依赖关系

- T1：独立（改 packages/runtime，与其他任务无文件交集）；
- T2：独立（建包），是 T3/T4/T6/T7 的前置；
- T3：依赖 T2；
- T4：依赖 T2；与 T5 通过「关键跨任务契约」解耦，可并行；
- T5：依赖 T2（骨架）；
- T6：依赖 T2；与 T4 可并行（只依赖 RunContext 类型与 config 类型）；
- T7：依赖 T3、T4、T6；
- T8：依赖全部。

## 执行波次

1. 波 1（并行）：T1、T2
2. 波 2（并行）：T3、T4、T5、T6
3. 波 3：T7
4. 波 4：T8（主代理）
