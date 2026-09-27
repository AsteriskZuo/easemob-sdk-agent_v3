# progress

- [x] 设计 v3：双循环架构（入口/出口事件循环 + 出口工具群 + 结果扇出）落文档（2026-09-26，e254a00）
- [x] agent 内核调研与选型：pi（hooks 实测 + 真实工单脱敏链路实证）；codex-cli 否决（2026-09-27，决策记录 decisions/2026-09-27-agent-kernel-and-execution-mode.md）
- [x] 业务工作流选型：代码即流程（拒绝 DSL/编排引擎）+ 业务 SDK + 一入一出契约 + 稳定性四防线；检查/门禁/处理器归业务流程内部（2026-09-27，决策记录 decisions/2026-09-27-business-workflow-code-as-workflow.md）
- [x] 执行模型回写设计文档：新增 design/business-workflow.md；glossary（业务/门禁/生命周期/流程程序/SDK/agent 服务）、lifecycle、循环契约、core-modules、console-design 等同步（2026-09-27）
- [x] 日志重新设计：四类日志（系统级/入口循环/出口循环/业务）+ 启动自检 fail-fast 与运行期不崩溃纪律；SDK 补 log API 与单轮审查工单伪代码示例（2026-09-27）
- [ ] MVP M1：事件信封契约 v1 + 注册表 + 双调度循环 + SQLite 队列 ×2
- [ ] MVP M2：生命周期运行时（WorkflowRunner + AgentService + 业务 SDK）+ 通道 + 并发闸门
- [ ] MVP M3：代码 Review + 企微出口工具，端到端跑通；单轮审查工单全链验收
