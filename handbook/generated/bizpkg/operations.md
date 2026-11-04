<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 业务包 · 运维排错


## 运维排错：先定位层，再修改状态

> `bizpkg.operations.overview`

按固定顺序排查：**事件有没有到平台 → 是否被去重/排队 → 三段哪段失败 → 产出是否被业务跳过 → 出口是否投递失败**。
先读事件 id、业务 id、session id 和 run id，再对照平台与业务日志。不要在原因未定位时同时改业务配置、清状态和重启服务，否则无法判断哪项操作起效。
业务级去重记录与平台入口幂等是两层状态，重置其中一层不会自动重置另一层。


_参见：`bizpkg.operations.logs`、`bizpkg.operations.business-dedup`_


## 日志：区分平台调度与业务执行

> `bizpkg.operations.logs`

默认数据根 `.easemob-agent-workspace/platform/logs/` 下，平台进程日志用于看入口接收、匹配、队列、物化和出口；run 的业务日志来自 `sdk.log`，用于看主流程和模型原始输出。具体文件名与检索命令以当前平台运维手册为准。
排查一次真实事件时限定**新的时间窗和 event id**，不要把追加日志中的历史 error 当作本次错误。服务配置是否生效应同时核对配置文件修改时间、进程启动时间和只读运行配置，而非只搜到某个旧日志。


_参见：`bizpkg.development.logging`、`platform.operations.platform-logs`_


## 外部更新了，平台却没有新日志

> `bizpkg.operations.no-event`

对 webhook 依次检查：
1. 上游注册的是否为平台完整地址 `http://<host>:<port>/hooks/{path}`，host 是否为上游可达地址；
2. match 行 path 是否一致，body 是否为 JSON object，`session_id_key` 能否取到非空字符串；
3. token 是否匹配，body 是否超过 1MB；
4. 入口适配器是否启用、进程是否在监听对应端口；
5. 用 curl 直接请求并记录 HTTP 状态，再查同一时间窗的平台入口日志。

200 表示平台接收，重复 event_id 被幂等丢弃也仍可能返回 200；400 多为 body/字段配置，401 为验签失败，404 为未知 path。若 curl 成功而上游失败，再查上游网络、网关转发和重试记录。
polling 则检查适配器开关、项目/负责人过滤、轮询周期和 `updated` 是否变化。


_参见：`bizpkg.integration.entry-exit`、`bizpkg.operations.platform-dedup`_


## run 失败：按三个阶段收敛原因

> `bizpkg.operations.run-failure`

| 现象 | 优先检查 |
| --- | --- |
| check-input failed | 事件 payload 与 contract.input 是否一致；自写 check 是否做了禁止的副作用 |
| main failed / timeout | 业务日志、工具错误、模型配置与配额、主程序超时、未捕获异常 |
| check-output failed | 实际 output 与 contract.output、null 逃生门、出口 resultDoc 是否一致 |
| run success 但无通知 | 是否 `return(null)`、是否绑定出口、出口任务是否失败或重试 |

任一步失败都使整体失败；正常业务 failed/timeout 不会触发平台级整 run 自动重试，check-output 失败时结果不会扇出。崩溃恢复是另一套语义：processing 任务会重置为 pending 并可能重跑，不能把它理解为“失败后重试”。业务主动实现的模型链重试也不是整 run 重试，前者每次 agent 调用仍计配额。


_参见：`bizpkg.contract.pipeline`、`bizpkg.development.agent`、`platform.eventing.recovery`_


## 物化失败：先看阶段名和 stderr

> `bizpkg.operations.materialization-failure`

绑定操作会同步返回物化错误，先看失败阶段与 stderr 尾部，再逐项检查：仓库/凭据是否可访问、commit 与 subpath 是否正确、清单和 contract 是否存在且合法、lockfile 是否提交、物化脚本是否存在并成功退出、programs 声明的 JS 是否真实生成。
本地执行相同 Node 版本的六条检查，可排除大部分构建问题；但本地成功不能替代平台对 git 三元组、lockfile 和 programs 的验收。
清理资产缓存只解决缓存损坏或强制重建问题，不会修复仓库本身缺文件，也会让下次运行承担重新物化成本。


_参见：`bizpkg.integration.materialization`、`bizpkg.development.checks`_


## 平台幂等：同表 event_id 不重复入队

> `bizpkg.operations.platform-dedup`

每张事件队列表以 `event_id` 唯一约束去重。jira-polling 使用 `jira:{issueKey}:{updated}`，所以同 updated 的重复拉取不会产生新任务，updated 变化才是新事件。webhook 若未配置 `event_id_key`，平台通常生成新 id，上游重推是否重复由推送方与业务共同承担。
该约束只防止同表重复入队，不保证端到端只执行一次：崩溃恢复会重跑既有 processing 任务，并可能产生新的派生 event_id 和重复副作用。
需要同源同 event_id 重验时，仅重置业务记录不够，还要按平台运维手册处理对应入口任务状态。该操作只针对明确测试事件，先备份并限定条件，不能批量清空生产入口记录。


_参见：`bizpkg.operations.business-dedup`、`platform.eventing.queue-idempotency`_


## 业务去重：dataDir 状态可能合法跳过

> `bizpkg.operations.business-dedup`

平台只保证 event_id 幂等，不知道“同工单已审查通过”“同版本无需再处理”等业务语义；这些由包在 dataDir 自行记录。命中后通常 `sdk.return(null)`，所以 run 成功但没有通知可能是正确行为。
重新验证时要同时判断两层：业务记录是否要求先重置，平台 event_id 是否也需要新的值或按运维流程重置。不要通过删除整个 dataDir 来“碰碰运气”，只处理目标业务、目标通道、目标对象，并先备份。
以 jira-ticket-review 为例，当前记录实现为 `package/packages/review-records.ts`；pass、fail、skip 的复审规则不同，应先看实现和跳过日志，再决定操作。


_参见：`bizpkg.development.state`、`bizpkg.operations.platform-dedup`_


## 修复纪律：代码问题与数据问题分开处理

> `bizpkg.operations.change-discipline`

契约不匹配应改事件归一化、contract 或主程序，不能让 check 顺手转换数据；工具/skill 缺绑应改业务绑定，不能在代码里写死资产路径；模型输出不稳定应保留原始输出并完善解析/兜底，不能只扩大超时。
只有确认是状态污染或测试重验时才清理指定状态。任何状态重置都不替代代码修复，也不应被写成日常运行的必要步骤。
修复后用新事件完整复验，并记录触发标识、run 结果、日志证据和是否真实投递，形成可复现闭环。


_参见：`bizpkg.contract.check-discipline`、`bizpkg.integration.smoke`_
