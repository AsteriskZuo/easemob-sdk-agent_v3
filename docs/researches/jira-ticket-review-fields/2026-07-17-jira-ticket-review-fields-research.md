# Jira 工单审查字段调研

## 定位

本调研服务 `jira-ticket-review` skill 的改造。该 skill 的定位是审查工单，不是分析问题。

审查工单只判断 Jira Bug 工单是否说清楚、是否具备进入后续处理的最低信息。它不做根因分析，不读取源码，不下载或解析附件，不分析日志，不给出修复方案。

非 Bug 工单不进入该 skill 的审查流程。过滤阶段如果发现 `issuetype != Bug`，直接放行，不做后续判断。

`HIM-22543` 只作为真实字段结构和数据来源调研样本，不是合格工单范本。

## 调研结论

Jira 当前字段很多，但第一版审查不应把所有字段都交给模型。字段应按审查价值分层，只把能够帮助判断 Bug 信息是否充分的字段作为主要上下文。

`customfield_11901 / HIM缺陷内容` 是 Bug 审查的主证据源。真实样本显示，`description` 和 `environment` 可能为空，但问题场景、SDK 版本、终端、实际现象和替代方案可能都写在 `HIM缺陷内容` 中。因此第一版不能按固定字段完整率判断。

`summary`、`description`、`environment`、`comment` 可作为补充证据。信息可以分布在多个字段中，不要求提交人重复填写。

`customfield_11906 / 测试内容及范围` 有辅助价值，但容易包含模板说明。它不能替代 Bug 信息，也不能仅因为存在模板内容就认定工单合格。

附件和日志第一版不分析。附件只作为元信息记录，包括文件名、类型和大小。如果日志包含关键错误、错误码、时间点或对比结论，提交人需要自行摘录到正文或评论中。模型不能因为存在日志附件就判定信息充分。

## 字段分层

### 路由字段

- `issuetype`：硬约束。只有 `Bug` 进入审查；非 Bug 在过滤阶段放行。

### 核心证据字段

- `customfield_11901` / `HIM缺陷内容`
- `summary`
- `description`
- `environment`

### 补充证据字段

- `comment`
- `customfield_11906` / `测试内容及范围`

### 上下文字段

- `priority`
- `components`
- `labels`
- `versions`
- `fixVersions`
- `customfield_10306` / `Epic Link`
- `status`
- `resolution`
- `project`
- `reporter`
- `assignee`

### 时间字段

- `created`
- `updated`
- `resolutiondate`

### 附件元信息

- `attachment`

只记录附件元信息，不下载、不读取、不解析内容。

## 审查维度

第一版审查应按问题信息维度判断，不按字段完整率判断。

Bug 工单合格需要能从核心证据和补充证据中判断：

- 问题描述：能否看懂发生了什么。
- 复现条件或场景：是否说明触发条件、操作路径或发生场景。
- 环境信息：是否包含 SDK 版本、平台、系统、集群、端类型等必要背景。
- 实际结果：是否明确错误现象、错误码、异常行为或用户可见结果。
- 预期结果：是否说明期望行为。
- 影响范围：是否说明客户影响、业务影响、范围、频率或优先级依据。
- 证据摘要：如果关键证据来自日志、截图或附件，是否已在正文或评论中摘录。

不要求每个维度必须对应一个固定 Jira 字段。只要 `HIM缺陷内容`、`summary`、`description`、`environment`、`comment` 合起来能支撑判断即可。

## 不合格条件

进入审查的 Bug 工单在以下情况下应判定不合格：

- 内容本质不是 Bug，而是需求、咨询、配置问题、文档问题、方案讨论或任务安排。
- 问题只能从附件或日志中推断，正文和评论没有摘录关键证据。
- 只保留模板标题、占位说明或“待补充”，没有具体问题事实。
- 复现条件、实际结果或预期结果缺失，导致后续处理人无法判断问题。
- 多个不相关问题混在同一工单中，无法判断单一处理对象。
- Jira 标记为 Bug，但字段内容明显指向其他类型，应建议改类型或拆分。

## 脚本说明

调研脚本位于：

- `docs/researches/jira-ticket-review-fields/fetch-jira-issue-fields.mjs`
- `docs/researches/jira-ticket-review-fields/jira-field-summary.mjs`

脚本使用当前项目 Jira 表单登录方式读取：

- `/rest/api/2/field`
- `/rest/api/2/issue/{ISSUE_KEY}?expand=renderedFields,comment`

输出包括：

- Markdown 字段摘要：供人工快速查看字段分布。
- JSON 摘要：包含关键字段完整值、评论正文摘要和附件元信息，供后续分析使用。

真实 Jira 输出可能包含客户、人员、AppKey、内部 URL 等敏感信息。`runs/` 下的真实输出只用于本地调研，不应提交到仓库。

## 后续实现建议

后续实现不应只修改 skill 文案，还需要改 Jira 数据输入。当前模型如果拿不到 `customfield_11901` 和完整评论，skill 再完善也会误判。

建议后续实现：

- 在 Jira 获取层返回审查上下文，至少包含本调研列出的核心字段、补充字段、上下文字段、时间字段和附件元信息。
- 审查入口确保只把 `issuetype = Bug` 的工单送入 `jira-ticket-review`。
- `jira-ticket-review` skill 重写为按审查维度判断，而不是固定必填字段清单。
- 明确附件和日志不作为第一版分析对象，要求提交人在正文或评论中摘录关键证据。
