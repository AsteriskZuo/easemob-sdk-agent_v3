# 排障 Skills 规格（平台通用 + 业务自含）

> 日期：2026-11-01
> 状态：待确认
> 范围：新增两个面向排障的 agent skill（平台通用 `platform-ops`、业务自含首个实例 `jira-ticket-review-ops`）。纯文档交付，不改任何运行时代码。本文自包含，执行所需事实全部内联。

## 1. 背景与目标

2026-11-01 复查 HIM-24051 工单时，排障依赖人工记忆：要同时知道平台层事件幂等（`entry_tasks` 表 event_id UNIQUE）和业务层审查去重（`review-records.json`）两层机制，才能完成"重复验证一个已审查工单"。这类知识应该沉淀为 skill，让 agent（或人）按手册快速定位、分析、确认、复现问题。

目标：

1. 编写**通用排障 skill**（`platform-ops`）：只承载平台层知识——workspace 数据布局、事件队列与幂等语义、run 日志位置、常见故障模式决策树、平台层重置方法。对所有业务适用。
2. 编写**业务排障 skill**（首个实例 `jira-ticket-review-ops`）：只承载本业务场景的分析、验证与定位知识——审查流程锚点、去重语义、场景验证清单、业务层重置方法。放在业务自己的仓库里。
3. 两者关系：通用 skill 是入口，负责"是不是平台链路的问题"；确认平台链路正常后，按路径指引转交业务 skill 判断业务语义。

## 2. 范围与明确不做

### 做

- 新增平台仓 `.agents/skills/platform-ops/SKILL.md`。
- 新增业务仓 `business/jira-ticket-review/.agents/skills/jira-ticket-review-ops/SKILL.md`（业务仓是独立 git 仓库，文件随业务仓提交）。
- 两个 skill 的内容、编写约束、验收标准按本文执行。

### 不做

- 不建 skill 框架、注册机制或发现协议；只用 Kimi Code CLI 既有的项目级 skill 扫描目录约定。
- 不改运行时 skill 机制（资产扫描、白名单、`--skill` 注入链路全部不动）。
- 不做 debug CLI/脚本。同一串确定性操作（查库→找 run→看日志）重复满三次后再评估是否脚本化，届时另行立项。
- 不把排障 skill 注册进 `agent-package.json` 的 `requires.skills`，不让它进入业务运行时。
- 不为"未来可能的其他业务"预写业务排障 skill；jira-ticket-review 是唯一实例，兼作后续业务的编写模板。

## 3. 消费者与运行时隔离

### 3.1 消费者

两个 skill 的消费者是**开发/运维侧的人与 AI agent**（如 Kimi Code CLI），不是业务运行时执行审查的 agent。业务运行时不应加载排障知识（会污染审查行为、浪费上下文）。

### 3.2 与运行时 skill 的隔离（已核实的机制事实）

运行时 skill 解析链路（本规格引用处均已对照代码核实）：

1. 资产登记：git url + ref + subpath，物化时整仓 clone 到 `platform/cache/assets/{asset_id}/`，资产根 = 克隆内 `subpath` 目录（`packages/asset-registry/src/asset-registry.ts:312-339`）。
2. skill 资产清单：`validateSkill` 只扫描**资产根的直接子目录**，含 `SKILL.md` 者即一个技能，技能名 = 目录名（`packages/asset-registry/src/validate.ts:148-171`）。jira-ticket-review 业务的 skill 资产根 = 业务仓 `skills/` 子目录。
3. 运行时白名单：ContextLoader 取业务绑定 skill 资产清单的并集（`packages/runtime/src/context-loader.ts:128-148`），pi-runner 逐个校验请求技能名 ∈ 白名单后才 `--skill <物化路径>` 注入（`packages/agent-service/src/pi-runner.ts:128-131`）。

隔离结论：排障 skill 放在业务仓 `.agents/skills/` 下，**不在 skill 资产根（`skills/`）内**，因此：

- 不会被 `validateSkill` 扫描进资产清单；
- 不会进入运行时白名单，不可能被 `--skill` 注入审查 run；
- 会随 git clone 进入资产快照（无害冗余字节，不为此加排除机制）。

平台侧同理：平台仓 `.agents/skills/` 不是任何资产的 subpath，与运行时完全无关。

## 4. 位置与加载

### 4.1 位置（决策点 D1/D2，推荐方案如下）

| skill | 位置 | 提交仓库 |
|---|---|---|
| `platform-ops` | `.agents/skills/platform-ops/SKILL.md` | 平台仓（本仓） |
| `jira-ticket-review-ops` | `business/jira-ticket-review/.agents/skills/jira-ticket-review-ops/SKILL.md` | 业务仓（独立 git） |

依据（Kimi Code CLI 官方文档，2026-11-01 核实）：项目级 skill 扫描目录为 `.kimi-code/skills/` 与 `.agents/skills/`（项目根 = 从工作目录向上找最近的 `.git`）；目录形式要求子目录内主文件名为 `SKILL.md`，frontmatter 必须显式提供 `name` 与 `description`。选 `.agents/skills/` 因为它是跨工具通用约定（用户级 `~/.agents/skills/` 同理），不绑定单一工具。

已核实：两个仓库的 `.gitignore` 均未排除 `.agents`，文件可正常提交。

### 4.2 加载方式

- 在平台仓根工作：`platform-ops` 自动进入项目级 skill 列表，可 `/skill:platform-ops` 手动调用，或由模型按 `description`/`whenToUse` 自动调用。
- 在业务仓目录工作：`jira-ticket-review-ops` 自动可发现。
- 常见场景是从平台仓根排障某个业务：`platform-ops` 正文内置路径规则——"业务排障手册位于 `business/<业务仓>/.agents/skills/`，确认平台链路正常后按业务名查找并阅读对应 SKILL.md"。不依赖自动发现，显式按路径读取即可。

## 5. `platform-ops` 内容规格

frontmatter 要求：`name: platform-ops`；`description` 一句话点明"排查平台层事件链路问题（工单未入队/未执行/未通知）"；`whenToUse` 写清触发场景，例如"排查业务未按预期处理事件、通知未发出、需要重复验证已处理事件时"。

正文必须包含以下五节，内容要点如下（执行者按此组织，可补充但不得缺节）：

### 5.1 数据布局速查

以真实 workspace（`.easemob-agent-workspace/`，环境变量 `AGENT_WORKSPACE` 指定）为基准：

- `platform/config.json`：平台配置；`platform/data/platform.db`：唯一 SQLite 库（入口/出口任务、资产、业务、lifecycle、更新队列同库）；`platform/logs/`：平台侧日志；`platform/cache/assets/{asset_id}/`：资产物化缓存（git clone 快照，资产根 = 其内 subpath）。
- `businesses/{business_id}/`：业务级目录。`data/{source}/{session_id}/`：业务持久数据（如 jira 业务 `data/jira/HIM-XXXXX/review-records.json`）；`logs/{source}/{session_id}/run_*.log`：单次 run 业务日志（排查第一现场，开头有"临时调试：平台实际调用 Runner 的 RunRequest"完整入参）；`cache/`：业务缓存（agent-sessions、pi 等）。

### 5.2 定位流程（按事件/工单号）

1. 查入口队列：`sqlite3 .easemob-agent-workspace/platform/data/platform.db "SELECT task_id, event_id, status, enqueued_at, finished_at FROM entry_tasks WHERE event_id LIKE '%HIM-XXXXX%';"`。状态语义：`pending` 待取 / `processing` 消化中（崩溃残留会在下次启动被 recover 重置回 pending）/ `done` 完结 / `dead` 死信（有 dead_reason）。
2. 有 task 后找 run 日志：`businesses/{bid}/logs/{source}/{session_id}/run_*.log`，按时间对应 `enqueued_at`。
3. 查通知是否发出：`exit_tasks` 表同类查询（done + finished_at 即投递成功）。
4. 查 lifecycle 表确认 run 终态。

### 5.3 常见故障模式决策树

- **队列无该事件** → 轮询侧：①轮询行配置非法被跳过（平台日志有 warn："jira 轮询行配置占位键缺失"或"jira 轮询行配置非法"，见 `packages/entry-adapters/src/jira-poller.ts:192-212`）；②JQL 窗口（`updated >= -Nd`，默认 7 天）不含该工单；③轮询结果超 maxResults（10）被截断。
- **有事件但从未执行** → ①无关注者直接 complete（正常语义）；②残留 processing 未恢复；③业务配置/资产更新在 UpdateCoordinator 排队，等业务自然空闲才应用。
- **有 run 但无后续** → 读 run 日志，开头的 RunRequest 调试日志是入参第一现场；run 失败原因在日志末尾。
- **通知未收到** → 查 `exit_tasks` 是否 done；再查业务日志"通知组装完成"是否出现（没出现 = 业务侧判定不通知，转业务排障手册）。
- **资产相关** → 资产下架开关（`assets.enabled=0`）会导致绑定业务运行时 `asset_disabled` 失败；物化缓存损坏可清 `platform/cache/assets/{id}` 触发懒重建。

### 5.4 平台层复现/重置（危险操作区，须含安全警告）

事件幂等机制：poller 产出 `event_id = jira:{issueKey}:{updated}`（`packages/entry-adapters/src/jira-poller.ts:244-247`），`entry_tasks.event_id` 有 UNIQUE 约束，`enqueue` 命中已有 event_id 直接返回已有任务、不产生新行（`packages/queue/src/task-queue.ts:106-120`）。因此工单 updated 不变时，重推永远被幂等丢弃。

重复验证某事件的平台层操作（二选一）：

1. 删除幂等行：`DELETE FROM entry_tasks WHERE event_id = '<完整 event_id>';`
   - **安全纪律：只允许删 `done`/`dead` 状态的行**——删它们只失去幂等标记，下一轮轮询自然重建；**严禁删 `pending`/`processing` 行**（等于丢任务）。
2. 或在 Jira 上更新一下工单（updated 变化 → 新 event_id → 天然绕过幂等），此方式无需动库。

业务层去重的重置不属于本 skill，转业务排障手册；两层都重置后等待不超过一个轮询周期（默认 60 秒、下限 30 秒）即会重跑。

### 5.5 转交规则

平台链路四段（入队 → 派发执行 → run 完成 → 通知投递）逐段确认无异常后，剩余问题属业务语义（为何 skip、为何 pass/fail、通知内容为何如此），按 4.2 的路径规则转业务排障手册。

## 6. `jira-ticket-review-ops` 内容规格

frontmatter 要求：`name: jira-ticket-review-ops`；`description` 与运行时审查 skill（`jira-ticket-review`）明确区分，点明"排查本业务工单审查问题"；`whenToUse` 触发场景如"工单未审查/重复审查/审查结果异常/需要复审某工单时"。

### 6.1 审查流程锚点图

单轮审查编排（`business/jira-ticket-review/package/src/review-flow.ts`），每步给出日志 message 锚点，执行者按 run 日志最后一行定位断点：

1. 去重判断：命中 → 日志"跳过审查：{reason}"，无产出返回（review-flow.ts:89-94）。
2. jira-fetch 拉取：成功 → "工单拉取成功"；失败 → "获取工单失败"（96-134）。
3. 终态短路（statusCategory=Complete）：写 skip 记录，"工单已终态，跳过审查"（136-144）。
4. 非 Bug 过滤：写 skip 记录，"非 Bug 工单，忽略审查"；issueType 缺失 fail-open 继续并 warn（146-158）。
5. 人员标签："人员标签查询完成"（160-165）。
6. 大模型审查：skills=["jira-ticket-review"]，mode=fresh（167-174）。
7. 解析输出："大模型原始输出"（解析失败时的第一现场）→ "审查结果"；解析失败 → run 失败（176-192）。
8. 写审查记录（194-195）。
9. 模型判定 skip：只记录不通知（197-205）。
10. pass/fail："通知组装完成"（含 mentions），返回 wecom-webhook 消息（207-217）。

### 6.2 去重语义表

`review-records.json`（落点 `businesses/{bid}/data/jira/{ISSUE}/review-records.json`），schema：`{ "HIM-XXXXX": { "status": "pass"|"fail"|"skip", "reviewedAt": ISO, "ticketUpdatedAt"?: ISO } }`（`business/jira-ticket-review/package/src/review-records.ts:5-12`）。跳过规则（review-records.ts:45-69）：

| 记录状态 | ticketUpdatedAt | 与工单 updated 关系 | 结果 |
|---|---|---|---|
| 无记录 | — | — | 审查 |
| pass | （pass 不记录此字段） | — | 跳过 `already_passed` |
| fail/skip | 有 | 一致 | 跳过 `already_reviewed_no_changes` |
| fail/skip | 有 | 不一致（工单已更新） | 审查 |
| fail/skip | 无 | — | 审查 |

注意：`ticketUpdatedAt` 只在 fail/skip 时写入（review-records.ts:78-87）。因此手工把 pass 改成 fail 的记录天然不带 ticketUpdatedAt，必然触发重审。

### 6.3 场景验证清单

列出各路径的预期日志序列与预期产出，用于核对实际 run 是否符合预期：pass（记录 pass + 通知 @处理人）、fail（记录 fail 带 ticketUpdatedAt + 通知）、模型 skip（记录 skip、无通知）、终态短路（skip 记录、不调模型）、非 Bug（skip 记录、不调模型）、解析失败（run 失败、记录不更新）、通知 mentions 映射（`person-mapping.ts` 查表，无映射时 mentions 为空数组）。

### 6.4 业务层重置与复审标准流程

1. 业务层重置（二选一）：把 `review-records.json` 中该工单 `status` 改为 `"fail"` 并删除 `ticketUpdatedAt` 字段；或直接删除该工单 key。
2. 平台层重置：按 `platform-ops` §5.4（删 `entry_tasks` 幂等行或更新工单）。**两层缺一不可**——只改业务记录，平台幂等会拦在入队前；只删平台幂等行，业务层可能判 `already_passed` 跳过。
3. 等待不超过一个轮询周期，观察新 run 日志。
4. 验证闭环：新 run 完成 → 记录被改写（status/reviewedAt 刷新）→ `exit_tasks` 出现新 done 行（通知发出）。

参考案例（2026-11-01 实测）：HIM-24051 首轮 pass（11:30），12:47 手工改记录为 fail，12:52 删 `entry_tasks` 行，12:53:22 重新入队，12:56:00 重审完成（pass），通知 0.4 秒内投递成功。

## 7. 编写约束

1. 中文编写；frontmatter 目录形式必须显式 `name` + `description`（缺一解析失败），`type: prompt`。
2. **薄内容原则**：事实性内容指向代码锚点（`path:line`）与 `docs/`，skill 本体写判断流程和决策树，不大段复制代码。代码锚点以交付时核实为准。
3. **自审纪律**（AGENTS.md §12）：交付前对照代码核实所有表名、路径、日志消息字符串、行号。
4. 不含任何真实凭据、内网地址以外的敏感信息；示例工单号统一用 `HIM-XXXXX` 占位（参考案例节除外，那里保留真实编号 HIM-24051 作为可复核事实）。
5. SQL 默认只读（SELECT）；写操作只允许出现在"重置"节，且必须带安全纪律说明。
6. `description`/`whenToUse` 必须与运行时审查 skill 明确区分，避免模型在审查场景误调用排障 skill。

## 8. 验收标准

1. 两个 SKILL.md 按 §4.1 就位，目录形式与 frontmatter 合法：在平台仓根新开 Kimi session，skill 列表的 Project 作用域出现 `platform-ops`；在业务仓目录新开 session 出现 `jira-ticket-review-ops`。
2. 隔离验证：skill 资产清单不含排障 skill——`validateSkill` 扫描结果仍为 `["jira-ticket-review"]`（可用既有测试或控制台资产管理页确认）；业务 run 的 RunRequest 日志中 skills 上下文不含 ops skill。
3. 实战验证：任选一个已 pass 工单，仅依据两个 skill 的内容完成"确认上一轮状态 → 两层重置 → 观察重跑 → 确认记录翻转与通知投递"全流程，无需口述补充。
4. 两个仓库分别提交（平台仓一笔、业务仓一笔）。

## 9. 决策点

- **D1 通用 skill 目录**：推荐 `.agents/skills/`（跨工具通用约定）；备选 `.kimi-code/skills/`（Kimi 专属，功能等价）。
- **D2 业务 skill 位置**：推荐业务仓 `.agents/skills/`（可被 agent 自动发现 + 可被 platform-ops 按路径引用）；备选 `skills-ops/`（纯文档、放弃自动发现）。
- **D3 命名**：`platform-ops` / `jira-ticket-review-ops`。后续业务的排障 skill 命名沿用 `<业务名>-ops`。
- **D4 不抽 debug 脚本**：确定性操作序列先内联在 skill 里，重复满三次再评估脚本化。
