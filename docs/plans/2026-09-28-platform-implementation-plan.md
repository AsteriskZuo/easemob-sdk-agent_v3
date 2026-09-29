# 平台实现总计划

> 本计划是实现的唯一执行入口：任务拆分、依赖关系、进度追踪都在此。任务规格（spec）在 `docs/specs/`，**spec 自包含，执行子 agent 只读 spec 与本计划**。
> 目标：平台全部模块实现完成、全部检查（build/test/typecheck/lint/format/circular）通过。**真实业务接入与验收（如单轮审查工单）不在本计划范围**，由用户之后手动进行。
> 所有任务遵守顶级工程规则：**依赖管理四类归宿**（`docs/designs/2026-09-14-skill-platform-spec-v3/design/dependency-rules.md`）。

## 1. 工程结构（目标形态）

```text
├── packages/               # 平台内部库（@easemob/agent-*，不对外发布）
│   ├── contracts/          # 事件信封 v1、channel_id、校验器（零依赖）
│   ├── database/           # SQLite 薄封装（node:sqlite），全平台唯一数据访问口
│   ├── queue/              # 持久任务队列（entry/exit 双实例共用）
│   ├── registry/           # 业务注册表 + 入口匹配（一对多 BusinessMatch）
│   ├── channel/            # ChannelPool/Channel + ChannelStore（会话映射）
│   ├── logger/             # 日志：ConsoleLike 底层 + 全局外观（规则第 2 类）
│   ├── env/                # 环境变量唯一读取口（规则第 1 类）
│   ├── scheduler/          # 双调度循环 + 并发闸门 + hop_count + on_failure
│   ├── runtime/            # Lifecycle 四步时序 + WorkflowRunner + AgentService
│   └── exit-tools/         # 出口工具群（统一 ExitTool 接口）
├── sdk/                    # @easemob/agent-sdk，业务 SDK（唯一面向业务用户的包）
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
| T1 | `@easemob/agent-contracts` | 信封 v1 类型与校验、channel_id 编解码、ULID | T0 | [spec](../specs/2026-09-28-t1-contracts-spec.md) | [x] |
| T2 | `@easemob/agent-database` | SQLite 薄封装 + 迁移原语，全平台唯一数据访问口 | T1 | [spec](../specs/2026-09-28-t2-database-spec.md) | [x] |
| T3 | `@easemob/agent-queue` | 持久任务队列（入队/take/complete/deadLetter/query/recover/purge） | T2 | [spec](../specs/2026-09-28-t3-queue-spec.md) | [x] |
| T4 | `@easemob/agent-registry` | 业务注册表 + 入口匹配 + 出口绑定存取 | T2 | [spec](../specs/2026-09-28-t4-registry-spec.md) | [x] |
| T5 | `@easemob/agent-channel` | ChannelPool/Channel（异步可迭代串行链）+ ChannelStore（会话映射） | T2 T3 | [spec](../specs/2026-09-29-t5-channel-spec.md) | [x] |
| T6 | `@easemob/agent-logger` | ConsoleLike 底层 + 全局外观（initLogger/logger.for）+ 脱敏 + fail-fast | T1 | [spec](../specs/2026-09-29-t6-logger-spec.md) | [x] |
| T7 | `@easemob/agent-env` | 环境变量唯一读取口（类型解析 + 必需校验 fail-fast） | T1 | [spec](../specs/2026-09-29-t7-env-spec.md) | [x] |
| T8 | `@easemob/agent-scheduler` | 入口/出口双调度循环 + 并发闸门 + hop_count + on_failure | T3 T4 T5 | [spec](../specs/2026-09-29-t8-scheduler-spec.md) | [x] |
| T9 | `@easemob/agent-exit-tools` | ExitTool 接口 + 3 实现（企微群 webhook/邮件/自定义 webhook）+ 4 占位 | T1 | [spec](../specs/2026-09-29-t9-exit-tools-spec.md) | [x] |
| T10 | WorkflowRunner + `@easemob/agent-sdk` | 业务子进程契约两侧同批实现（socket wire 协议唯一定义） | T1 T6 | [spec](../specs/2026-09-29-t10-workflow-runner-sdk-spec.md) | [x] |
| T11 | AgentService（packages/agent-service） | unix socket + 一次性 token + spawn pi + 配额 + 审计落盘 | T10 | 已编写（2026-09-29-t11-agent-service-spec.md），待用户审 | [ ] |
| T12 | `app/server` | 平台装配 + EntryAdapter 接口 + webhook 入口适配器 + 启动自检 | T7 T8 T9 T11 | 执行前编写 | [ ] |
| T13 | 管理 API | server 侧 console 接口（契约补入 contracts） | T12 | 执行前编写 | [ ] |
| T14 | `app/console` | React + Vite SPA，调管理 API | T13 | 执行前编写 | [ ] |
| T15 | 程序包模板 | `templates/agent-package/`：拷贝即用的包骨架（清单 + sdk 依赖 + lint/test/format/circular 同平台 + 示例 program/skill） | T10 | 已编写（2026-09-29-t15-package-template-spec.md），待用户审 | [ ] |

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
批次9：T12
批次10：T13
批次11：T14
```

## 5. 验证策略

- **每任务验收**：该包（或 app）的 `build` / `test` / `typecheck` / `lint` / `format:check` 全绿 + spec 验收标准逐条过；包级测试覆盖该任务 spec 的测试清单。
- **整体完成**：根目录一键 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 全绿。
- T12 的集成验证用内存 fixture（假业务流程程序、假出口），属单元/集成测试范畴，**不接真实业务**。

## 6. 范围外（本计划不做）

- 真实业务接入与端到端验收（单轮审查工单等）——用户手动进行；
- github / jira / confluence 出口操作工具——等真实业务需要时单独立任务；
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
- T12 ← T7, T8, T9, T11
- T13 ← T12
- T14 ← T13
- T15 ← T10

## 变更记录

- 2026-09-28：插入 T2 database（core-modules §4.7「SQLite 薄封装、全平台唯一数据访问口」的落地——queue/registry/channel 都需要持久化，不允许各自直接用 node:sqlite），原 T2–T12 顺延为 T3–T13。
- 2026-09-29：T5 依赖补 T3（Channel 迭代项携带 Task 类型）；EntryAdapter 接口从 T5 移到 T12（装配层接口）；顶级规则「依赖管理四类归宿」定稿（design/dependency-rules.md + AGENTS.md #11）；插入 T7 env（环境变量唯一读取口，规则第 1 类落地），原 T7–T13 顺延为 T8–T14；T6 logger 由 hub 注入改为全局外观（规则第 2 类落地）。
- 2026-09-29：七类数据分类定稿（console-design §6 重写，businesses/ 目录消解为 config.json + data/ + content/ + cache/ + runs/ + logs/）；资产单元从 skill 更正为程序包（skill-package.md → package-model.md 重写为模型+作者指南）；SDK 迁 packages/sdk/ 并允许依赖零依赖纯包；插入 T15 程序包模板（批次8 与 T11 并行）。
