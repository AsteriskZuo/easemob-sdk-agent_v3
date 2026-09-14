# 迁移评估调研报告：easemob-sdk-agent → 声网 aPaaS 调查助手

- 日期：2026-09-01
- 调研人：agent（基于三份平台文档全文 + 本项目代码全量盘点）
- 状态：调研结论，待与声网平台方确认开放问题

## 1. 背景与目的

本项目（easemob-sdk-agent）是自研的 Jira 工单审查自动化工具，具备完整能力：Jira 事件监听（webhook/转发/轮询三种触发）、工单信息充分性审查（15 个场景标准）、企业微信会话处理与通知（webhook 群机器人 @成员）、Jira 工具集（创建工单、读取、评论、附件）、MCP server、质量评测等。

目标：评估将该项目的核心能力迁移到声网（Agora）内部的 "aPaaS 调查助手" 平台（`https://apaas-agent-sh2.agoralab.co`），避免重复造轮子。环信与声网是合作关系，但两家公司基础设施独立。

调研依据：

- 平台文档：`/guide`（用户指南）、`/config-guide`（团队 Owner 配置指南）、`/config-guide/ai.md`（Console API 配置手册，约 9.5 万字节全文）
- 本项目代码与配置全量盘点（`src/`、`.agents/`、`.easemob-agent/config.json`、`docs/configuration.md`）

## 2. 平台是什么（一句话）

声网内部托管的**多租户 AI 调查平台**：企微（工作台应用 / 智能机器人）+ Jira Filter 定时筛查作为入口，由 Codex Agent 结合团队 Prompt/Skill/代码库/内部系统做调查定位，产出 HTML 报告并受控回写 Jira（评论/附件/状态流转/Label），带定位率统计和 Skill 自我进化闭环。

## 3. 用户提出的问题的核证结论

### 3.1 Jira / Confluence base-url 不可配 —— 确认，是硬性阻断项

**事实（文档明确）**：管理员 YAML 模板的 `atlassian` 段只有三个产品的 `auth_mode / username / secret`，没有任何地址字段。ai.md 6.1 节原文：

> 三个产品地址和机器人 OAuth 由平台固定，以下请求正文出现 `baseUrl`、`url`、`gatewayAccessToken`、OAuth Client/Username/Password 等平台字段会被拒绝。

Bitbucket 基址进一步写死为 `https://bitbucket.agoralab.co`（旧基址在 LB 层直接 502）。

**影响**：平台的 Jira/Confluence 客户端指向**声网内网实例**（`jira.agoralab.co` / `confluence.agoralab.co`），环信的 `j1.private.easemob.com` / `c1.private.easemob.com` 在当前架构下**完全无法接入**。这不是配置缺失，是架构假设——平台假定所有租户共用声网内部 Atlassian。

### 3.2 Jira webhook URL 不可配 —— 问题不成立，但有更深的问题

**事实**：三份文档**完全没有 Jira webhook 概念**。平台的 Jira 触发只有一种模式：服务端按团队 Filter（JQL + Cron + 时区）定时/手动筛查；工单关闭检测也是服务端轮询扫描（"扫描到 Jira issue 首次进入关闭状态时……"）。文档中唯一的 webhook 是 **Bitbucket webhook**（用于 Skill 仓库同步）。

**影响**：本项目是事件驱动架构（默认 webhook 模式，`POST /jira/webhook` 接收 `jira:issue_created/updated`，还有新建工单 5 分钟延迟队列、负责人过滤、去重等）。迁移后触发模型变为 **JQL 定时筛查**，实时性、触发语义（事件 vs 状态扫描）都需要重新设计审查逻辑。审查"新建工单"场景要靠 JQL（如 `created >= -10m`）近似，延迟队列这类精细控制消失。

### 3.3 重定向账户（网关认证）不支持 —— 确认，且认证方式差异比预想更大

**事实**：平台 Jira 认证**仅支持 Basic Username/Password**（原文："Jira：Basic Username/Password，沿用现有配置、连接测试和定时筛查链路"），不支持 PAT/OAuth，无任何网关/代理认证字段。

**本项目现状**：环信 Jira 的认证是非标准的两层结构——

1. 前置网关 Basic Auth（`TOOL__JIRA__REDIRECT_USERNAME/PASSWORD`，每个请求带 `Authorization: Basic` 头，`src/jira/jira-client.ts:494-504`）；
2. Jira 自身**表单登录 + Cookie 会话**（`login.jsp` → `os_username/os_password` → 手动跟随重定向，`src/jira/jira-client.ts:365-440`），不是标准的 Basic REST 认证。

**影响**：即使地址问题解决了，平台的标准 Basic 认证客户端**大概率无法通过环信 Jira 的网关 + 表单登录**。需要平台方支持自定义认证链路，或环信侧为平台开放一个标准 Basic/PAT 可直连的入口。

### 3.4 Bitbucket vs GitHub —— 确认平台深度绑定 Bitbucket，但对本项目影响不大

**事实**：平台深度绑定 Bitbucket（REST 基址写死、Bitbucket webhook、Skill 进化 PR 对账都走 Bitbucket）；GitHub/GitLab **全文未提及**。通用 Git 层面支持任意 SSH 仓库，但 **host 必须在平台出站白名单内**（错误码 `host_not_allowlisted`）。

**本项目现状**：**当前项目没有使用任何代码仓库集成**（`src/` 与 skills 中无 GitHub/Bitbucket 引用；Docker 装 git 仅为 Codex CLI 运行环境）。所以"环信用 GitHub 私有仓库"对本项目迁移**不构成阻断**。

**注意点**：如果未来想利用平台的"代码仓库调查"能力读环信 GitHub 私有仓库，需要：平台白名单放行 `github.com` + 平台 SSH 公钥加为 GitHub deploy key（只读）——可行但依赖平台方操作；而 Bitbucket 专属能力（Skill 进化 PR、webhook 对账）在 GitHub 下不可用。

### 3.5 企微 webhook 群机器人（@功能）—— 确认不支持，@能力存疑

**事实**（文档明确）：平台只支持两种企微接入——工作台自建应用（Corp ID + 回调）和**智能机器人（API 模式，WebSocket 长连接）**。原文："普通 Webhook 机器人和自建应用 Secret 不能代替 API 模式机器人凭证。"即**仅推送的 webhook 群机器人不是可用入口**。

机器人**出站主动 @成员**的能力：三份文档完全没有提及（只写了用户 @机器人触发）。

**本项目现状**：审查结果通知首选 webhook 群机器人，`msgtype=text` + `mentioned_list` 实现 @负责人/创建者（`src/adapters/wecom-webhook-url-notification.ts:19-21`），pass @负责人、fail @创建者（`src/observers/review-notification-observer.ts`）。用户→企微 userid 靠 43 条手工映射 + 拼音猜测。

**影响**：迁移后通知必须走平台智能机器人通道，**@成员能力是否存在需要向平台方确认**（这是审查结果触达责任人的关键交互）。好消息是：平台的会话入口（智能机器人私聊/群聊、命令路由）与本项目的企微会话处理（`src/adapters/wecom-adapter.ts`，同为 aibot WebSocket 长连接）形态一致，业务 Prompt 可以平移。

### 3.6 版本不一致的兼容性风险 —— 成立，且不可自行消化

版本事实（用户提供）：环信 Confluence 5.8.10 vs 声网 6.12.4；环信 Jira 6.3.6（2014 年代）vs 声网版本未知。

关键机制问题：**平台的所有 Jira/Confluence 操作都在平台服务端代码里**（"Jira 定时筛查、手动 Filter、评论、报告和状态流转仍使用现有服务端 Jira Client"，ai.md 6.1），团队不可见、不可改、不能通过自己的 Skill/MCP 替代平台的写链路（平台无 MCP 机制，见 4.3）。写链路很长：JQL 筛查、`【Agent定位 - 结论】` 评论、HTML 报告附件上传、状态流转、`agent_resolved/unresolved/unreviewed` Label、关闭回读判定。

兼容性陷阱：平台的连接测试**只做只读 GET**（"连接测试只执行只读 GET，不创建页面、仓库、PR、评论或附件"），**测试通过 ≠ 写操作兼容**。Jira 6.3.6 的 REST API v2 与现代版本在附件上传、流转、Label 等端点行为上有差异风险，必须以真实写操作逐项验证。

## 4. 用户未提及、但盘点后发现的迁移差距

### 4.1 业务流程错位（最重要）

两边不是同一件事：

- **本项目**：审查工单**信息充分性**（pass/fail/skip，15 个场景标准，`.agents/skills/jira-ticket-review/SKILL.md` + `src/agent/review-scenarios.ts`），**刻意不写回 Jira**（prompt 明确禁止加评论），结果出口是企微通知 + 下游 webhook 订阅 + 本地记录。
- **平台**：调查**定位根因**，产出 `JIRA_TRIAGE_META` 机器协议结论 + HTML 报告 + 受控回写 Jira，做定位率闭环统计。

平台的机器协议层（`JIRA_TRIAGE_META` 枚举、字段、附件声明）**固定不可改**；可定制的只有三个 Prompt 覆盖项（`jira.triage` / `jira.comment.format` / `jira.report.businessText`）。**能否用 `jira.triage` Prompt 把"信息充分性审查"语义塞进平台的"调查定位"流程，是迁移成立与否的核心问题**——审查结论的 pass/fail/skip 与平台的 `agent_resolved/unresolved` 语义并不等价，状态流转、Label、关闭判定这些围绕"定位"设计的机制对审查场景可能是干扰甚至错误操作（好在 Filter 级开关可以逐项关闭写入）。

### 4.2 无 MCP / 自定义工具通道

本项目有一个独立 stdio MCP server `@easemob-agent/jira-mcp`（5 个工具，`.agents/mcps/jira/`）。平台三份文档**无一处提及 MCP**；团队能注入的只有：Skill 仓库（SKILL.md 目录）、代码仓库、普通/Secret 环境变量。本项目的 Jira 工具能力可以改写为 Skill 内脚本 + 环境变量（类似现有 `jira-ticket-create` skill 的 `scripts/jira-create.mjs` 模式），但运行时是否允许脚本任意出网访问环信 Jira 取决于平台网络策略——又回到 3.1/3.3 的网络与认证问题。

### 4.3 模型供应链受限

本项目支持任意 OpenAI 兼容端点（经 codeproxy 桥接，可接 DeepSeek/千问/本地代理）。平台允许自带 API Key，但 **provider base URL 锁死在平台侧**（"客户端不能为任何配置组指定 URL、主机名或协议"），模型只能从其网关列表选择（支持 1 主 + 最多 10 备用的熔断降级，这点比本项目强）。如果环信有指定的模型供应商或合规要求，需要平台网关支持。

### 4.4 数据合规（文档完全未覆盖）

环信工单数据（含用户反馈、日志、appkey 等）将被**声网托管的平台**处理，并经由平台配置的**第三方模型网关**出网。本项目现有数据脱敏管道（`src/jira/masking.ts`）在平台侧是否等效存在不可知。跨公司数据处理的合规审批是接入前置条件，文档无任何说明。

### 4.5 网络可达性 —— 2026-09-01 实测后基本排除

最初判断：环信 Jira/Confluence 看似在内网（`*.private.easemob.com` 命名），声网 SaaS 平台要触达需网络打通。

**实测证据（2026-09-01）**：

- 公网 DNS（8.8.8.8）解析 `j1.private.easemob.com` / `c1.private.easemob.com` → 同一公网 IP `114.55.16.28`（阿里云 SLB，CNAME 到 `lb.private.easemob.com.x.easeslb.com`）——域名中的 "private" 有误导性，并非内网 split-horizon DNS。
- 未携带任何凭证的 HTTPS 请求直达 Jira：`GET /` 返回 302 到 `MyJiraHome.jspa`（`X-AUSERNAME: anonymous`），`GET /rest/api/2/serverInfo` 返回 **200**——Jira 匿名可达，且该路径未被前置网关 Basic 拦截。
- 用户亦确认在家（非办公网）可正常访问页面和内容。

**结论**：环信 Jira/Confluence 大概率已对公网暴露，"声网 SaaS 平台网络不可达"的担心基本排除。残留确认点（低风险）：① 阿里云 SLB 层可能存在源 IP 白名单（实测请求来自办公/家庭网络，不能完全排除），最终验证方式是让平台方对环信实例跑一次它的连接测试（`POST .../test`），这是成本最低的确定性验证；② 可达 ≠ 认证兼容，双层认证问题独立存在（见 3.3）。

### 4.6 本项目有、平台没有对应物的能力

| 能力 | 本项目实现 | 平台对应物 | 差距 |
|---|---|---|---|
| 审查去重/复审 | `review-records.json`（pass 永跳，fail 待变更复审） | 未提及 | 需确认平台筛查是否有去重语义 |
| 下游 webhook 订阅推送 | 全量/按场景订阅，失败挂起+探活恢复 | 无 | 丢失，或需 Skill 脚本自行实现 |
| 新建工单延迟审查 | 5 分钟持久化延迟队列 | 无（cron 粒度） | 实时性下降 |
| 审查质量评测 | `jira-review-quality-evaluation` skill 离线复评 | 平台有定位率统计（语义不同） | 可保留为本地工具 |
| 健康检查邮件 | SMTP 日报 | 平台自身运维，团队不可见 | 团队侧可放弃 |
| Jira 用户→企微映射 | 43 条手工映射 + 拼音猜测 | 平台用声网内部通讯录 | **环信是企业微信独立主体，通讯录映射需重新解决** |
| 创建工单 | `jira-ticket-create` skill（含自定义字段、附件） | 平台无创建工单入口（文档未见） | 该能力可能无法迁移 |

### 4.7 对本项目有利的事实

- **Confluence 本项目并无实际集成**（`.agents/mcps/README.md` 描述了 confluence MCP 但代码和配置中均不存在），Confluence 版本差异（5.8.10 vs 6.12.4）对本项目迁移**无实际影响**。
- 平台的团队 Skill 机制（Git 仓库 + SKILL.md + 多源 + 定时同步 + 进化 PR）与本项目的 `.agents/skills/` 结构**高度同构**，四个现有 skill 的文档部分基本可平移。
- 平台企微智能机器人与本项目同为 aibot WebSocket 长连接，会话概念（私聊/群聊策略）更完善。
- 平台允许不写 Jira（Filter 开关全关 + `forbid_wecom_jira_comments`），可以只用它的"企微入口 + Agent 运行时 + Skill 仓库"，但这等于放弃了它的 Jira 闭环——而那正是它相对本项目的主要增量。

### 4.8 Jira 字段读取范围（审查可行性的前提，文档未覆盖）

本项目的 15 场景审查依赖 HIM 工单的自定义字段：`customfield_11901`（缺陷内容）、`customfield_11900`（需求内容）、`customfield_11906`（测试范围）等，外加描述和评论历史。字段拿不到，审查标准空转。

**文档能确认的事实**（/guide）："Jira 单条工单读取会校验服务端原始响应是否包含所请求字段；字段缺失时会明确报告运行时读取异常，不会把缺失的正文误判为空正文。"——读取是"请求方指定字段、平台透传原始响应"的模式，自定义字段理论上可按名请求，属有利信号；Agent 侧另有随 `agora-atlassian` Skill 发布的 Jira CLI 作为调查期受控查询入口。

**文档没回答的三个关键点（真正的风险）**：

1. Filter 定时筛查触发时，平台服务端**预取并注入给 Agent 的字段集**是平台代码固定的，文档未列；若初始注入只含标准字段，审查第一跳就缺料；
2. Jira CLI 可请求的字段范围是否覆盖任意 `customfield_*`；
3. 附件能否作为输入读取（文档只明确写了平台向 Jira **上传**报告附件），以及 changelog 是否可读。

这不是 Prompt 能解决的问题，字段集在平台服务端代码里，团队改不了。验证成本低：让对方用环信实例读一次真实工单（如 HIM-19896），确认返回包含 `customfield_11901/11900/11906` 完整内容即可。

## 5. 风险分级清单（2026-09-01 讨论后修订）

**阻断项（不解决则迁移不成立，均在声网平台方手里）**

1. Jira/Confluence/Bitbucket 地址平台写死，环信实例无法接入（3.1）
2. 认证链路不兼容：环信 Jira 为网关 Basic + 表单登录双层认证，平台仅支持单层 Basic（3.3）
3. 业务流程错位：审查（pass/fail/skip）能否用平台"调查定位"流程表达（4.1）

**高风险**

4. Jira 6.3.6 写链路兼容性：评论/附件/流转/Label 需逐项实测，只读连接测试不能证明（3.6）
5. 企微通知 @成员能力未证实（3.5）
6. Jira 字段读取范围未证实：Filter 预取字段集固定在平台服务端，HIM 自定义字段（11901/11900/11906）、评论历史、附件是否可得未知，缺失则审查无法成立（4.8）

**中风险**

7. 触发模型从事件驱动降为 JQL 轮询，实时性和精细控制丢失（3.2）
8. 数据合规：非技术阻断，属跨公司数据处理审批流程项，需与平台方确认其合规方案（4.4）
9. 创建工单、下游订阅推送等能力无平台对应物（4.6）
10. 企微主体不同导致的用户映射问题（4.6）

**低风险/已排除/非问题**

11. 网络可达性：2026-09-01 实测环信 Jira/Confluence 公网可达（公网 DNS 解析 + 匿名 HTTPS 200），基本排除；最终由平台方连接测试证实（4.5）
12. 模型供应链：已讨论确认为非问题——迁移后只提供 Skill，不提供 MCP；Codex CLI 与 Jira 工具均为平台自带，环信只指定账号和模型型号，接受平台网关的模型列表（4.3）
13. GitHub vs Bitbucket：本项目无代码仓库集成，不阻断（3.4）
14. Confluence 版本差异：本项目无 Confluence 集成（4.7）
15. Skill/Prompt 迁移：机制同构，成本低（4.7）

## 6. 建议

1. **先决问平台方，再谈迁移**。阻断项 1/2/3 都是平台级改造或平台方运营操作，环信侧无法自行解决。如果平台方不愿支持外部 Atlassian 实例，迁移结论直接是否定。
2. **如果平台方愿意支持**，最低要求是：atlassian 配置开放 `baseUrl` + 支持自定义认证头（或环信侧提供标准 Basic 直连入口）；并请平台方直接对环信实例跑一次连接测试（`POST .../test`），一并证实网络可达性。
3. **概念验证（PoC）顺序**：连通性（ping/serverInfo）→ 只读（getIssue/search，重点验证 `customfield_11901/11900/11906`、评论历史、附件是否完整可读）→ 写操作逐项（评论 → 附件 → Label → 流转）→ 企微通知 @成员 → 用一个真实 Filter 跑审查语义 PoC。每一步都不可跳过只读测试直接采信。
4. **降级方案**：若 Jira 集成无法打通，可评估"只用平台的企微 + Agent 运行时 + Skill 仓库，Jira 操作全部走团队 Skill 脚本"的半迁移形态——但此时平台价值仅剩托管运行时，与本项目现有形态差距不大，需重新权衡是否值得。
5. **无论迁移与否**，本项目现有的审查标准（`jira-ticket-review` skill + `review-scenarios.ts`）、脱敏管道、质量评测工具都是可携带资产，迁移时以 Skill 仓库形式平移。

## 7. 待向声网平台方确认的问题清单

1. atlassian 配置能否支持外部实例的 baseUrl？roadmap 上有没有多实例/外部公司接入计划？
2. Jira 认证能否支持自定义请求头（前置网关 Basic）或 PAT？能否适配表单登录 + Cookie 的老版本 Jira？
3. 平台服务端 Jira Client 验证过哪些 Jira 版本？6.3.6（REST API v2，2014 年代）是否在支持矩阵内？能否安排对环信实例的写操作实测（评论/附件/流转/Label）？
4. Jira 字段读取范围：Filter 筛查触发调查时平台预取并注入 Agent 的字段集包含哪些？HIM 自定义字段（`customfield_11901/11900/11906`）是否在列？调查过程中 Agent 能否按名读取任意自定义字段、评论历史、附件内容和 changelog？可用测试工单（如 HIM-19896）实测验证。
5. 能否用环信实例跑一次平台连接测试（同时验证公网可达性）？Git 白名单能否加 `github.com`？
6. 企微智能机器人出站消息能否 @群成员？群机器人 webhook 是否有支持计划？
7. 平台对外部公司租户的数据隔离、数据处理协议、模型网关数据出境的合规方案是什么？
8. `jira.triage` Prompt 能否完全定义审查语义（pass/fail/skip 信息充分性审查），`JIRA_TRIAGE_META` 的枚举是否可扩展？状态流转的目标状态如何映射（文档只有开关）？
9. Filter 筛查的去重语义：同一工单是否会重复触发调查？
10. 是否有私有化部署选项（若 SaaS 接入路径全部走不通）？
