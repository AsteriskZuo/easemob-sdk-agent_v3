# 安全设计

> 机制文档。术语定义见 `design/glossary.md`。

- **入口验签**：HMAC 或平台自有签名 + 时间戳防重放；
- **Webhook Bearer Token**：出站/入站 webhook 应携带 Bearer Token 鉴权——**第一阶段暂缓，第二阶段（上生产）必须**；
- **密钥管理**：API Key/Token 统一托管，运行时注入，不落盘、不进日志；控制台只写不读明文。**模型凭据由平台持有**——大模型调用经 agent 调用服务端到端完成，不进入业务进程；业务自有凭证（jira 等）按业务隔离注入业务进程，经 `sdk.secret()` 读取（见 `design/business-workflow.md` §3）；
- **脱敏**：敏感信息守卫是业务流程内部的环节（脱敏/还原子程序或程序内函数，会话外执行、顺序业务自控）——业务侧无会话内代码（不支持业务 extension），会话内只有平台注入的审计 extension（`design/package-model.md` §10）；出口侧不做内容加工的纪律不变；
- **边界审计**：agent 调用服务落盘每次真实 LLM 请求体（`before_provider_request`）——「敏感内容不出边界」的直接证据（`design/business-workflow.md` §4）；
- **失控防线**：工具调用预算（按任务设调用次数/费用上限，见 `design/package-model.md` §10）+ agent 调用配额（按 run 计次数上限与 wall-clock 超时，超限强杀，见 `design/business-workflow.md` §6）；
- **厂商配额**：按主账号合并统计，多 Key 不扩配额；触顶路径为商务提额 → 多账号 → 多厂商（见 `design/scheduler.md` §6）。
