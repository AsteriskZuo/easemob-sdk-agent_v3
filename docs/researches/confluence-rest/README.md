# Confluence REST API 调研

本目录用于沉淀「业务产出投递到 Confluence Server 5.8.10（c1.private.easemob.com）页面」的出口工具可行性调研，覆盖 REST API 端点、认证链路、storage format 约束与版本冲突行为。**2026-10-03 已完成真实验证**：认证链路（网关 Basic + login.action 表单登录 cookie）与 AIR 空间建页/改页/查页写链路全部实测通过。

当前文件：

- `2026-10-03-confluence-rest-research.md`：调研正文。核心结论：Basic 直连在本部署不可行（nginx 网关消费 Authorization 头），唯一可行链路是「每个请求带网关 Basic + login.action 表单登录 seraph.confluence cookie」；建页 POST→200、改页 PUT 带 version+1→200、按标题查页→size=1 均真实验证；删页 403（账号无 trash 权限）。
- `confluence-verify.mjs`：验证脚本，默认只读（匿名→应用 Basic→网关 Basic→表单登录四步探测），`--write` 追加真实写链路（建页→查页→改页→删页，删页 403 时留「验证残留」说明页）。2026-10-03 只读流程已复跑通过。

优先阅读：

1. `2026-10-03-confluence-rest-research.md`
2. `confluence-verify.mjs`

## 复跑验证

```bash
# 只读探测（无写操作，随时可跑）
node docs/researches/confluence-rest/confluence-verify.mjs

# 写链路验证（真建页；删页 403 会留下「验证残留」页，需管理员删除，谨慎运行）
node docs/researches/confluence-rest/confluence-verify.mjs --write
```

凭证来源（环境变量优先于 config）：默认读 `.easemob-agent/config.json` 的 `TOOL__JIRA__*` 键（URL 推导 j1→c1、USERNAME/PASSWORD 作应用凭证、REDIRECT_USERNAME/PASSWORD 作网关凭证），也可用环境变量覆盖：`CONFLUENCE_BASE_URL` / `CONFLUENCE_USER` / `CONFLUENCE_PASS` / `CONFLUENCE_GATEWAY_USER` / `CONFLUENCE_GATEWAY_PASS`。

输出 `RESULT: PASS (auth via form-login-cookie)` 即认证链路可用；`--write` 时另输出 `[summary:write]` 建/查/改/删各步结果。

## 残留页提示

2026-10-03 `--write` 验证在 AIR 空间留下一页「【验证残留，请管理员删除】出口工具验证页-2026-10-03」（id=24278219，服务账号无 trash 权限无法自删），**需 Confluence 管理员手动删除**。后续每次 `--write` 都会产生新的带日期后缀残留页。
