# 问题排查手册

> 平台行为验证日期：2026-11-14
> 用法：按「症状」找到对应小节，按四段式执行（现象 → 去哪看 → 常见原因 → 修复动作）。概念层原理（去重两层模型、失败三段语义、修复纪律）不在本文重复，查 `handbook/content/bizpkg/operations.yaml` 对应条目 id。
> 总原则（handbook `bizpkg.operations.overview`）：**先定位层，再修改状态**。先拿到事件 id、业务 id、session id、run id 四个标识，再对照日志；原因未定位前不要同时改配置、清状态、重启服务。

## 0. 日志位置总表

所有路径相对**平台仓根目录**。时间注意：日志与 DB 的 `ts`/`times` 均为 **UTC**，本地北京时间 = UTC + 8。

| 日志 | 路径 | 看什么 |
|---|---|---|
| 平台系统日志 | `.easemob-agent-workspace/platform/logs/system.log` | 入口接收/轮询、队列、物化、出口投递（JSON 行：`ts`/`level`/`module`/`business_id`/`message`） |
| 平台入口循环 | `.easemob-agent-workspace/platform/logs/entry-loop.log` | 入口循环内部细节 |
| 平台出口循环 | `.easemob-agent-workspace/platform/logs/exit-loop.log` | 出口投递内部细节 |
| 业务 run 日志 | `.easemob-agent-workspace/businesses/{business_id}/logs/{source}/{session_id}/run_{run_id}.log` | 业务主流程、`sdk.log` 输出、模型原始输出、三段编排消息 |
| 定时任务日志 | `.easemob-agent-workspace/businesses/{business_id}/logs/{cron\|manual}/{任务名}/run_*.log` | warmup 等定时任务（source = cron / manual） |
| 本地 run 日志 | 终端输出会打印派生目录下的日志路径 | 本地独立运行的等价日志 |

- `{source}` 实测取值：`internal`（上游派生）/ `manual`（控制台手动）/ `cron`（定时任务）。
- run 日志关键行：`check-input 阶段通过` / `check-output 阶段通过`；secrets 在日志中打码为 `***`。
- 常用检索（在平台仓根目录执行）：

```bash
# 按 run_id 找 run 日志
find .easemob-agent-workspace/businesses -name "run_<run_id>.log"

# 平台日志按时间窗/模块过滤（UTC 时间）
grep "entry-adapter-jira" .easemob-agent-workspace/platform/logs/system.log | tail -20

# run 状态（只读查询；DB 时间为 UTC）
node --experimental-sqlite -e "const {DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync('.easemob-agent-workspace/platform/data/platform.db',{readOnly:true});\
db.prepare('select * from lifecycles order by rowid desc limit 8').all()\
.forEach(r=>console.log(JSON.stringify(r)))" 2>&1 | grep -v Warning
```

- lifecycles 表关键字段：`status`（pending/processing/success/failed…）、`failed_at`（check-input / main / check-output，失败阶段分类）、`times`（各阶段时间，UTC）。

## 1. 事件根本没产生（入口没触发）

**去哪看**：`system.log` 里有没有入口模块的记录（jira 轮询：`module=entry-adapter-jira` 的 `jira 轮询完成`；webhook：入口接收记录）。

**常见原因**：
1. 入口适配器开关没开。开关在平台配置文件 `.easemob-agent-workspace/platform/config.json`：`AGENT_ENTRY_JIRA_POLLING_ENABLED` / `AGENT_ENTRY_WEBHOOK_ENABLED`（改完需重启平台进程）。
2. （jira polling）业务的 source 匹配行（控制台入口配置）与轮询项目/过滤条件不符；或工单 `updated` 字段没变化——**同 updated 不会重复产生事件**（平台幂等，handbook `bizpkg.operations.platform-dedup`）。
3. （webhook）上游地址/match 行/token 任一不匹配。逐项排查法查 handbook `bizpkg.operations.no-event`（含 curl 直连验证与 200/400/401/404 含义）。

**修复动作**：开关类改配置重启；匹配行类改控制台入口配置；用 curl（webhook）或等下一个轮询周期（polling）复验。

## 2. 事件入队了但没有 run

**去哪看**：lifecycles 表该 event_id 的状态停留在 pending？platform 层队列细节。

**说明**：这已进入平台调度层，不属于业务包代码问题。排查决策树在平台运维 skill：`.agents/skills/platform-ops/SKILL.md`（平台维护者工具）。业务开发者到这里停下，把 event_id 交给平台维护者。

## 3. run 一直处于 running，后面的 run 都完成了

**去哪看**：该 run 的 run 日志尾部（路径按总表模板）；`system.log` 同时段有无异常。

**常见原因**：
1. run 日志尾部停在某个 `sdk.agent` / `sdk.run` 调用——大模型或工具调用挂起，等超时（quota.timeout_minutes）后才会 failed。
2. 主程序里有未按预期 resolve 的异步等待（如等待子进程/网络响应无超时兜底）。

**修复动作**：确认日志最后一行停在什么动作；属业务代码问题的修代码 + 资产「更新」到新 commit 后重试；只是慢则等超时收尾。不要手动把 lifecycles 状态改成 success——那不是真实结果。

## 4. 入口拦截：run 失败，failed_at=check-input

**去哪看**：run 日志里 check-input 阶段的失败消息（契约校验输出，格式 `validation_failed: <原因>`）；对照导出的原始事件。

**常见原因**：
1. 事件 payload 缺 contract.input 声明的必填字段，或类型不符。
2. 导出事件后被人手工改过字段（回放测试常见）。
3. 自写的 check-input 做了平台纪律禁止的事（副作用、数据转换）——见 handbook `bizpkg.contract.check-discipline`。

**修复动作**：按契约修事件来源或 contract.json（改契约 = 改契约双方，上下游一起评估）；main 里做宽容读兜底属业务自由，但不替代入口闸门。

## 5. 出口拦截：run 失败，failed_at=check-output

**去哪看**：run 日志 `check-output` 阶段输出 vs `contract.json` 的 output.fields。

**常见原因**：main `sdk.return` 的值缺字段/类型不符；`return(null)` 的语义用错（null 是「无产出」逃生门，见 handbook `bizpkg.contract.null-semantics`，不是「产出为空对象」）。

**修复动作**：修 main 的产出组装，使输出符合契约。

## 6. 通知没发出 / 企业微信内容被截断

**去哪看**：`exit-loop.log` 与 `system.log` 该时段的出口投递记录；run 日志里业务「通知组装」类日志确认业务侧确实产出了通知内容。

**常见原因**：
1. 业务 `return(null)`（去重命中、过滤跳过）——**这是正确行为**，不是故障（handbook `bizpkg.operations.business-dedup`）。
2. 出口绑定没配 / `wecom_key` 类配置缺失。
3. 企微内容被截断：平台出口对企微 webhook 有单条 **4096 字节硬上限**（企微自身限制），超出截断并加 `…(被截断)` 后缀——**这是必要保护行为，不是 bug**；全文以 run 日志为准。

**修复动作**：原因 1 无需处理（要复审按业务去重规则重置对应记录，两层状态分别处理）；原因 2 补出口绑定；原因 3 业务侧收敛通知正文的冗余内容（如约束大模型 summary 长度）。

## 7. 上游成功但下游没触发（internal 派生没发生）

**去哪看**：上游 run 是否真的 success（不是 failed）；`system.log` 有无派生日志；lifecycles 里找 `event_type = "<上游business_id>.completed"` 的新事件。

**常见原因**：
1. 上游 check-output 未通过（表面「处理了」实则 failed）。
2. 下游业务的入口关注配置没匹配该 event_type（控制台入口配置）。
3. 下游入口被过滤（下游 check-input 拦了，见症状 4——按平台公平原则，过滤是下游自己的职责）。

**修复动作**：逐层确认上游 run 结果 → 事件是否派生 → 下游是否入队 → 下游 run 结果。

## 8. 日志分析选仓失败：通知标注 platform_unknown

**去哪看**：run 日志里选仓阶段日志；工单标题与日志附件前 64KB 内容。

**原因**：登记表（`package/repos.json`）所有条目的 `match` 关键词都没命中。

**修复动作**：在登记表对应仓条目的 `match` 数组补关键词（保持「越具体的仓越靠前」的数组顺序纪律），提交后资产「更新」到新 ref。

## 9. warmup 单仓/全部失败

**去哪看**：定时任务日志 `.easemob-agent-workspace/businesses/{bid}/logs/{cron|manual}/warmup/run_*.log`（逐仓「开始仓预热」「仓预热完成」进度条数 = 成功数）。

**常见原因**：网络瞬断（实测出现过全仓 `SSL_ERROR_SYSCALL`，稍后自行恢复）；单仓体积大首次克隆慢（实测大仓 4 分钟+属正常，非故障）；私有仓凭据缺失。

**修复动作**：单仓失败 warn 不阻断其他仓；网络类稍后重试（控制台「立即执行」）；凭据类查 `environment.md` §4。

## 10. 资产物化失败 / 业务编辑页「入口程序」下拉为空

**去哪看**：绑定/更新操作的同步报错；平台日志物化阶段。

**常见原因**：物化六阶段逐项清单查 handbook `bizpkg.operations.materialization-failure`（仓库不可访问、subpath 错、清单/contract 缺失、lockfile 未提交、产物未构建）。**已踩过的坑**：package 资产 subpath 漏填 → 资产根 = 仓库根 → 找不到 `agent-package.json` → 入口程序下拉为空。

**修复动作**：按清单逐项修；本地用相同 Node 版本跑六条检查可预排除大部分问题（但本地成功不替代平台验收）。

## 11. local-run 报「配置字段非法」

**去哪看**：报错信息本身——格式 `配置字段 <字段路径> 非法：<原因>`，直接指到字段。

**常见原因**（均已实测）：
1. `secrets` 写了字符串而非对象（键值必须都是字符串的对象）。
2. `assets.package.path` 目录内缺 `agent-package.json`（路径指错层级，或业务包没构建）。
3. `entry_program` 在包清单 `programs` 中不存在；或 programs 指向的 `.js` 产物不存在（业务包改了代码没 `npm run build`）。

**修复动作**：按字段路径逐个修；字段全表与取值来源见 `environment.md` §1。

## 12. 改了代码，平台行为没变

**去哪看**：控制台资产 ref 钉的 commit；`git log` 你的修复 commit 是否已推送。

**常见原因**：
1. 资产 ref 没「更新」——平台跑的还是旧 commit（本地未推送的 commit 平台根本拉不到）。
2. 控制台页面缓存/业务绑定未重绑——强刷或重新绑定。
3. dev server 没重启（控制台/平台进程类改动）。

**修复动作**：确认「资产 ref → 已推送 commit → 平台物化缓存」三者一致后再验。

## 13. 平台层深度问题（本文不展开）

队列积压、调度异常、出口投递内部失败、崩溃恢复语义等，属于平台层：找平台维护者，决策树见 `.agents/skills/platform-ops/SKILL.md`。业务开发者的排查边界是：业务 run 日志 + 控制台配置 + 本文症状 1/4/5/6/7；再往下就该上报，不要自行重置平台状态。
