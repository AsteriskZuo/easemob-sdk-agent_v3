---
name: platform-ops
description: 排查 easemob agent 平台事件链路问题（事件未入队/未执行/run 失败/通知未发出）与重复验证已处理事件的平台层定位、故障决策树与重置方法
type: prompt
whenToUse: 当需要排查业务未按预期处理事件、工单轮询成功但没有执行、通知未发出、run 失败，或需要重复验证某个已处理事件（如复审工单）时
---

# platform-ops：平台层排障手册

职责边界：只覆盖**平台链路四段**——事件入队 → 派发执行 → run 完成 → 通知投递。业务语义问题（为何跳过、为何 pass/fail、通知内容为何如此）不归本手册：确认平台链路正常后，按 `business/<业务仓>/.agents/skills/<业务名>-ops/SKILL.md` 找对应业务排障手册（已知实例：`business/jira-ticket-review/.agents/skills/jira-ticket-review-ops/SKILL.md`）。

执行排障需要 `sqlite3` CLI。

## 1. 数据布局速查

workspace 根由环境变量 `AGENT_WORKSPACE` 指定；本机开发一般是 `<平台仓>/.easemob-agent-workspace`，下文记作 `{WS}`。

| 路径                                                                 | 内容                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `{WS}/platform/config.json`                                          | 平台配置                                                                                                            |
| `{WS}/platform/data/platform.db`                                     | 全平台唯一 SQLite 库：entry_tasks / exit_tasks / assets / businesses / business_matches / lifecycles / 更新队列表等 |
| `{WS}/platform/logs/`                                                | 平台侧日志                                                                                                          |
| `{WS}/platform/cache/assets/{asset_id}/`                             | 资产物化缓存（git clone 快照；资产根 = 其内登记的 subpath）                                                         |
| `{WS}/businesses/{business_id}/data/{source}/{session_id}/`          | 业务持久数据（如 jira 业务：`data/jira/HIM-XXXXX/review-records.json`）                                             |
| `{WS}/businesses/{business_id}/logs/{source}/{session_id}/run_*.log` | 单次 run 业务日志，排查第一现场；开头有"临时调试：平台实际调用 Runner 的 RunRequest"完整入参                        |
| `{WS}/businesses/{business_id}/cache/`                               | 业务缓存（agent-sessions、pi 配置等）                                                                               |

## 2. 定位流程（按工单/事件号）

以工单 HIM-XXXXX 为例：

1. **查入口队列**：
   ```bash
   sqlite3 {WS}/platform/data/platform.db "SELECT task_id, event_id, status, enqueued_at, finished_at, dead_reason FROM entry_tasks WHERE event_id LIKE '%HIM-XXXXX%';"
   ```
   状态语义：`pending` 待取 / `processing` 消化中（崩溃残留会在下次启动被 recover 重置回 pending，`packages/queue/src/task-queue.ts:199-210`）/ `done` 完结 / `dead` 死信（看 dead_reason）。
2. **有 task 后找 run 日志**：`{WS}/businesses/{bid}/logs/jira/HIM-XXXXX/run_*.log`，按文件 mtime 对应 `enqueued_at`。
3. **查通知是否发出**：同样方式查 `exit_tasks`（`done` + `finished_at` = 投递成功）。
4. **查 run 终态**：`lifecycles` 表按 session/run 查终态与失败原因。

## 3. 常见故障模式决策树

- **队列无该事件（轮询侧）**：
  1. 轮询行配置非法被跳过——平台日志有 warn："jira 轮询行配置占位键缺失"（`{{key}}` 占位键在两桶环境配置中不存在）或"jira 轮询行配置非法"（缺 jira_url/username/password/project），见 `packages/entry-adapters/src/jira-poller.ts:192-212`；
  2. JQL 窗口（`updated >= -Nd`，days_back 默认 7）不含该工单；
  3. 轮询结果超过 maxResults=10 被截断（`packages/entry-adapters/src/jira-poller.ts:226-233`）。
- **有事件但从未执行**：
  1. 无关注者 complete——正常语义：没有业务匹配该事件时任务直接 done，不产生 run；
  2. 残留 processing——进程崩溃遗留，重启后 recover 自动重置回 pending；
  3. 业务配置/资产更新在 UpdateCoordinator 排队——等业务自然空闲才应用，等待期间的 run 仍读旧配置。
- **有 run 但无后续**：读 run 日志。开头的 RunRequest 调试日志是入参第一现场；失败原因在日志末尾。
- **通知未收到**：查 `exit_tasks` 是否 done；再查 run 日志有没有"通知组装完成"——没有 = 业务侧判定不通知（转业务排障手册）；有但 exit 失败 = 平台投递问题。
- **资产相关**：资产下架（`assets.enabled=0`）导致绑定业务运行时 `asset_disabled` 失败；物化缓存损坏可删除 `platform/cache/assets/{asset_id}/`，下次取用时懒重建（`packages/asset-registry/src/asset-registry.ts:312-339`）。

## 4. 平台层复现/重置（危险操作区）

事件幂等机制：poller 产出 `event_id = jira:{issueKey}:{updated}`（`packages/entry-adapters/src/jira-poller.ts:244-247`）；`entry_tasks.event_id` 有 UNIQUE 约束，`enqueue` 命中已有 event_id 直接返回已有任务、不产生新行（`packages/queue/src/task-queue.ts:106-120`）。**工单 updated 不变时，重推永远被幂等丢弃。**

重复验证某事件，平台层二选一：

1. **删除幂等行**：
   ```sql
   DELETE FROM entry_tasks WHERE event_id = '<完整 event_id>';
   ```
   安全纪律：**只允许删 `done` / `dead` 行**——删它们只失去幂等标记，下一轮轮询自然重建；**严禁删 `pending` / `processing` 行**（等于丢任务）。
2. **在 Jira 上更新一下工单**（updated 变化 → 新 event_id → 天然绕过幂等），无需动库。

注意：业务层可能还有自己的去重（如审查记录文件）。**两层都要重置**，业务层重置方法见业务排障手册。两层重置完成后，等待不超过一个轮询周期（默认 60 秒、下限 30 秒）即会重跑。

## 5. 转交规则

平台链路四段（入队 → 派发执行 → run 完成 → 通知投递）逐段确认无异常后，剩余问题属业务语义，转 `business/<业务仓>/.agents/skills/<业务名>-ops/SKILL.md`。该文件不存在时，直接阅读业务仓源码（入口：业务仓 `package/src/`）。
