<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 平台机制 · 事件、通道与结果扇出


## 统一信封：标识实例、类别、会话与派生链

> `platform.eventing.envelope`

`EventEnvelope` 当前 `contract_version` 恒为 `v1`。核心字段分工如下：
| 字段 | 语义 |
| --- | --- |
| `event_id` | 每次事件实例的唯一标识，也是单张队列表内的幂等键 |
| `event_type` | 类别标签，业务 match 行按它订阅；不是实例 id |
| `source` | 事件来源；业务产出派生后固定为 `internal` |
| `session_id` | 源生会话标识，平台视为不透明字符串 |
| `correlation_id` | 派生链首个事件的 event_id，用于全链检索 |
| `hop_count` | 派生跳数，源生事件从 0 开始 |
| `payload` | 来源自定义输入，或上游业务产出 |
| `producer_business_id` | internal 事件的产出方业务，出口据此找绑定 |

入队前做结构、类型和取值域校验，不识别字段会被忽略。业务语义是否正确不在信封校验职责内。


_参见：`bizpkg.contract.envelope`、`platform.eventing.derivation`_


## 关注者匹配：多业务并行，多入口并存

> `platform.eventing.subscriptions`

一个业务可有多条 match 行，每行由 `source + event_type + entry_config` 描述关注方式。入口循环同时查询精确 `event_type` 和该 source 下 `event_type=""` 的通配行；同一 `(business_id, source, event_type)` 不重复添加。
一个事件命中多个业务时，平台为每个关注者分别挂入业务通道，未来产生独立 run；这些通道之间可以并行。匹配关系没有 `order` 或 `depends_on` 字段，执行先后只能通过关注上游产出事件来表达。
无关注者的入口任务直接 `done`，日志记录“无关注者，事件丢弃”，这不是死信。


_参见：`platform.eventing.channel`、`platform.eventing.derivation`_


## 队列与幂等：event_id 的唯一约束按表生效

> `platform.eventing.queue-idempotency`

入口和出口分别使用 `entry_tasks`、`exit_tasks`。每行任务有独立 `task_id`，状态为 `pending → processing → done/dead`；`take()` 按入队时间 FIFO 取出并在事务内改为 processing。
每张表对 `event_id` 有 UNIQUE 约束：同表再次 enqueue 相同 id 只返回既有任务，不新增行，也不把 done/dead 重置为 pending。它防止的是**同表重复接收**，不是跨业务、跨派生链、跨外部系统的端到端 exactly-once。
崩溃恢复会重新执行已有 processing 任务；恢复执行派生事件时又会生成新的 event_id。因此“没有重复队列行”不等于“没有重复业务副作用”。


_参见：`platform.eventing.recovery`、`bizpkg.operations.platform-dedup`_


## 通道串行：同会话同业务串行，其余组合并行

> `platform.eventing.channel`

业务通道键是 `source__session_id__business_id`；只有三维都相同才进入同一串行通道。不同业务、不同源会话或不同 source 都可并行。出口通道键是 `exit__destination_id`，只按投递目标串行。
通道对象在单进程 ChannelPool 内维护 FIFO 待消化项，同一时刻最多一个 drain。通道标识和最后活跃时间会写 SQLite，但**待消化数组不持久化**；该串行保证也不跨多个平台进程或主机。
`session_id` 应由入口提取真实源生标识，例如 Jira 工单 key。若粗粒度取成仓库 id，会把本可并行的多个 PR 或工单错误串行，并共享不该共享的通道会话。


_参见：`platform.eventing.subscriptions`、`platform.runtime.agent-sessions-quota`_


## 入口执行链：从 take 到 settle

> `platform.eventing.entry-pipeline`

```text
queue.take
  → registry.match
  → 按关注者 buildBusinessChannelId
  → channel.enqueue / drain
  → 等待更新屏障
  → 获取 task_concurrency 名额
  → Lifecycle.execute
  → 按结果派生并扇出
  → 释放名额并 settle
```
一个任务的内存 pending 计数等于关注者数，所有关注者都结算后原入口任务才 `done`。业务返回 failed/timeout 或执行抛出基础设施异常，都会形成该关注者的执行结果并继续 settle；**业务失败通常仍使原入口任务 done，不会因此自动变成 dead 或整 run 重试**。
dispatch 阶段的意外异常会使任务 `dead(dispatch_error)`。优雅停止会等待在飞 drain，不主动打断正在执行的 run。


_参见：`platform.runtime.run-lifecycle`、`platform.operations.status-model`_


## 派生事件：用产出类型表达处理链依赖

> `platform.eventing.derivation`

run 成功，或业务配置 `on_failure=true` 时，入口循环构造新的 internal 事件：生成新 event_id，继承 `session_id` 与 `correlation_id`，`hop_count + 1`，写入 `producer_business_id`。
成功事件的类型是 `${business_id}.completed`，payload 原样承载 output；failed/timeout 在允许派生时类型是 `${business_id}.failed`，payload 为 `{ status, output }`。下游通过 source=`internal` 和对应 event_type 订阅，多重依赖应关注最后一段产出。
`output=null` 仍会派生给下游，表示“本次明确无产出”；下游 check/main 必须自行决定是否接受。失败且未开启 on_failure 时不派生，下游因此自然不触发。


_参见：`bizpkg.contract.output-consumer`、`platform.eventing.exit-delivery`_


## 结果扇出：同时面向下游业务与出口，但非原子双写

> `platform.eventing.fanout-atomicity`

同一个派生事件会分别 enqueue 到入口队列和出口队列：前者供下游业务订阅，后者供产出方自己的出口绑定消费。两个队列的 event_id 幂等互不影响。
当前实现先写入 `entry_tasks`，再写入 `exit_tasks`，**两次写入没有跨队事务**。若进程在两次写入之间崩溃，重启后可能只保留下游事件而缺出口任务，或在恢复重跑后形成另一组派生事件。排查“下游执行了但没投递”时，应同时核对两队任务和同一时间窗日志，不能假定它们必然成对出现。


_参见：`platform.eventing.recovery`、`platform.eventing.hop-limit`_


## 出口投递：按产出方找绑定，按目标串行重试

> `platform.eventing.exit-delivery`

出口循环只接受带 `producer_business_id` 的派生事件。payload=null 时直接 done，不查绑定、不投递；无出口绑定时也直接 done。存在多个绑定则分别投递，同一 `destination_id` 在一个出口通道内串行。
默认每个绑定最多尝试 3 次（含首次），指数退避从 1 秒开始、10 秒封顶。任一绑定最终失败会使整个出口任务 `dead(deliver_failed)`；已经成功投递的目标不会回滚。
ExitDriver 只把 **payload** 传给出口工具，不自动传完整信封或 event_id。需要外部接收方去重时，必须由业务把稳定标识放进 output；不能假设出口工具能读取信封 event_id。


_参见：`platform.eventing.derivation`、`platform.operations.failure-matrix`_


## hop 超限：下一跳留痕死信，上游正常完结

> `platform.eventing.hop-limit`

平台在**产生下一跳时**检查 `next.hop_count > hop_limit`，而不是在执行当前任务前拒绝。超限派生事件仍分别写入入口和出口队列留痕，随后两行立即标为 `dead(hop_limit)`，不会再被消费。
当前上游 run 和原入口任务仍按自身结果正常 settle，不会因为下一跳超限自动变成 failed。第一阶段没有死信自动消化器，排查循环订阅时要从 correlation_id 和 hop_limit 死信反向还原处理链。


_参见：`platform.eventing.fanout-atomicity`、`platform.operations.failure-matrix`_


## 崩溃恢复：at-least-once，可能重复执行和重复投递

> `platform.eventing.recovery`

启动时两条事件队列都把残留 processing 重置为 pending，随后重新匹配关注者并执行。通道内待消化项和剩余关注者计数不恢复，而是从持久化任务重新建立。
重跑会产生新的 run_id；旧 lifecycle 行可能一直停在 running，平台不会在启动时统一终结它。恢复执行若再次成功，会生成新的派生 event_id，外部通知、下游业务和出口投递都可能重复。
因此平台整体语义是 **at-least-once**：event_id 唯一约束只减少同源重推，业务仍需对工单状态、通知和外部写入做幂等或去重。不要把重启当作无副作用操作。


_参见：`platform.eventing.queue-idempotency`、`platform.operations.restart-recovery`_


## 实际入口：通用 webhook 与 Jira 轮询

> `platform.eventing.adapters`

`webhook` 是通用推送入口，一个适配器可承载多条 path；默认监听 6200，接收 `POST /hooks/{path}`，body 必须为 JSON object。match 行必须提供全平台唯一的 path 和可提取非空字符串的 `session_id_key`；event_id_key 可缺省，此时平台生成新 id，不能靠它去重重推。
`jira-polling` 的适配器 id 是 jira-polling，但信封 source 是 `jira`；它按 match 行维护独立轮询器，默认关闭。webhook 与 jira-polling 同时启用时，装配根会抑制 jira-polling 并记录 error，以 webhook 优先。
入口开关由启动配置决定，不是业务 match 行保存的开关；修改后需要重启平台进程。


_参见：`bizpkg.integration.entry-exit`、`platform.control-plane.startup-config`_
