# 平台实现总计划

> 本计划是实现的唯一执行入口：任务拆分、依赖关系、进度追踪都在此。任务规格（spec）在 `docs/specs/`，**spec 自包含，执行子 agent 只读 spec 与本计划**。
> 目标：平台全部模块实现完成、全部检查（build/test/typecheck/lint/format/circular）通过。**真实业务接入与验收（如单轮审查工单）不在本计划范围**，由用户之后手动进行。

## 1. 工程结构（目标形态）

```text
├── packages/               # 平台内部库（@easemob/agent-*，不对外发布）
│   ├── contracts/          # 事件信封 v1、channel_id、校验器（零依赖）
│   ├── queue/              # SQLite 持久队列（node:sqlite，entry/exit 双实例共用）
│   ├── registry/           # 业务注册表 + 入口匹配（一对多 BusinessMatch）
│   ├── channel/            # 通道抽象 + 会话映射 + 入口适配器接口
│   ├── scheduler/          # 双调度循环 + 并发闸门 + hop_count + on_failure
│   ├── runtime/            # Lifecycle 四步时序 + WorkflowRunner + AgentService
│   ├── exit-tools/         # 出口工具群（统一 ExitTool 接口）
│   └── logger/             # 四类日志（system/entry-loop/exit-loop/business）
├── sdk/                    # @easemob/agent-sdk，业务 SDK（唯一面向业务用户的包）
├── app/
│   ├── server/             # 后台守护进程：装配 + webhook 入口 + 管理 API
│   └── console/            # 浏览器控制台 SPA（React + Vite）
├── businesses/             # 运行时数据（gitignore）
└── docs/
```

依赖方向单向：`contracts ← logger/queue/registry/channel ← scheduler/exit-tools ← runtime ← server`；sdk 只依赖 contracts。dpdm 强制检查。

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
| T0 | 工程骨架 | yarn 4.14.1 workspaces + tsconfig + jest/esbuild + eslint + prettier + dpdm + 根脚本 | — | [spec](../specs/2026-09-28-t0-engineering-skeleton-spec.md) | [ ] |
| T1 | `@easemob/agent-contracts` | 信封 v1 类型与校验、channel_id 编解码、ULID | T0 | [spec](../specs/2026-09-28-t1-contracts-spec.md) | [ ] |
| T2 | `@easemob/agent-queue` | SQLite 持久队列（入队/ack/重投/崩溃恢复） | T1 | 执行前编写 | [ ] |
| T3 | `@easemob/agent-registry` | 业务注册表 + 入口匹配规则 | T1 | 执行前编写 | [ ] |
| T4 | `@easemob/agent-channel` | 通道抽象 + channel↔agent 会话映射 | T1 | 执行前编写 | [ ] |
| T5 | `@easemob/agent-logger` | 四类日志 + 启动自检 fail-fast | T1 | 执行前编写 | [ ] |
| T6 | `@easemob/agent-scheduler` | 入口/出口双调度循环 + 并发闸门 + hop_count + on_failure | T2 T3 T4 | 执行前编写 | [ ] |
| T7 | `@easemob/agent-exit-tools` | ExitTool 接口 + 企微群 webhook + 邮件 + 自定义 webhook | T1 | 执行前编写 | [ ] |
| T8 | WorkflowRunner + `@easemob/agent-sdk` | 业务子进程契约两侧同批实现（含 stdin/stdout 契约补入 contracts） | T1 T5 | 执行前编写 | [ ] |
| T9 | AgentService（runtime 包内） | unix socket + 一次性 token + spawn pi + 配额 + 审计落盘 | T8 | 执行前编写 | [ ] |
| T10 | `app/server` | 平台装配 + webhook 入口适配器 + 启动自检 | T6 T7 T9 | 执行前编写 | [ ] |
| T11 | 管理 API | server 侧 console 接口（契约补入 contracts） | T10 | 执行前编写 | [ ] |
| T12 | `app/console` | React + Vite SPA，调管理 API | T11 | 执行前编写 | [ ] |

## 4. 执行批次（并发 ≤2）

```text
批次0：T0                （串行，骨架先行）
批次1：T1                （串行，契约冻结）
批次2：T2 ‖ T3
批次3：T4 ‖ T5
批次4：T6
批次5：T7 ‖ T8
批次6：T9
批次7：T10
批次8：T11
批次9：T12
```

## 5. 验证策略

- **每任务验收**：该包（或 app）的 `build` / `test` / `typecheck` / `lint` / `format:check` 全绿 + spec 验收标准逐条过；包级测试覆盖该任务 spec 的测试清单。
- **整体完成**：根目录一键 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 全绿。
- T10 的集成验证用内存 fixture（假业务流程程序、假出口），属单元/集成测试范畴，**不接真实业务**。

## 6. 范围外（本计划不做）

- 真实业务接入与端到端验收（单轮审查工单等）——用户手动进行；
- github / jira / confluence 出口操作工具——等真实业务需要时单独立任务；
- CI 平台配置、Docker 部署、沙箱隔离（设计已定第二阶段再议）；
- 死信告警渠道、出口重试参数调优（设计待定项，实现期配置）。

## 7. 任务依赖关系列表

- T0：无依赖
- T1 ← T0
- T2 ← T1；T3 ← T1；T4 ← T1；T5 ← T1
- T6 ← T2, T3, T4
- T7 ← T1
- T8 ← T1, T5
- T9 ← T8
- T10 ← T6, T7, T9
- T11 ← T10
- T12 ← T11
