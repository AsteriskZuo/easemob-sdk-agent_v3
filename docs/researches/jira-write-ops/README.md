# jira-write-ops 调研

用途：沉淀 v2 生产 Jira 客户端（`easemob-sdk-agent_v2/src/jira/jira-client.ts`）的能力、认证链路与字段模型，供 v3「Jira 出口工具」实现时直接移植参考。

文件清单：

- `2026-10-03-jira-write-ops-research.md` — Jira 写操作技术调研（能力清单 / 认证链路 / 字段模型 / 错误处理 / 实现建议）
- `jira-readonly-verify.mjs` — 认证链路只读冒烟脚本（可反复验证网关 Basic + login.jsp 表单登录 + cookie 会话对 Jira 6.3.6 仍然有效）

## 冒烟脚本用法

```bash
# 缺省读取 .easemob-agent/config.json 的 TOOL__JIRA__* 键
node docs/researches/jira-write-ops/jira-readonly-verify.mjs

# 或显式指定配置文件
node docs/researches/jira-write-ops/jira-readonly-verify.mjs --config /path/to/config.json
```

读取键：`TOOL__JIRA__URL` / `TOOL__JIRA__USERNAME` / `TOOL__JIRA__PASSWORD`（必填），`TOOL__JIRA__REDIRECT_USERNAME` / `TOOL__JIRA__REDIRECT_PASSWORD`（网关 Basic，可空）。全程只读（login.jsp 登录 + serverInfo + search maxResults=1），不打印任何凭证；成功输出「认证链路只读验证通过」，失败非零退出。

2026-10-03 实测通过（j1.private.easemob.com，search total=59334）。
