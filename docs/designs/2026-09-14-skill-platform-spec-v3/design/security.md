# 安全设计

> 机制文档。术语定义见 `design/glossary.md`。

- **入口验签**：HMAC 或平台自有签名 + 时间戳防重放；
- **Webhook Bearer Token**：出站/入站 webhook 应携带 Bearer Token 鉴权——**第一阶段暂缓，第二阶段（上生产）必须**；
- **密钥管理**：API Key/Token 统一托管，按 skill 粒度授权（哪个 skill 能拿哪个 key）；运行时注入执行环境，不落盘、不进日志；控制台只写不读明文；Jira 工具等 public skill 的账号由使用方业务各自提供（凭证按业务隔离）；
- **脱敏**：出口前可配置 payload 脱敏规则（代码、日志可能含敏感信息）；
- **工具调用预算**：按任务设调用次数/费用上限，兼具成本与防失控双重作用（见 `design/skill-package.md`）；
- **厂商配额**：按主账号合并统计，多 Key 不扩配额；触顶路径为商务提额 → 多账号 → 多厂商（见 `design/scheduler.md` §6）。
