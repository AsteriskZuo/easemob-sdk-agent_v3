<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 平台机制 · 工作区、日志与运维边界


## 业务工作区：runs、logs、data、cache 分开

> `platform.operations.workspace-layout`

业务文件统一位于 `{workspace}/businesses/{business_id}/`：
| 目录 | 内容 | 当前生命周期语义 |
| --- | --- | --- |
| `runs/{source}/{session_id}/{run_id}/` | 每 run 临时工作区、audit | 按临时数据设计；当前无自动 TTL |
| `logs/{source}/{session_id}/{run_id}.log` | SDK 与阶段 stderr 形成的业务 JSONL | 追加写；当前无自动轮转 |
| `data/{source}/{session_id}/` | 业务跨 run 状态、去重记录、游标 | 平台不做 TTL，业务自行管理 |
| `cache/agent-sessions/{source}/{session_id}/` | Pi 会话文件 | 由通道会话映射复用 |
| `cache/pi/` | 生效 models.json 派生目录与短期验证目录 | 已配置业务每次 run 原子重建；重启清理 validations |

dataDir 按 source/session_id 隔离，同业务通道串行使同目录通常无需业务自锁；不同通道不能假定串行。runs 的“临时”是数据分类，不代表平台现在已经会自动删除。


_参见：`platform.operations.file-retention`、`bizpkg.development.state`_


## 平台日志：总日志与两个循环日志

> `platform.operations.platform-logs`

平台进程写 `{workspace}/platform/logs/` 下的 JSONL：
| 文件 | 内容 |
| --- | --- |
| `system.log` | 启动、配置、资产、AgentService、console-api、更新协调器等非双循环模块 |
| `entry-loop.log` | 入口取出、匹配、挂通道、run 开始/终态与任务完结 |
| `exit-loop.log` | 出口绑定、逐目标投递、重试、完结与死信 |

每行包含 ts、level、message 和上下文字段，常用检索键是 event_id、correlation_id、business_id、channel_id、run_id、task_id、update_id。平台 log_level/log_enabled 只控制这套系统日志外观，不等于关闭业务文件日志。
追加日志会保留历史错误；判断本次故障必须限定新时间窗和本次标识，不能只搜到一个旧 error 就下结论。


_参见：`platform.operations.business-logs`、`platform.operations.failure-matrix`_


## 业务日志与模型审计：按 run 定位

> `platform.operations.business-logs`

每次 run 的业务日志位于 `businesses/{business_id}/logs/{source}/{session_id}/{run_id}.log`。SDK `sdk.log` 的结构化字段会保留，普通 stderr 作为文本日志写入；该文件采集 debug 及以上业务日志，并注册本次 secrets 做脱敏。
模型请求审计位于 `runs/{source}/{session_id}/{run_id}/audit/llm-requests.jsonl`，在 provider 请求发出前记录真实请求体；审计写盘失败会阻断该次 LLM 请求。排障时先用 lifecycle 找到 run_id，再同时看业务日志、审计和入口循环骨架：入口日志回答“是否调度”，业务日志回答“流程为何这样决策”，审计回答“平台实际向模型发送了什么”。
日志脱敏不是访问控制，审计与业务正文仍可能含工单、用户信息等敏感内容，应按生产数据管理文件权限和保留时间。


_参见：`platform.operations.platform-logs`、`bizpkg.development.logging`_


## 三种状态模型：task、run、update 不可互相推断

> `platform.operations.status-model`

| 状态对象 | 能回答什么 | 常见误读 |
| --- | --- | --- |
| 入口/出口 Task | 事件任务是否 pending/processing/done/dead | 入口 done 不等于所有 run 成功 |
| Lifecycle run | 某业务一次执行 running/success/failed/timeout | running 不一定是仍在运行，也可能是崩溃遗留 |
| UpdateCommand | 管理变更 pending/processing/done/failed | HTTP 202 accepted 不等于已经生效 |

入口任务在所有关注者都 settle 后 done，即使其中某些 run failed/timeout；业务失败默认不派生，但原任务仍正常完结。出口任务只有在全部绑定成功时 done，任一绑定失败则 dead。
排障时先用 event_id/correlation_id 找任务，再用 business_id/run_id 找 lifecycle 与业务日志；配置问题则另查 update_id。不要仅凭队列没有 dead 就认定业务全成功。


_参见：`platform.eventing.entry-pipeline`、`platform.control-plane.monitoring-api`_


## 故障定位矩阵：先看现象属于哪一层

> `platform.operations.failure-matrix`

| 现象 | 第一检查点 | 下一步 |
| --- | --- | --- |
| 外部更新但无新日志 | 入口适配器开关、完整 URL/path、token、上游响应 | 用最小 curl 区分上游未推送与平台拒绝 |
| 入口任务一直 processing | 是否进程崩溃遗留、run 是否仍在执行 | 对照进程启动时间、run 日志和恢复日志 |
| run failed/timeout | lifecycle.failed_at 与该 run 业务日志 | 按 check-input/main/check-output 分开修 |
| run success 但无通知 | output 是否 null、是否有出口绑定 | 查 exit_tasks 和 exit-loop.log |
| 下游未触发 | 是否成功或 on_failure、event_type 是否匹配 | 查派生事件、hop_limit 与下游 check-input |
| 配置返回 202 后未生效 | 更新命令是否仍等待活动 run 空闲 | 查 update_id 与 system.log，勿重复提交一串相同命令 |
| 出口 deliver_failed | 具体 tool、destination、重试次数与错误 | 修配置/网络后用新事件复验；成功目标不会回滚 |

正常业务 failed/timeout 没有平台级整 run 自动重试；崩溃恢复导致 processing 重跑是另一套 at-least-once 语义，不能混称为“失败重试”。


_参见：`bizpkg.operations.run-failure`、`platform.eventing.recovery`_


## 重启与恢复：先接受重复副作用的可能

> `platform.operations.restart-recovery`

启动顺序是解析配置与自检 → 建库和模块 → 恢复 entry/exit processing → 恢复并驱动更新队列 → 启动事件循环 → 启动适配器与 console-api。更新命令先于新事件开放补应用，避免运行中的业务绕过待生效变更。
恢复不是从内存断点续跑：被重置任务会重新匹配并创建新 run，旧 lifecycle running 行不会自动终结，派生事件和出口可能重复。重启后检查“队列崩溃恢复”日志、相同 correlation_id 的新旧 run 和外部副作用，不要只核对队列最终 done。
优雅停止会等待在飞 drain/deliver 和当前更新窗口，但不会把内存通道待消化项完整序列化。生产重启前仍应评估活动任务、下游幂等和通知重复风险。


_参见：`platform.eventing.recovery`、`platform.control-plane.update-coordinator`_


## 队列保留：有 purge 方法，没有生产清理调度

> `platform.operations.queue-retention`

TaskQueue 提供 `purge(cutoffIso)`，只删除 finished_at 早于 cutoff 的 done 行，dead/pending/processing 不删。但当前装配根没有周期调用 purge 的生产调度，也没有控制台通用清理接口，所以事件任务不会因这个方法存在就自动被保留策略消化。
清理前必须备份 platform.db，并评估 event_id 唯一约束被移除后的影响：同源旧事件再次推送可能重新入队，历史追溯也会断。不要直接清空 entry_tasks/exit_tasks 来解决重复或积压。
第一阶段死信同样没有自动消化器；dead 行是排障证据，不是会自动重投的重试队列。


_参见：`platform.eventing.queue-idempotency`、`platform.control-plane.monitoring-api`_


## 文件保留：runs TTL 与日志轮转仍是缺口

> `platform.operations.file-retention`

当前代码把 runs 注释为临时、logs 注释为可轮转，但没有对应的自动 TTL 或日志轮转调度；platform.db 的 lifecycle 记录也没有自动清理。dataDir 明确由业务自行管理，平台资产缓存只通过显式清理或版本更新重建。
因此长期运行前需要另行制定平台数据保留方案：哪些 run 目录、业务日志、审计、lifecycle、done task 可以删，保留多久，如何备份，删除后如何保持 event_id 幂等与排障证据。
在方案落地前，不要把“目录名叫临时”理解为安全自动清理，也不要用宽泛递归删除释放空间。


_参见：`platform.operations.workspace-layout`、`platform.operations.operating-discipline`_


## 删除现状：业务目录不会随业务删除自动清除

> `platform.operations.deletion-current`

`business.delete` 当前只删除 registry 中的业务、匹配行和出口绑定，不删除 `businesses/{business_id}/` 下的 runs/logs/data/cache。这样历史文件仍可用于排查，但持久业务状态和潜在敏感正文也会继续占用磁盘。
资产删除则是另一种语义：无引用时删除登记行和该资产物化缓存；业务删除不等于资产删除，也不会自动清理已登记资产。
如需彻底退役业务，应把“配置删除”和“工作区保留/归档/删除”拆成两个经确认的运维动作，先识别数据与备份，再处理明确目录；当前没有一键级联清理能力。


_参见：`platform.control-plane.asset-lifecycle`、`platform.operations.file-retention`_


## 凭据与隔离：不明文回显，不等于加密存储

> `platform.operations.secrets-security`

环境配置分 vars 与 secrets，业务级覆盖通用级；占位查询顺序为业务 secrets → 业务 vars → 全局 secrets → 全局 vars。secrets 列表只返回键名，运行时才出库进内存，业务子进程环境变量被清空，真值通过 stdin 注入并登记日志脱敏。
当前第一版 secrets **明文存储在 platform.db**，部署层必须依靠数据库和工作区文件权限保护；它不是加密保险库。日志脱敏对长度至少 8 的登记值做子串替换，也不能替代“不要打印凭据”的业务纪律。
出口 destinationOf 使用未解析的原始配置，含占位时走模板身份，避免把真值写入 channel_id 和日志。私有资产队列 payload 也只存 credential_key，应用时才从通用安全桶解析真值。


_参见：`platform.runtime.process-contract`、`platform.control-plane.pi-config-workflow`_


## 明确可用性边界：wecom-aibot 当前装配不可投递

> `platform.operations.availability-boundaries`

`wecom-aibot` 虽在出口注册表标记 `implemented: true`，但生产 `createExitRegistry()` 以无参方式创建它，没有注入必需的 `resolveSender`。因此当前实际 bind 会抛出“需要装配根注入 AibotSender 解析器”，出口重试耗尽后死信；不能把它写成可正常投递的出口。
这个例子说明 implemented 菜单标记不等于端到端可用性证明。其他出口也应以真实装配、凭据、网络和最小冒烟为准。cron/manual 入口、run 干预、自动保留、跨进程串行和业务包完整独立运行等边界分别在对应章节说明。
本文只记录现状缺口，不把修复方案伪装成已交付能力；修复后应更新本条正文和 verify，而不是保留相互矛盾的两种说法。


_参见：`platform.overview.current-boundaries`、`platform.eventing.exit-delivery`_


## 运维纪律：先证据、再备份、后做最小变更

> `platform.operations.operating-discipline`

生产排障按“确认新事件与时间窗 → 记录 event/correlation/business/run/update 标识 → 区分平台、业务、外部系统 → 只做一项最小变更 → 用新事件复验”推进。不要同时清缓存、删状态、改配置和重启，否则既扩大副作用也无法归因。
任何数据库或文件状态操作前先备份并列出精确影响范围；只处理目标业务、目标通道、目标事件。禁止用批量清空队列、整个 dataDir 或 business 工作区代替定位，尤其不能把测试重验脚本当日常运行步骤。
修复文档与代码冲突时，先以当前代码和真实冒烟确认现状，再修文档；若行为本身违反已确认设计，再另立代码修复任务。handbook 的考古结论不自动授权修改生产行为。


_参见：`bizpkg.operations.change-discipline`、`platform.operations.failure-matrix`_
