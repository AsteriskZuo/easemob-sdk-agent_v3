# plan：SDK 日志分析业务迁移（sdk-log-analysis）实施计划

- **日期**：2026-11-12
- **spec**：`docs/specs/2026-11-12-sdk-log-analysis-spec.md`（下称 spec；执行时以 spec 为准，本 plan 只补充任务编排）
- **执行模式**：主/子代理。每个 T 一个子代理（同模型 256k 上下文），主代理只验收、不替写；**子代理不 commit**；全部任务验收通过后统一提交（需用户授权）。
- **红线**：v3 平台代码仅允许已批准小改（pi 工具白名单+路径守卫、信封 cacheDir，见 spec 文首红线与 D9/D10）；**jira-ticket-review 业务仓零改动**（spec D6，下游解析其通知格式 + 自持过滤）；业务代码只动 `business/sdk-log-analysis/`（新仓）。子代理发现平台缺口 → 停下上报，不擅自修改。

## 阶段划分与验收标准

### T1：业务仓骨架与契约

- **内容**：`business/sdk-log-analysis/` 从 `templates/agent-package/` 复制骨架；三资产目录树（package/skills/tools）就位；`agent-package.json`（name/version/requires 按 spec §9）、`contract.json`（spec §9 全文）、SKILL.md 空壳占位、check-input 模板薄壳/check-output 审查业务版（null 逃生门 + checkMetrics）；main 薄壳接线空编排（先 `sdk.return(null)`）；`data/jira-wecom-mapping.json` 从审查业务仓拷贝（**必须含 tags 字段**，spec §10 D5）。
- **验收**：`package/` 六连（build/test/typecheck/lint/format/circular）全绿；`contract.json` 过 `loadContract` 形状校验；模板自带三个测试能跑（薄壳未实现语义前允许失败用例改写为骨架态，但 build/typecheck/lint 必须绿）。
- **状态：已完成并验收（六连全绿、loadContract 通过）。**

### T2：jira-log-fetch 工具

- **内容**：`tools/jira-log-fetch/`：jira-client 移植自审查业务仓工具（表单登录 + cookie 罐 + 401 重登 + getIssue + 脱敏快照），补附件元数据读取与下载；log-ingest：白名单筛选（spec §7）、解包与编码归一、单文件 20MB/累计 100MB 限额、落盘 workspace `input/logs/`；masking.ts 原样拷贝；快照字段覆盖 spec §7 清单（含 §4.3 过滤与 §6.5 ref 选择所需 status/statusCategory/issueType 等；**identity 旁路必须含 assigneeEmail/assigneeName**，F3 过滤数据源）；契约按 spec §7（error 双态、identity 旁路、空日志合法）。
- **验收**：六连全绿；单测最低线见 spec §12（mock HTTP 全链路：登录→getIssue→下载→解包；白名单/限额/脱敏/旁路/非法入参）；断言脱敏快照中无原始邮箱、凭据不落任何落盘文件。
- **状态：已完成并验收（六连全绿，45 测试）。**

### T3：主流程序编排（材料化侧，agent 留 mock）

- **内容**：`package/packages/` 实现 notify-parse（spec §4.2：通过标题判别 + key 正则，**不解析分类行**）、analysis-records（去重）、person-mapping 接口封装（查 tags 供 F3）、ref-resolver（三级优先级 + 归一 + 消歧）、worktree（注入式 git 执行器，可 mock）、materialize（conversation.md / task-context.md）、notify-message（@ 规则与 content 组装）、report-parse（多策略解析）；analysis-flow 全部步骤接通（步骤 9/10 用注入的假 agent 返回报告 JSON）。
- **验收**：六连全绿；analysis-flow 单测覆盖 spec §12 全部分支（payload null / 非通过标题 / 解析失败三类过滤；F1 终态、F2 非 Bug、**F3 负责人无 sdk 标签（含查不到映射记录）**三类自持过滤；去重三态；无日志分支；ref 歧义 fail；worktree 失败 fail；输出形状快照含全部契约字段）；notify-parse 单测钉死对审查业务 §4.1 格式的解析。
- **状态：已完成并验收（六连全绿，115 测试）。**

### T4：agent 分析接入与主线审计

- **内容**：接真 `sdk.agent`（分析 fresh + skill 注入 + **模型兜底链**，spec §6.8 的 pi 适配纪律 1–3）；mainline-audit 模块（第二 worktree + 审计 prompt + SHA 祖先校验 + `git show` 元数据替换 + 降级 unknown）；SKILL.md 正式成文（spec §8：pi 规范的 SKILL.md、角色/方法/报告契约/审计契约/输出 JSON 合法性约束）；metrics 键（mainline_status/confidence/skill_version）。
- **验收**：六连全绿；单测绿（mainline-audit 校验通过与降级、兜底链命中与全灭）；**local-runner 真实 LLM 端到端**（spec §6.8 纪律 3 的实证点）：用真实派生事件 JSON（payload = 审查业务真实输出 `{content, mentions}`，按 spec §4.1 形状）+ 本地 config/secrets 按 `docs/refs/2026-11-09-local-run-guide.md` 跑通；config 需准备 `sdk_repo_path`（本机 emclient-linux 克隆），remote 为私有且本机 git 未配凭据时另备 `git_username`/`git_token` secrets（spec §6.6/§10）；**确认 pi 能读 run workspace 相对路径文件**，产出报告 JSON 符合契约、workspace 文件齐全（input/logs、source、task-context.md）。**若 pi 不能读文件 → 停下报告用户，不允许内联日志绕过。**
- **状态：已完成并验收（2026-11-13 全真实 e2e 通过，run_01M79EK71APEB11S6P0G3DX1A6：真实 jira 拉取 + 附件下载 + ref 未命中回退主线 msync + 两轮 LLM + 契约输出全字段）。期间按用户决策演进两轮（详见 spec D9/D11/D12 与 pi 工具白名单 spec）：① 源码仓从本机路径改为远端 URL + bare 缓存（信封新增 cacheDir 字段，sdk 升 0.6.0 待发布）；② git 账号 key 按账号名约定；③ 补移植 log-bot ref 回退主线语义；④ 平台新增 pi 工具白名单 + 路径守卫（业务包 pi_tools 声明，asset-registry/runtime/run-core/agent-service/local-runner 五包改动 + agent-service/extensions/path-guard.js）。**

### T5：注册上线与编排 e2e（手动部分，平台侧不代执行）

- **内容**：按 spec §12 上线验证清单 1–6 执行；子代理职责到「提供用户操作清单 + 本地自查脚本/数据准备」为止，控制台操作与观察由用户完成。
- **验收（用户确认）**：带日志附件、负责人带 sdk 标签的 Bug 测试工单走完 审查 pass → 自动日志分析 → 企微群收到分析报告；控制台两个业务的 run/统计/日志可见；幂等（同 updated 复审不重复分析）与负向（无附件 quiet 跳过、fail 审查/无 sdk 标签不触发）验证通过。

## 任务依赖关系

```text
T1（done）──► T2（done）──► T3（done）──► T4（done）──► T5
```

T2 与 T3 目录互不重叠（tools/ vs package/packages/），但 T3 单测若走真工具边界需 T2 先就位，实按 T2 → T3 顺序执行更稳；T4 依赖 T3；T5 依赖全部。

## 执行纪律

1. 子代理只读 spec + 本 plan 与该任务涉及文件，不读原始设计文档（spec 已内联）；过滤规则有疑问时按 spec §4.3 的 v2 依据执行，不自行发明规则；
2. 每个子代理交付时附「六连结果 + 变更文件清单」；主代理抽查关键契约文件后标记完成；
3. log-bot 仓与 jira-ticket-review 仓只读；平台仓（v3 根）不 commit 任何代码改动；
4. 全部任务验收通过 → 更新本 plan 复选框 → 用户授权后统一提交（v3 根仓的 spec/plan/dailylog + 新业务仓，分别提交）。
