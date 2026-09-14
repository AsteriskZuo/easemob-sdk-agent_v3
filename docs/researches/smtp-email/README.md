# SMTP 邮件发送调研

本目录用于沉淀健康自检邮件报告（`docs/specs/2026-07-30-health-check.md`）的 SMTP 发送可行性调研。

当前文件：

- `2026-07-30-smtp-email-research.md`：阿里云企业邮箱（smtp.easemob.com:465/SSL）的服务器地址、端口、认证方式确认，配置项必要性评估，以及基于 nodemailer 的真实端到端发送验证结论。
- `send-test-mail.mjs`：SMTP 配置端到端验证脚本（2026-07-30 已用它真实发信验证通过），可作为后续回归工具。前置条件：已安装 nodemailer（健康自检功能落地后即为项目依赖）。

优先阅读：

1. `2026-07-30-smtp-email-research.md`
2. `send-test-mail.mjs`

## 复跑验证

```bash
node docs/researches/smtp-email/send-test-mail.mjs
```

输出 `RESULT: PASS` 并收到标题为 `[easemob-agent] SMTP 配置验证测试` 的邮件即全链路正常。
