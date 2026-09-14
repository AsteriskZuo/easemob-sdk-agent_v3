# jira-review-field-inventory

jira-ticket-review skill 优化的前置调研：Jira 字段全景、HIM 工单字段实际使用情况、默认模板识别。

> 说明：`docs/researches/jira-ticket-review-fields/` 是另一个独立调研的产物，与本目录互不影响。

## 文件

- `jira-field-research.mjs` — 调研脚本（只读）。认证流程移植自 `src/jira/jira-client.ts`，配置读 `.easemob-agent/config.json`（环境变量优先）
- `field-definitions.json` — `GET /rest/api/2/field` 全量字段定义（132 个）
- `sample-field-stats.json` — HIM 全类型抽样 30 个的聚合统计
- `sample-field-stats-bug.json` — HIM 仅 Bug 抽样 50 个的聚合统计
- `2026-07-17-jira-field-inventory-research.md` — 调研报告（结论在这里）

## 脚本用法

```bash
# 全量字段定义
node jira-field-research.mjs fields

# 抽样统计（默认 HIM 项目、30 个、按 updated DESC）
node jira-field-research.mjs sample [--project HIM] [--count 30] [--jql "..."] [--tag name]

# 单工单验证（改 skill/字段映射后反复验证用）
node jira-field-research.mjs inspect HIM-22543 [--baseline 15]
```

- `inspect` 会先从该项目最近工单现场学出默认模板（众数，≥3 命中才算模板），再对目标工单做逐字段、逐模板区块的填充分析，结果覆盖写入 `runs/<ISSUE_KEY>.json`
- 数据纪律：`sample` 只落聚合统计和共享模板文本（众数命中 ≥3 才落），不落完整工单内容；`inspect` 为验证用途保留目标工单叙述字段原文到 `runs/`，注意勿外发
