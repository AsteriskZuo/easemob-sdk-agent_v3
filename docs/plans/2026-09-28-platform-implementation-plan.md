# 平台实现总计划

> 本计划是实现的唯一执行入口：任务拆分、依赖关系、进度追踪都在此。任务规格（spec）在 `docs/specs/`，**spec 自包含，执行子 agent 只读 spec 与本计划**。
> **接手者先读**：[交接说明](./2026-09-30-handoff.md)（当前快照、剩余工作、工作模式、交互习惯）。
> 目标：平台全部模块实现完成、全部检查（build/test/typecheck/lint/format/circular）通过。**真实业务接入与验收（如单轮审查工单）不在本计划范围**，由用户之后手动进行。
> 所有任务遵守顶级工程规则：**依赖管理四类归宿**（`docs/designs/2026-09-14-skill-platform-spec-v3/design/dependency-rules.md`）。

## 1. 工程结构（目标形态）

```text
├── packages/               # 平台内部库（@asterisk/agent-*，不对外发布）
│   ├── contracts/          # 事件信封 v1、channel_id、校验器（零依赖）
│   ├── database/           # SQLite 薄封装（node:sqlite），全平台唯一数据访问口
│   ├── queue/              # 持久任务队列（entry/exit 双实例共用）
│   ├── registry/           # 业务注册表 + 入口匹配（一对多 BusinessMatch）
│   ├── channel/            # ChannelPool/Channel + ChannelStore（会话映射）
│   ├── logger/             # 日志：ConsoleLike 底层 + 全局外观（规则第 2 类）
│   ├── env/                # 环境变量唯一读取口（规则第 1 类）
│   ├── scheduler/          # 双调度循环 + 并发闸门 + hop_count + on_failure
│   ├── runtime/            # Lifecycle 四步时序 + ContextLoader + EnvProvider 两桶
│   ├── asset-registry/     # 资产注册表：三族资产（包/工具/skill）登记/校验/物化/名解析
│   └── exit-tools/         # 出口工具群（统一 ExitTool 接口）
├── sdk/                    # @asterisk/agent-sdk，业务 SDK（唯一面向业务用户的包）
├── app/
│   ├── server/             # 后台守护进程：装配 + webhook 入口 + 管理 API
│   └── console/            # 浏览器控制台 SPA（React + Vite）
├── workspace/              # 运行时数据（gitignore；七类数据布局见 console-design §6）
└── docs/
```

依赖方向单向：`contracts ← database ← queue/registry/channel；contracts ← logger/env；queue/registry/channel + logger ← scheduler/exit-tools ← runtime ← server`；sdk 只依赖 contracts。dpdm 强制检查。

## 2. 编排机制

- **主 agent** 负责任务派发、进度追踪、验收与子 agent 产出审查；**子 agent** 负责具体实现，与主 agent 同模型。
- **并发 ≤ 2**：只在依赖关系允许时并行派发无冲突任务。
- **进度追踪落独立文档**：执行过程记录在 [进度记录文档](./2026-09-28-platform-implementation-progress.md)（每任务一块：状态、子 agent、起止时间、验收证据、commit、遇到的问题）。分工：**本计划 = 静态任务定义与依赖（任务表状态列保持最新，作为总览）；进度文档 = 动态执行明细**。中断后重开会话，读这两个文档即可从未完成任务重新派发子 agent，任务级恢复。不使用 `docs/PROGRESS.md`（它是整个项目级的 roadmap）。
- **进度检查**：子 agent 的逐步执行记录实时落盘于会话日志，主 agent 每约 10 分钟读取快照确认无跑偏/卡死；发现异常可中止重派，损失最多一个任务。
- **提交粒度**：每任务完成且检查全绿即提交一次，提交即恢复检查点。
- **spec 滚动细化**：每批次执行前编写该批 spec，用户审过后再派发；spec 精确到接口签名、文件清单、测试清单与不做清单。

## 3. 任务表

| # | 任务 | 产出 | 依赖 | spec | 状态 |
|---|------|------|------|------|------|
| T0 | 工程骨架 | yarn 4.14.1 workspaces + tsconfig + jest/esbuild + eslint + prettier + dpdm + 根脚本 | — | [spec](../specs/2026-09-28-t0-engineering-skeleton-spec.md) | [x] |
| T1 | `@asterisk/agent-contracts` | 信封 v1 类型与校验、channel_id 编解码、ULID | T0 | [spec](../specs/2026-09-28-t1-contracts-spec.md) | [x] |
| T2 | `@asterisk/agent-database` | SQLite 薄封装 + 迁移原语，全平台唯一数据访问口 | T1 | [spec](../specs/2026-09-28-t2-database-spec.md) | [x] |
| T3 | `@asterisk/agent-queue` | 持久任务队列（入队/take/complete/deadLetter/query/recover/purge） | T2 | [spec](../specs/2026-09-28-t3-queue-spec.md) | [x] |
| T4 | `@asterisk/agent-registry` | 业务注册表 + 入口匹配 + 出口绑定存取 | T2 | [spec](../specs/2026-09-28-t4-registry-spec.md) | [x] |
| T5 | `@asterisk/agent-channel` | ChannelPool/Channel（异步可迭代串行链）+ ChannelStore（会话映射） | T2 T3 | [spec](../specs/2026-09-29-t5-channel-spec.md) | [x] |
| T6 | `@asterisk/agent-logger` | ConsoleLike 底层 + 全局外观（initLogger/logger.for）+ 脱敏 + fail-fast | T1 | [spec](../specs/2026-09-29-t6-logger-spec.md) | [x] |
| T7 | `@asterisk/agent-env` | 环境变量唯一读取口（类型解析 + 必需校验 fail-fast） | T1 | [spec](../specs/2026-09-29-t7-env-spec.md) | [x] |
| T8 | `@asterisk/agent-scheduler` | 入口/出口双调度循环 + 并发闸门 + hop_count + on_failure | T3 T4 T5 | [spec](../specs/2026-09-29-t8-scheduler-spec.md) | [x] |
| T9 | `@asterisk/agent-exit-tools` | ExitTool 接口 + 3 实现（企微群 webhook/邮件/自定义 webhook）+ 4 占位 | T1 | [spec](../specs/2026-09-29-t9-exit-tools-spec.md) | [x] |
| T10 | WorkflowRunner + `@asterisk/agent-sdk` | 业务子进程契约两侧同批实现（socket wire 协议唯一定义） | T1 T6 | [spec](../specs/2026-09-29-t10-workflow-runner-sdk-spec.md) | [x] |
| T11 | AgentService（packages/agent-service） | unix socket + 一次性 token + spawn pi + 配额 + 审计落盘 | T10 | 2026-09-29-t11-agent-service-spec.md | [x] |
| T15 | 程序包模板 | `templates/agent-package/`：拷贝即用的包骨架（清单 + sdk 依赖 + lint/test/format/circular 同平台 + 示例 program/skill） | T10 | 2026-09-29-t15-package-template-spec.md | [x] |
| T16 | `@asterisk/agent-asset-registry` | 资产注册表：三族资产（包/工具/skill）git 三元组登记 + 清单校验 + 物化 + 名解析纯函数 | T2 | [spec](../specs/2026-09-30-t16-asset-registry-spec.md) | [x] |
| T17 | `@asterisk/agent-runtime` | Lifecycle 四步时序 + ContextLoader + EnvProvider 两桶；顺带扩 registry 业务资料字段（prompt/model/资产绑定/quota/入口配置） | T4 T10 T11 T16 | [spec](../specs/2026-09-30-t17-runtime-spec.md) | [x] |
| T12 | `app/server` | 平台装配 + EntryAdapter 接口 + 启动自检 + ExitDriver 机密回填 | T7 T8 T9 T17 | [spec](../specs/2026-10-03-t12-server-spec.md) | [x] |
| T13 | 管理 API | `packages/console-api`（账号体系 + 全部管理路由）+ server 装配扩展（DTO 由包导出，console type-only 复用，不进 contracts） | T12 | [spec](../specs/2026-10-05-t13-console-api-spec.md) | [x] |
| T14 | `app/console` | React + Vite SPA，调管理 API（六页 MVP 一次做全；console-api 顺带扩静态托管） | T13 | [spec](../specs/2026-10-07-t14-console-spec.md) | [x] |
| T18 | webhook 入口适配器 | EntryAdapter 首个实现：验签 + 会话标识 + 幂等约定（entry_config schema 随本任务定）——**并入 T21** | T12 | 并入 T21 spec | [ ] |
| T19 | 组合机制回炉（真机验证驱动） | T19a 平台侧：信封 programs 映射 + sdk.run 按名查表 + ContextLoader 全量映射 + registry 去模型硬编码 + console-api 绑定配置期校验 + server models.json 解析；T19b console 业务编辑页重做 | T14 | [spec](../specs/2026-10-07-t19-composition-rework-spec.md) | T19a [x] T19b [x] |
| T20 | 包名改名 + sdk 发布准备 | `@easemob/agent-*` → `@asterisk/agent-*` 全量替换；sdk 具备 npm 发布条件 | 无 | [decision](../decisions/2026-10-08-package-scope-rename.md)（机械改动无 spec） | [x] |
| T21 | 平台侧可落地批次 | 物化构建链路（npm ci + agent.materialize.mjs 必带）+ jira-polling/webhook 入口适配器（含开关）+ 信封 dataDir + 出口 null 跳过 + 出入口 schema 自描述 + 内部入口（上游业务）建模 + sdk 文档 + 控制台缓存清理 | T12 T16 T20 | [spec](../specs/2026-10-08-t21-platform-landability-spec.md)（吸收 T18） | T21a-d [x] |
| T22 | 首个业务迁移验证 | business/jira-ticket-review 独立仓库：包/工具/skill 三资产 + codex→pi + 真机验证（polling 入口 + 企微出口） | T21 | [spec](../specs/2026-10-09-t22-jira-ticket-review-migration-spec.md) | [x]（实现完成，真机验证待用户手动执行） |

## 4. 执行批次（并发 ≤2）

```text
批次0：T0                （串行，骨架先行）✅
批次1：T1                （串行，契约冻结）✅
批次2：T2                （串行，数据访问口先行）✅
批次3：T3 ‖ T4           ✅
批次4：T5 ‖ T6           ✅
批次5：T7                （串行，env 小包先行——server 等后续任务依赖它）
批次6：T8
批次7：T9 ‖ T10
批次8：T11 ‖ T15
批次9：T16
批次10：T17
批次11：T12
批次12：T13
批次13：T14
批次14：T19a → T19b       （串行：console 依赖 T19a 的 EffectiveConfigView 新字段）✅
批次15：T20               （机械改名，串行）
批次16：T21               （吸收 T18；spec → 用户审 → 实现）
批次17：T22               （首个业务真机验证）
```

## 5. 验证策略

- **每任务验收**：该包（或 app）的 `build` / `test` / `typecheck` / `lint` / `format:check` 全绿 + spec 验收标准逐条过；包级测试覆盖该任务 spec 的测试清单。
- **整体完成**：根目录一键 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 全绿。
- T12 的集成验证用内存 fixture（假业务流程程序、假出口），属单元/集成测试范畴，**不接真实业务**。

## 6. 范围外（本计划不做）

- 真实业务接入与端到端验收（单轮审查工单等）——用户手动进行；
- CI 平台配置、Docker 部署、沙箱隔离（设计已定第二阶段再议）；
- 死信告警渠道、出口重试参数调优（设计待定项，实现期配置）。

## 7. 任务依赖关系列表

- T0：无依赖
- T1 ← T0
- T2 ← T1
- T3 ← T2；T4 ← T2；T5 ← T2, T3
- T6 ← T1；T7 ← T1
- T8 ← T3, T4, T5
- T9 ← T1
- T10 ← T1, T6
- T11 ← T10
- T15 ← T10
- T16 ← T2
- T17 ← T4, T10, T11, T16
- T12 ← T7, T8, T9, T17
- T13 ← T12
- T14 ← T13
- T18 ← T12（并入 T21）
- T20：无依赖（机械改名）
- T21 ← T12, T16, T20
- T22 ← T21

## 变更记录

- 2026-09-28：插入 T2 database（core-modules §4.7「SQLite 薄封装、全平台唯一数据访问口」的落地——queue/registry/channel 都需要持久化，不允许各自直接用 node:sqlite），原 T2–T12 顺延为 T3–T13。
- 2026-09-29：T5 依赖补 T3（Channel 迭代项携带 Task 类型）；EntryAdapter 接口从 T5 移到 T12（装配层接口）；顶级规则「依赖管理四类归宿」定稿（design/dependency-rules.md + AGENTS.md #11）；插入 T7 env（环境变量唯一读取口，规则第 1 类落地），原 T7–T13 顺延为 T8–T14；T6 logger 由 hub 注入改为全局外观（规则第 2 类落地）。
- 2026-09-29：七类数据分类定稿（console-design §6 重写，businesses/ 目录消解为 config.json + data/ + content/ + cache/ + runs/ + logs/）；资产单元从 skill 更正为程序包（skill-package.md → package-model.md 重写为模型+作者指南）；SDK 迁 packages/sdk/ 并允许依赖零依赖纯包；插入 T15 程序包模板（批次8 与 T11 并行）。
- 2026-09-30：补三个计划缺口——① 插入 T16 package-registry（core-modules §4.4 定义了 PackageRegistry、工程树画了它，任务表无人认领）；② 插入 T17 runtime（Lifecycle 四步时序 + ContextLoader 悬空：WorkflowRunner/AgentService 已独立成包，core-modules §4.1 的 ContextLoader 与 §4.2 的四步时序无人落地；T17 顺带扩 registry 业务资料字段——prompt/model/package_bindings/quota/入口配置，消费方最清楚要什么故并入而非单开任务）；③ T12 依赖改为 T7 T8 T9 T17。批次 9-13 顺延。
- 2026-09-30：**资产模型定案**（package-model.md → asset-model.md 重写）：资产单元从单一程序包演进为三族——包（业务代码单位，不共享）/ 工具（可复用代码组件）/ skill（可复用提示词组件）；git 三元组标识、属主 + 共享标记（创建时定不可改）；EnvProvider 三类并为普通/安全两桶（T17 纳入实现）；平台不再内置资产。T16 随之改为 asset-registry（spec 重写，原 package-registry spec 作废）；T17 描述同步（EnvProvider 两桶 + 资产绑定三族）。T15 模板需随资产模型小幅修订（清单删 skills、删内嵌示例 skill），随 T16 批次一并处理。
- 2026-10-04：T12 范围收缩（owner 裁决）——webhook 入口适配器移出为 T18（外部业务推送形态复杂，验签/会话标识/幂等约定随 T18 单独设计），AibotConnector 维持归企微入口任务；T12 = 平台装配 + EntryAdapter 接口 + 启动自检 + ExitDriver。入口流量与管理 API 各自独立 HTTP 服务。范围外删除「github/jira/confluence 出口工具」一行（T9 已扩展为七工具全实现）。
- 2026-10-08：插入 T20/T21/T22，T18 并入 T21——① T20 包名改名 @easemob→@asterisk + sdk 发布准备（决策 docs/decisions/2026-10-08-package-scope-rename.md，机械改动无 spec）；② T21 平台侧可落地批次（决策 docs/decisions/2026-10-08-asset-materialization-build.md）：v2 迁移验证暴露物化构建链路缺口（清单指 dist/ 但 git 忽略，无任何转译实现），连带回补 jira-polling/webhook 入口（T18 吸收）、适配器开关、信封 dataDir、出口 null 跳过、出入口 schema 自描述、内部入口（上游业务）建模、sdk 文档；③ T22 首个业务迁移验证（v2 单轮审查工单 → business/jira-ticket-review 独立仓库）。
