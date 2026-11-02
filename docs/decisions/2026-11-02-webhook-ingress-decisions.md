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

> **修订（2026-11-02 下午）**："文档级先行"被 D7 升级取代——契约载体从 markdown 文档（CONTRACT.md 方案）改为机读的 `contract.json`，存在性强制提前（物化 + 绑定双闸），"最小声明式校验（存在 + 类型）"随之提前；完整内容级机验（JSON Schema）仍后置，重启条件不变。D5 的原则本身（上游输出 = 下游输入、入口检查/出口校验必有、控制台可见）不变并被强化。

### D6：webhook 接入操作项（手工，无需代码）

1. 控制台给「单轮工单审查助手」加匹配行：`source=webhook`、`event_type` 留空（通配）、`entry_config = { "path": "jira-listener", "session_id_key": "issue_key" }`；
2. 注册给上游的地址：`http://<本机内网IP>:6200/hooks/jira-listener`；
3. `AGENT_ENTRY_JIRA_POLLING_ENABLED` 改回 `false`（D2 落地后即使忘关也会被抑制并记 error）。

### D7：业务契约结构强制——contract.json + 三段式程序编排（2026-11-02 下午讨论收敛，部分取代 D5）

- 背景：D5 评审中用户提出升级——入口检查/出口校验从"约定（可能忘）"升级为"结构（不实现就跑不起来）"；调用归属 = 平台定规则、统一调用，业务负责实现；同时复盘工程复杂度（第一版未上线，共享设施超前但保留），模板按"前置检查 / 主流程 / 后置校验"三大块做文件夹管理。
- 决策：
  1. **包结构** = `apps/`（可执行程序：`main`、`check-input`、`check-output`、包内工具）+ `packages/`（库代码，含通用契约校验器）+ 资产根 `contract.json`（唯一事实源，机读）；
  2. **三段编排**：runner 一次 run 内依次执行 check-input → main → check-output；check 阶段**最小注入**（无 secrets/endpoint/programs/dataDir，结构性落实纯校验纪律）；check-output 注入 main 产出（`StdinEnvelope` 增可选 `output` 字段）；check-output 失败 = 产出不扇出；
  3. **check 程序 = 通用校验器**（解释 contract.json：required 项查存在 + 类型，可选不查）+ 逃生门（业务可自写替换）；**check 只判过/不过、不做转换**，解析归 main；
  4. **取消 usage 方法**：平台物化时直接读 contract.json（文件即说明，零运行成本、无版本漂移）；
  5. **双闸强制**：物化校验 contract.json 存在且形状合法 + `programs` 含两个保留程序名；控制台绑定缺项即拒绝；旧 pin 资产缺 check 程序时 runner 跳过对应阶段（迁移兼容）；
  6. **失败分类结构化**：`RunOutcome` 增 `failed_at`（check-input / main / check-output）；当日上午统一的报错前缀约定（「入口检查未通过：/ 出口校验未通过：」）**退役**，不再承担分类职责；
  7. **显式空声明**：contract.json 的 input/output 可显式 `null`；`output: null` 时产出必须真为 null，否则出口校验失败；
  8. **出口呈现原则**：业务产出 = 语义形状，呈现归出口侧；呈现下沉的重启条件 = 结构化下游首次启用或第二个异格式出口出现，届时首选"格式化业务"（组合解法，零新机制）；mentions 的 userid 映射是运营数据，走绑定配置/环境变量，不进业务代码。
- 完整设计（contract.json schema、编排阶段表、控制台联动、迁移与落地拆分）见 `docs/designs/2026-11-02-business-io-contract.md`。

### D8：契约化细化决策——拷问（grilling）两轮 15 问全部按推荐接受（2026-11-02 晚）

- 背景：D7 设计稿的用户评审以拷问方式进行，两轮共 15 问全部按推荐答案接受、无一修改；另采纳用户补充一条（契约内容较多时控制台用右侧抽屉展示，参考 pi 配置的 `PiProviderHelpDrawer` 模式）。设计文档 `docs/designs/2026-11-02-business-io-contract.md` 已按终稿同步，本节仅记结论索引。
- **契约 schema**：
  1. v1 词表冻结：`string / number / boolean / object / array / T[]`；校验 = required 项存在 + 类型（`T[]` 递归校验元素，`object`/`array` 不深入内部形状）；枚举/范围/正则/嵌套深入/条件必填一律不支持 → 逃生门或 main 自判；
  2. contract.json 顶层必含 `"version": 1`，物化闸拒绝未知版本（schema 演进的唯一通道）；
  3. input 契约 path 允许从信封根声明（含 `type`/`id`/`timestamp` 等顶层字段，不只 `payload.*`）；条件必填（create/update 不同必填集）仍不支持；
- **校验器与 SDK**：
  4. 通用校验器内置 SDK（`loadContract` / `checkFields` / 类型导出），模板 check 程序为薄壳、不逐包复制；SDK 随波次 1 发 0.3.0（additive：`RunInput.output` + 校验器导出）；
- **null 语义（非对称）**：
  5. `input: null` → runner 跳过 check-input 阶段（记 skip 日志）；`output: null` → check-output 仍执行，stdout 结果行 `output` 键缺失或值为 null 均视为空产出（已核实 SDK 无参 return 时 JSON 序列化丢弃 undefined 键），否则出口校验失败；
- **check 纪律**：
  6. 逃生门同约束：最小注入（无 secrets/endpoint/programs/dataDir）、仅 node 运行时、60s 固定超时、纯本地判定；需联网/查库/调上游的检查归 main；
  7. check 程序对 workspace 只读（文档约定，平台不强制隔离）；
- **控制台**：
  8. v1 只读展示契约 + 绑定闸；契约编辑走业务仓 git；不做在线编辑/模拟试跑；
  9. 绑定界面上下游契约只并排展示、不自动校验匹配；
  10. run 详情最小呈现：失败时 `failed_at` 阶段徽标 + reason 截断；成功 run 无阶段信息；不做三段时间线/耗时；
  11. 契约展示复用 `PiProviderHelpDrawer` 右侧抽屉模式：资产详情「查看契约」抽屉（入口/出口两节 = 字段表 + 原始 JSON + 复制按钮）；业务编辑页「查看上下游契约」抽屉（上游 output vs 本业务 input 上下两节）；
- **迁移与兼容**：
  12. 旧资产软迁移：无硬截止；控制台「待迁移」标记；重钉触发重新物化即过物化闸；
  13. T5d 迁移窗口接受 in-flight run 小概率失败（低峰操作 + 业务幂等可重跑）；
- **出口呈现**：
  14. 格式化业务维持纯文档约定，v1 不实现示例代码；触发条件不变（D7 第 8 条）；
- **波次计划**：
  15. 波次 1 = T3 + T5a（含 SDK 0.3.0）；波次 2 = T5b + T5d（既定同波次）；波次 3 = T5c；波次 4 = T6 文档收尾；T4 完整验证在波次 2 后（波次 1 后可冒烟）。

## 任务拆分（一个一个来；波次计划 = D8 第 15 条）

| # | 任务 | 类型 | 波次/依赖 |
|---|---|---|---|
| T1 | 契约化设计草稿 | 设计文档 | **已完成并确认**（拷问两轮 15 问全部接受，D8） |
| T2 | 业务包延迟合并 a+b+c（D3） | 业务包实现 + 测试 | 无（**已实现**，业务包测试 81/81 绿，待 push + 资产重钉生效） |
| T3 | 入口开关互斥兜底（D2） | 平台 bootstrap 小改 + 测试 | **波次 1**（无依赖，小改搭车） |
| T5a | 模板重构：apps/packages 布局 + contract.json + 三程序薄壳；SDK 0.3.0 additive 发版（`RunInput.output` + 校验器导出）（D7/D8） | 模板 + sdk + 测试 | **波次 1**（T1 已确认） |
| T5b | 平台编排与闸口：runner 三段式 + failed_at + 最小注入 + output 注入 + null 跳过；asset-registry 物化闸（含 version 校验）（D7/D8） | 平台实现 + 测试 | **波次 2**（依赖 T5a） |
| T5d | jira-ticket-review 迁移：拆结构 + 补 contract.json + 资产重钉（D7） | 业务仓 | **波次 2**（与 T5b 同波次，否则闸口拦既有业务） |
| T5c | 控制台联动：资产详情带 contract + ContractDrawer 抽屉 + 绑定闸 + run 详情 failed_at 徽标（D8） | console-api + console | **波次 3**（依赖 T5b） |
| T6 | 文档收尾：business-workflow.md / asset-model.md 等基础设计文档对齐新架构 + docs/README.md 目录名修正 | 文档 | **波次 4**（依赖 T5c） |
| T4 | webhook 真实接入验证（D6 手工项 + 排障） | 验证 | **完整验证在波次 2 后**（验证新结构业务包）；波次 1 后可随时冒烟（依赖 T2 push + 资产重钉 + D6 手工项） |

注：2026-11-02 上午对模板做的报错前缀统一（入口检查未通过：/ 出口校验未通过：）被 D7 第 6 条取代，模板将按 T5a 整体重构为三程序形态。
