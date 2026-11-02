# webhook 真实接入上游：核查结论与决策记录

日期：2026-11-02

## 背景

平台此前以 `AGENT_ENTRY_JIRA_POLLING_ENABLED=true` 的轮询入口做内部测试。回到公司网络后，拟改用 webhook 入口真实接入上游转发服务（与 easemob-sdk-agent_v2 的 `forwarded` 模式同一上游、同一数据格式）。接入前完成了一轮兼容性核查与若干设计讨论，本文档固化已确认的结论、决策与任务拆分。

## 已确认的事实（核查结论）

1. 上游推送格式（v2 `forwarded` 模式同款，见 v2 `docs/refs/webhook-forwarding-format/`）：扁平 JSON object，含 `event/event_label/event_type/issue_key/issue_type/title/actor/assignee/reporter/time/url/changes`；只带 `Content-Type: application/json`，无鉴权头；任何 2xx 视为投递成功。
2. v3 webhook 入口适配器（`packages/entry-adapters/src/webhook.ts`）可直接受理该格式：`POST /hooks/{path}`、body 须为 JSON object、`session_id_key` 配 `issue_key` 可提取、`event_id_key` 留空由平台生成 ULID、响应码语义兼容（成功 200 / 失败非 2xx）。
3. 业务（jira-ticket-review）消费信封 payload 只读 `issue_key`（上游有）与 `updated`（上游无，仅有 `time`）；工单数据永远经 jira-fetch 实时拉取，审查/通知主流程不受推送格式影响。
4. 业务必须存在 `source=webhook` 的匹配行，否则事件"无关注者"丢弃（入队即完结，不产生 run）。
5. 运行模型：每次 run = 平台新拉起一个业务子进程（`packages/workflow-runner/src/runner.ts`）；并发 = `AGENT_TASK_CONCURRENCY`（默认 4）信号量 + 按 `source__session_id__business_id` 通道串行；跨 run 状态只有 `data/{source}/{session_id}/` 下文件，通道串行保证单写者。
6. 业务去重跨进程有效：去重状态持久在 `review-records.json`（实证：HIM-23902 两次 run 靠既有 pass 记录跳过），不依赖进程内存。
7. 平台三个全局日志（system/entry-loop/exit-loop.log）并发下整行交错，但单行完整性有保证（每条记录一次 `appendFileSync` 同步写 + `O_APPEND` 原子追加 + JSON.stringify 天然单行）；每行带 `ts` 与关联字段，按字段过滤排查不受影响。
8. `dataDir` 按 `(source, session_id)` 派生 → 同工单的 polling 与 webhook 各用各的去重记录，业务去重跨 source 不生效。

## 决策

### D1：否决"业务包常驻进程（daemon）"重构

- 背景：担心"3 事件 = 3 独立进程 → 业务去重失效"，提出业务包常驻、通道键改为 `source+business_id`、业务自管串并行、平台不管并发的方案。
- 结论：**否决**。动机不成立（事实 6：去重靠持久记录已跨进程有效）；该方案实质是回到 v2 常驻模型的多业务版，需重写崩溃边界、投递语义归属、per-run 超时/配额、SDK 契约四条主线，代价与收益严重不成比例。双方均不推荐此类大型重构。
- 遗留：若未来业务形态普遍需要跨事件内存态/高频低延迟，可作为可选的第二种业务运行形态另行评估，本文档备档。

### D2：polling / webhook 单开靠代码兜底，不靠操作纪律

- 规则：初始化时两者同时为 `true` → **webhook 优先**，jira-polling 抑制为不启动。
- 信号方式（用户授权决定）：**记 error 级日志、继续运行**，不采用"报错退出"。理由：①双 true 不是不可用配置，平台可确定性消解（webhook 优先），让整个平台（含 console、所有入口）为一个可消解的入口冲突拒绝启动，爆炸半径过大；②用户明确要求"优先使用 webhook"，退出语义无法实现优先级；③error 级日志在 system.log 可查，且 console `/api/config` 展示的是生效后的开关状态（抑制在 bootstrap `adapterEnabled` 计算处下手），状态可观测。
- 依据：jira-polling 的定位本就是"内部测试与无外网 webhook 场景的拉取入口"（默认关闭），webhook 是正式入口，优先级语义清晰。

### D3：业务包实现延迟合并（a+b+c）

- 目标场景：webhook 突发（created 紧跟多次 updated；上游乱序——created 晚于 update 真实发生过）。
- 改动全部在业务包（jira-ticket-review）内，平台与契约零改动：
  - a. `readPayload` 的 `updated` 取不到时回退读 `time`（与 v2 用 time 近似 updated 同语义）；
  - b. `event_type="jira:issue_created"` 的事件在 run 内睡 5 分钟再审查，**但睡前先判断：本工单已存在审查记录（含已 pass）则不睡、直接走正常流程**——有记录说明是乱序/补发的 created，延迟无意义（睡眠占住本工单通道，后续同通道事件排队等待，天然合并窗口；run 超时默认 60 分钟可容纳）；
  - c. 去重标记 `ticketUpdatedAt` 改用 jira-fetch 返回的**实时工单 `updated`**，`checkSkip` 从"相等才跳"改为"事件时间 ≤ 标记时间即跳"（睡醒/排到的旧事件被吸收；乱序的 created 到点发现自己已被覆盖 → 跳过）。
- 效果：1 created + 2 updated → 1 次审查、2 次秒跳、0 重复通知；进程/平台崩溃经 entry_tasks recover 重跑，最坏延迟变长，不丢不重。
- pass 粘性、fail/skip 放行重审的既有语义不变。

### D4：日志维持现状不改

整行交错可接受（单行完整 + 每行有时间戳与关联字段），排查按字段过滤。

### D5：业务契约化——文档先行、约定契约，机器校验后置

- 原则确认：上游输出（平台适配器 / 上游业务）= 下游输入（出口适配器 / 下游业务）；每个业务应有入口检查与出口校验；控制台应能动态配置入口数据并展示入口/出口数据格式。
- 落地分两档：**先做文档级**（业务 manifest 声明 input/output 契约文档，与适配器 eventDoc、出口 resultDoc 同构；控制台展示联动；入口检查保持代码 fail-fast、报错格式统一）；**机器校验（JSON Schema 级）后置**，等真出现第二个消费方再做，避免预测式扩展。
- 现状依据：入口适配器有 eventDoc、出口工具有 resultDoc（`packages/exit-tools/src/types.ts`）、internal 匹配已透传上游 `sdk.return` 原样但无契约声明。

### D6：webhook 接入操作项（手工，无需代码）

1. 控制台给「单轮工单审查助手」加匹配行：`source=webhook`、`event_type` 留空（通配）、`entry_config = { "path": "jira-listener", "session_id_key": "issue_key" }`；
2. 注册给上游的地址：`http://<本机内网IP>:6200/hooks/jira-listener`；
3. `AGENT_ENTRY_JIRA_POLLING_ENABLED` 改回 `false`（D2 落地后即使忘关也会被抑制并记 error）。

## 任务拆分（一个一个来）

| # | 任务 | 类型 | 依赖 |
|---|---|---|---|
| T1 | 契约化设计草稿（D5 文档级部分，docs/designs/） | 设计文档 | 无，**先行** |
| T2 | 业务包延迟合并 a+b+c（D3） | 业务包实现 + 测试 | 无（**已实现**，业务包测试 81/81 绿，待用户确认后生效于资产） |
| T3 | 入口开关互斥兜底（D2） | 平台 bootstrap 小改 + 测试 | 无 |
| T4 | webhook 真实接入验证（D6 手工项 + 排障） | 验证 | 建议 T2、T3 完成后进行（否则突发场景会刷重复通知、双入口双审） |
| T5 | 契约化实现 | 实现 | T1 草稿评审收敛后再拆 |

排序理由：T1 纯文档、无代码风险，且讨论语境最新鲜，先行沉淀；T2 是真实接入质量的关键（突发合并），T3 是配置安全网，两者都小，随后做；T4 是验收；T5 等 T1 收敛。
