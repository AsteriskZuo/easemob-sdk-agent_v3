# Jira Polling 兜底方案调研

本目录用于沉淀 Jira webhook 不可用时的长轮询兜底方案。

当前文件：

- `2026-07-11-jira-6.3.6-polling-fallback-research.md`：基于 Jira 6.3.6 REST API v2 Search/JQL 的轮询方案、风险和验证步骤。
- `poll-assigned-issues.mjs`：测试脚本，用于构造 JQL、调用 `/rest/api/2/search` 查询指派给指定人的工单。

优先阅读：

1. `2026-07-11-jira-6.3.6-polling-fallback-research.md`
2. `poll-assigned-issues.mjs`

