# progress

- [x] 设计 v3：双循环架构（入口/出口事件循环 + 出口工具群 + 结果扇出）落文档（2026-09-26，e254a00）
- [x] agent 内核调研与选型：pi（hooks 实测 + 真实工单脱敏链路实证）；codex-cli 否决（2026-09-27，决策记录 decisions/2026-09-27-agent-kernel-and-execution-mode.md）
- [x] 业务工作流选型：代码即流程（拒绝 DSL/编排引擎）+ 业务 SDK + 一入一出契约 + 稳定性四防线；检查/门禁/处理器归业务流程内部（2026-09-27，决策记录 decisions/2026-09-27-business-workflow-code-as-workflow.md）
- [x] 执行模型回写设计文档：新增 design/business-workflow.md；glossary（业务/门禁/生命周期/流程程序/SDK/agent 服务）、lifecycle、循环契约、core-modules、console-design 等同步（2026-09-27）
- [x] 日志重新设计：四类日志（系统级/入口循环/出口循环/业务）+ 启动自检 fail-fast 与运行期不崩溃纪律；SDK 补 log API 与单轮审查工单伪代码示例（2026-09-27）
- [x] 整体设计走查修补：Lifecycle 组装时序、agent 会话策略（channel/fresh）、流程程序运行时（上传即转译）、SDK 会话操作（compact/clear）、注册表一对多、max_agent_calls 键、业务日志按会话+业务组织、契约版本字段、「沙箱→子进程」措辞统一（2026-09-27）
- [ ] MVP M1：事件信封契约 v1 + 注册表 + 双调度循环 + SQLite 队列 ×2
- [ ] MVP M2：生命周期运行时（WorkflowRunner + AgentService + 业务 SDK）+ 通道 + 并发闸门
- [ ] MVP M3：代码 Review + 企微出口工具，端到端跑通；单轮审查工单全链验收
- [x] T24：入口/出口配置统一占位符（{{key}}）机制——runtime 解析层 + EnvProvider.lookup 四级顺序、jira/webhook 入口字段重构、出口 exitSecretKey 约定废弃、console-api 保存校验、console Tabs 双视图（2026-10-10）
- [x] T25：event_type 留空通配（接收该来源全部事件）+ 创建页 localStorage 草稿 + 创建接口随建 env（解创建死锁）；适配器默认事件标签（2026-10-10）
- [x] T26：资产版本更新——asset_id 哈希去 commit（升级不换 id、绑定不断）、asset-registry updateRef（重新物化+失败回滚）、共享资产禁止更新（409）、console-api PUT /api/assets/:id、console 资产页更新入口（2026-10-11）
- [x] pi 内核落地为 npm 依赖（回归 2026-09-27 选型决策原意）：app/server 依赖 @earendil-works/pi-coding-agent@0.87.1 精确锁定（yarn.lock），AGENT_PI_CLI_PATH 降为可选覆盖（缺省从 node_modules 解析 bin），子进程执行模式不变；宿主前提去掉 pi（2026-10-21）
- [x] Pi 配置受管化：AGENT_PI_CLI_PATH / AGENT_PI_AGENT_DIR 均为可选覆盖（默认 npm CLI 与 platform/cache/pi/agent）；AGENT_PI_MODELS 统一模型与密钥来源，启动严格校验并原子同步 models.json；真实配置与派生文件不进 git/日志/API（2026-10-25，规格见 docs/specs/2026-10-25-pi-managed-configuration-spec.md）
- [x] 业务自定义大模型配置 + 统一更新队列 + 资产开关：① 业务可配自定义 models.json（registry pi_models 列、控制台在线验证[pi-probe 真实探针]—确认保存、递归脱敏、派生 businesses/{id}/cache/pi 受管目录）；② 全部管理写入（业务资料/env/资产/Pi 配置）统一经 UpdateCoordinator 持久化更新命令队列——严格全局 FIFO、受影响业务空闲后生效、重启可恢复；③ 资产下架改为 enabled 开关（登记/绑定/缓存保留、运行时 asset_disabled fail-fast、可重新上架），remove 保留为物理删除且有在役引用 409；④ 子进程创建收敛为公共发布的 process-runner 包（agent-service/workflow-runner/pi-probe/SDK 共用，发布顺序 process-runner → SDK）（2026-10-26，规格见 docs/specs/2026-10-26-business-pi-configuration-spec.md）
- [x] 业务包本地运行第一期（最小本地闭环）：平台上下文快照钩子（AGENT_CONTEXT_SNAPSHOT，默认关）+ 新 private 包 @asteriskzuo/agent-local-runner（本地配置/事件回放导出/上下文装配/内容 digest diff/stub 出口护栏/CLI 三命令），复用共享 executeRun 执行核，业务包零适配；e2e 真实 LLM 调用跑通（2026-11-09，规格见 docs/specs/2026-11-09-local-run-spec.md，操作指南见 docs/refs/2026-11-09-local-run-guide.md）
- [ ] 业务包运行统计：LLM 消耗落库（llm_calls）+ 按日统计 API（长表）+ 控制台二维表；二期业务 metrics 产出契约（run_metrics + runner 剥离）（2026-11-10，规格见 docs/specs/2026-11-10-business-stats-spec.md）
