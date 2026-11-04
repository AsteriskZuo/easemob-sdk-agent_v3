<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 平台机制 · 全貌与心智模型


## 平台定位：业务组合与事件执行底座

> `platform.overview.positioning`

平台把**业务包、工具、skill、大模型、入口、出口和运行策略**组合成业务，再把外部事件转换为统一信封，按通道调度执行并扇出结果。业务代码通过 SDK 使用平台能力，不需要自行实现队列、会话映射、AgentService 或出口重试。
当前形态是**单进程模块化单体 + 多进程业务执行**：装配根在一个 Node.js 进程内连接注册表、队列、调度、控制面和 AgentService；WorkflowRunner 为业务阶段创建子进程，AgentService 再按需创建 Pi 子进程。它不是多副本分布式调度器，也不提供跨进程通道串行保证。


_参见：`platform.overview.process-topology`、`platform.runtime.run-lifecycle`_


## 五个对象：事件、业务、通道、run、资产

> `platform.overview.mind-model`

| 对象 | 在平台中的职责 | 关键标识 |
| --- | --- | --- |
| 事件 | 携带一次输入或一次业务产出 | `event_id` 标识实例，`event_type` 标识类别 |
| 业务 | 一组可运行配置，也是事件关注者 | `business_id` 是内部引用锚，`business_name` 仅展示 |
| 通道 | 决定哪些执行必须串行 | 业务通道为 `source__session_id__business_id` |
| run | 某业务被某事件触发的一次执行实例 | `run_id` 同时是 lifecycle_id 和运行目录名 |
| 资产 | 可登记、物化和绑定的 package/tool/skill | `asset_id` 标识资产身份，登记 commit 标识当前版本 |

一次入口事件可以命中多个业务，因而产生多个 run；同一业务也可以有多条 match 行。event_id 不是 run_id，queue task 也不是 lifecycle 记录，排查时不能混用。


_参见：`platform.eventing.envelope`、`platform.eventing.channel`、`platform.runtime.run-lifecycle`_


## 进程拓扑：谁常驻，谁按次创建

> `platform.overview.process-topology`

```text
平台 Node.js 进程
├─ 入口适配器 / console-api
├─ 入口循环 + 出口循环 + 更新协调器
├─ SQLite 注册表、队列与 lifecycle 打标
└─ Lifecycle
   ├─ ContextLoader：解析本次生效配置与资产
   ├─ AgentService：每 run 一个 Unix socket 服务
   └─ WorkflowRunner
      ├─ check-input 子进程（按计划）
      ├─ main 子进程
      │  └─ 经 socket 调用 AgentService → Pi 子进程
      └─ check-output 子进程（按计划）
```
每段业务程序是独立 Node.js 子进程，main 不直接持有平台数据库或注册表对象。它只拿到 stdin 信封、目录、配置、programs 和 per-run endpoint；AgentService 在 run 收尾时关闭并使 token 失效。


_参见：`platform.runtime.process-contract`、`platform.runtime.agent-service`_


## 两个事件循环，加一条管理更新队列

> `platform.overview.loops`

**入口循环**消费 `entry_tasks`，匹配业务、执行 run 并派生结果；**出口循环**消费 `exit_tasks`，按产出方业务寻找出口绑定并投递。两条循环各自持有 ChannelPool 和并发信号量，入口受 `task_concurrency` 限制，出口受 `result_concurrency` 限制。
管理面还有 `business_update_commands`，用于业务、环境、资产和 Pi 配置的在线变更。它由更新协调器等待受影响业务空闲后应用，**不是第三个事件循环，也不携带 EventEnvelope**。启动时先恢复三条持久化队列，再开放事件循环和适配器。


_参见：`platform.eventing.entry-pipeline`、`platform.eventing.exit-delivery`、`platform.control-plane.update-coordinator`_


## 持久化边界：数据库、文件与内存各管什么

> `platform.overview.persistence`

`{workspace}/platform/data/platform.db` 保存业务、匹配行、出口绑定、资产登记、环境配置、两类事件任务、更新命令、通道记录、会话映射和 lifecycle 行。`{workspace}/platform/cache/assets/` 保存物化资产；业务目录保存 runs、logs、data 和 cache。
队列任务落库不代表所有调度状态都落库：通道内待消化项、任务剩余关注者计数、并发信号量、更新协调器活动计数和 Pi 验证记录都在内存。重启依赖持久化任务重新匹配和执行，而不是恢复内存中的精确现场。


_参见：`platform.eventing.recovery`、`platform.operations.workspace-layout`、`platform.operations.restart-recovery`_


## 五章阅读与代码地图

> `platform.overview.reading-map`

| 要回答的问题 | 文档 | 首要代码入口 |
| --- | --- | --- |
| 平台由哪些对象和进程组成 | 本章 | `app/server/src/bootstrap.ts` |
| 事件如何匹配、串行、派生和投递 | `platform/eventing` | `packages/scheduler/src/` |
| 一次 run 如何装配并执行 | `platform/runtime` | `packages/runtime/src/lifecycle.ts` |
| 配置与资产如何安全变更 | `platform/control-plane` | `app/server/src/updates/` |
| 如何看日志、恢复和识别边界 | `platform/operations` | `.agents/skills/platform-ops/SKILL.md` |

阅读机制时以代码和测试为现状真相；`docs/designs/` 用来解释设计动机，`dailylog/` 用来还原演进过程。旧设计稿中的目标能力若没有装配或运行路径，不应被当成已交付事实。


_参见：`platform.overview.current-boundaries`_


## 当前交付边界：枚举和设计目标不等于可用能力

> `platform.overview.current-boundaries`

当前装配的 Agent 内核只有 `pi`；内置入口适配器只有 `webhook` 与 `jira-polling`。`EventSource` 中的 `cron`、`manual`、`wecom`、`github` 是契约枚举，不代表对应监听器已经存在。
控制台已有业务、资产、环境、Pi 配置和只读监控能力，但没有通用的 run 终止/重试或生产队列清理接口；统计搜索等设计页面不能视为已交付。业务包可以做本地构建、单测和 mock 程序验证；携带外部资产和 AgentService 的完整独立运行仍未闭环。
另有具体出口装配缺口和保留策略缺口，运维章逐项列出。本章不把 spec 中的候选内核、cron/manual 入口、沙箱或未来独立运行目标写成现状。


_参见：`platform.operations.availability-boundaries`、`bizpkg.development.independent-boundary`_
