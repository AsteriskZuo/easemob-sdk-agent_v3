# 平台实现进度记录

> 配套文档：[总实现计划](./2026-09-28-platform-implementation-plan.md)（任务定义、依赖、批次的唯一权威，本文不重复）。
> 本文档记录执行过程，由主 agent 维护。**只记任务级事实，不记过程流水账**。

## 记录纪律

- **派发时**：登记任务块——状态→进行中、子 agent id、开始时间；
- **完成时**：更新任务块——状态→完成、验收证据摘要（测试/检查命令结果）、commit hash；同步更新总览表与计划文档任务表状态列；
- **阻塞时**：状态→阻塞，记录原因与需要谁介入；恢复时记录重派的新子 agent id；
- **规格澄清**：执行中发现 spec 有歧义/遗漏，记录结论并回写 spec（spec 是活文档，随执行保持准确）。

## 总览

| 任务 | 状态 | 完成时间 | commit |
|------|------|----------|--------|
| T0 工程骨架 | 完成 | 2026-09-28 12:15 | 1ca90f6 |
| T1 contracts | 完成 | 2026-09-28 12:24 | 6297061 |
| T2 database | 完成 | 2026-09-29 09:59 | 92f031e |
| T3 queue | 完成 | 2026-09-29 10:09 | 1de87fa |
| T4 registry | 完成 | 2026-09-29 10:09 | 3b54982 |
| T5 channel | 完成 | 2026-09-29 12:04 | e728f90 |
| T6 logger | 完成 | 2026-09-29 12:04 | 5bcb85e |
| T7 env | 完成 | 2026-09-29 13:45 | 822473a |
| T8 scheduler | 完成 | 2026-09-29 14:45 | 9175cef |
| T9 exit-tools | 完成 | 2026-09-29 | 27eea75 |
| T10 WorkflowRunner + SDK | 完成 | 2026-09-29 | 84f0d77 |
| T11 AgentService | 完成 | 2026-09-29 | 7aa0105 |
| T12 server | 完成 | 2026-10-04 | 2dbb911 |
| T13 管理 API | 完成 | 2026-10-06 | 5e8b86a |
| T14 console | 完成 | 2026-10-07 | 97b40c6 |
| T15 程序包模板 | 完成 | 2026-09-29 | 728488b |
| T16 asset-registry | 完成 | 2026-09-30 22:31 | 10d8b66 |
| T17 runtime | 完成 | 2026-10-02 09:07 | e8e16ee |
| T18 webhook 入口 | 未开始 | — | — |

> 2026-09-28 计划变更：插入 T2 database（core-modules §4.7 唯一数据访问口的落地），原 T2–T12 顺延为 T3–T13。
> 2026-09-29 计划变更：「依赖管理四类归宿」顶级规则定稿；插入 T7 env，原 T7–T13 顺延为 T8–T14；T6 logger 改为全局外观形态。
> 2026-09-29 设计修订（commit 357b35b）：package-model 补写作者指南三节 + skill 注入机制实证落地（`--no-skills` + 逐个 `--skill`）；**sdk.agent 契约 `skill: string` → `skills: string[]`**（可多个、可跨包；空数组 SDK 本地抛错）——T10 spec §5.4 与 SDK 代码已同步（sdk 15 测试），T11 按新契约实现；glossary 新增「程序包」「Skill」词条，骨架旧术语更正；插入 T15 程序包模板任务。

## 任务记录

### T0 工程骨架

- 状态：完成
- 子 agent：agent-2（前台派发）
- 开始：2026-09-28 12:04；完成：2026-09-28 12:15
- 验收证据：主 agent 独立复验 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` + `import '@asterisk/agent-contracts'` 全绿
- commit：1ca90f6
- 备注：
  - yarn 4 下 `set version` 默认只写 packageManager 字段，用 `--yarn-path` 强制下载 release 到 .yarn/releases/（spec §2 的 3.6.1 技巧是 classic 起步备用方案，未用到）；
  - 存量 docs/、AGENTS.md 等不符合 prettier 默认风格，已加入 .prettierignore（未格式化存量文档；未来若要对 docs 做格式化处理再移除）；
  - 包级 typecheck 不覆盖 tests/（与 v2 模式一致，测试类型错误靠 jest 运行期暴露），如需覆盖需额外 tsconfig，暂不做。

（后续任务块模板）

```markdown
### T<N> <任务名>

- 状态：进行中 / 完成 / 阻塞
- 子 agent：<id>（重派时追加记录）
- 开始：<时间>；完成：<时间>
- 验收证据：<命令 + 结果摘要>
- commit：<hash>
- 备注：<遇到的问题与处理、spec 澄清结论；无则不写>
```

### T1 contracts

- 状态：完成
- 子 agent：agent-3（前台派发）
- 开始：2026-09-28 12:16；完成：2026-09-28 12:24
- 验收证据：主 agent 独立复验——48 测试全过、typecheck/lint/format:check/circular 全绿、导出签名与 spec §5 逐字一致、dependencies 为空
- commit：6297061
- 备注：
  - spec 回写：yarn 4 下 workspace 脚本看不到根 devDeps 的 bin，各包需自声明脚本工具（typescript/esbuild/jest），T0 spec §4.4 已修正；
  - spec 澄清裁决（子 agent 提出，主 agent 确认）：producer_business_id 显式 undefined 视为不存在；parseChannelId 对出口通道 destinationId 同样过段校验（保证往返严格一致）；timestamp 接受 Z / ±HH:MM / ±HHMM 结尾。

### T2 database

- 状态：完成
- 子 agent：agent-4（前台派发）
- 开始：2026-09-29 09:51；完成：2026-09-29 09:59
- 验收证据：主 agent 独立复验——15 测试全过（contracts 48 未破坏）、六项根检查全绿、导出签名与 spec §5 一致、运行时零依赖
- commit：92f031e
- 备注：@types/node 24 中 node:sqlite 参数类型名为 SQLInputValue（spec 写的 SupportedValueType 是文档术语），实现内部断言适配，接口保持 unknown[]。

### T3 queue

- 状态：完成
- 子 agent：agent-5（与 T4 并行派发）
- 开始：2026-09-29 09:59；完成：2026-09-29 10:09
- 验收证据：主 agent 独立复验——queue 17 测试全过、全套根检查全绿（总计 96 测试）、导出签名与 spec §5 一致
- commit：1de87fa
- 备注：
  - spec 外小防御（主 agent 确认保留）：createTaskQueue 对表名做 `^[A-Za-z_][A-Za-z0-9_]*$` 校验（表名插值进 SQL 的注入防护，fail-closed）；
  - spec 澄清：Task 接口不带 dead_reason 字段，reason 落库 dead_reason 列，查询走 query/直查；
  - query 的 correlation_id 过滤经 json_extract 实现（表无此列，信封 JSON 内提取）。

### T4 registry

- 状态：完成
- 子 agent：agent-6（与 T3 并行派发）
- 开始：2026-09-29 09:59；完成：2026-09-29 10:09
- 验收证据：主 agent 独立复验——registry 16 测试全过、全套根检查全绿、导出签名与 spec §5 一致
- commit：3b54982
- 备注：
  - spec 未定义行为裁决（子 agent 提出，主 agent 确认）：addMatch 对不存在 business_id 抛错（防孤儿匹配行）、removeMatch 幂等不报错、on_failure 恒输出布尔（默认 false）保证字段形状稳定；
  - 子 agent 自修一处内存视图 bug（removeMatch 视图清理遗漏），测试已覆盖。

### T5 channel

- 状态：完成
- 子 agent：agent-7（与 T6 并行派发）
- 开始：2026-09-29 11:52；完成：2026-09-29 12:04
- 验收证据：主 agent 独立复验——channel 19 测试全过（全套根检查全绿，全仓 136 测试）；串行/竞态测试 20 连跑不 flake
- commit：e728f90
- 备注：
  - spec 澄清裁决（主 agent 确认）：ChannelPool.get 每次调用刷新 last_active_at；同通道第二个活跃迭代器首次 next() 即抛错；
  - 并行期间遇到一次对方 install 中间态导致的 dist-test 瞬时缺失（外部竞争，非本包 flake），重跑即过。

### T6 logger

- 状态：完成
- 子 agent：agent-8（与 T5 并行派发）
- 开始：2026-09-29 11:52；完成：2026-09-29 12:04
- 验收证据：主 agent 独立复验——logger 21 测试全过、六项根检查全绿、运行时零依赖、无业务概念、规则第 2 类纪律逐条有测试
- commit：5bcb85e
- 备注：
  - spec 澄清：底层与中层共享包内写口（createFileSink/shouldLog/maskSecrets，不从 index 导出）；SharedControl 作为纯类型导出（FileLoggerOptions 签名需要）；
  - ESM 下 jest 全局不可用，测试改用 `@jest/globals` 显式导入（已加入该包 devDependencies），后续包同此模式。

### T7 env

- 状态：完成
- 子 agent：agent-9
- 开始：2026-09-29 13:40；完成：2026-09-29 13:45
- 验收证据：主 agent 独立复验——env 16 测试全过、六项根检查全绿（全仓 152 测试）、导出签名与 spec §5 一致、运行时零依赖
- commit：822473a
- 备注：
  - spec 未定义行为裁决（主 agent 确认）：trim 仅用于"未设置"判定，getString 返回原始值；default 与 required 同时给时 default 优先；
  - 类型收窄用例经独立 `tsc --noEmit --strict` 验证（重载双向正确），包 tsconfig 排除 tests 的全仓约定未动；
  - 工程修复：`.gitignore` 的 Python venv 规则（`env/`）误伤 `packages/env/`，已加 `!packages/env/` 例外。

### T8 scheduler

- 状态：完成
- 子 agent：agent-10
- 开始：2026-09-29 14:20；完成：2026-09-29 14:45
- 验收证据：主 agent 独立复验——scheduler 28 测试全过（4 套件）、六项根检查全绿（全仓 180 测试）；串行/并行/竞态用例子 agent 连跑 20 次不 flake，主 agent 复跑确认
- commit：9175cef
- 备注：
  - 主 agent 修正一处 spec 笔误并同步实现：派生事件 event_id 用 `newEventId()`（`evt_` 前缀，与 contracts 约定一致），spec §5.2 已更正，测试加前缀断言；
  - 子 agent 合理裁决（主 agent 确认）：settle 防御分支——任务已 dispatch_error 死信时跳过 complete（防 dead 复活成 done）；onActivate 在首次 start() 注册；dead_reason 测试经 db 直查断言（query 不返回该字段，不改上游包）。

### T9 exit-tools

- 状态：完成
- 子 agent：agent-15（首次派发的 agent-13 因 spec 范围修订被中止重做）
- 验收证据：主 agent 独立复验——exit-tools 33 测试全过（4 套件）、六项根检查全绿（全仓 238 测试）
- commit：27eea75
- 备注：
  - 范围修订（用户）：七个工具全登记 = 3 实现（wecom-webhook/mail/webhook）+ 4 占位（wecom-aibot/github/jira/confluence，implemented:false，destinationOf/bind 抛「未实现」）；占位工具补实现是独立后续任务；
  - 全仓首个外部运行时依赖 nodemailer（用户批准）；
  - 子 agent 合理裁决：mail 的 secure 归一化进注入 config；企微工具不复用 postJson（要判 errcode）；对象 payload 渲染两工具一致带 json 围栏。

### T10 workflow-runner + 业务 SDK

- 状态：完成
- 子 agent：agent-14
- 验收证据：主 agent 独立复验——runner 11 + sdk 14 测试全过、六项根检查全绿、runner 无 process.env、无残留子进程
- commit：84f0d77
- 备注：
  - **SDK 位置与依赖规则修订（用户）**：sdk/ → packages/sdk/；允许依赖零依赖纯包（contracts 类型、logger 纯函数层），发布形态 = 平台 esbuild bundle 注入；sdk.log 定位为平台管控的日志控制点（源头脱敏、将来注入 run 级关联字段）；
  - **数据分类落地（用户）**：runner 路径从 businesses/{三维}/runs|logs 改为 runs/{三维}/{run_id} 与 logs/businesses/{三维}/{run_id}.log（七类数据分类，console-design §6）；
  - 迁移修正：tsconfig extends 路径、jest config 路径、fixture 引用路径、根 workspaces 收编为纯 packages/* + app/*；
  - 子 agent 合理裁决：判定优先级交叉（超限>结果>超时>exit code>missing result）；duration_ms 附在 reason 尾部；重复出口 exit 拦截落穿隐患已修。

### T11 agent-service

- 状态：完成
- 子 agent：agent-16（与 T15 并行派发）
- 开始：2026-09-29 23:02；完成：2026-09-29
- 验收证据：主 agent 独立复验——agent-service 13 测试全过（2 套件）、六项根检查全绿、抽查 pi-runner/socket-server 源码与 spec §5 一致
- commit：7aa0105
- 备注：
  - **真 pi RPC compact smoke 未做**（需真实模型凭据，子代理不碰凭据）——留待人工/T12 联调验证；若 RPC 绑定既有会话有障碍，按 spec §8.8 降级为 pi SDK helper；
  - 子代理合理裁决（主 agent 确认）：审计 extension 路径向上查找解析（dist 与 dist-test 深度不同）；close 后新连接必 ECONNREFUSED，故 service_closed 只覆盖挂起请求；compact argv 补同套白名单 flag（纪律一致）；审计事件体 provider/model 防御式提取（真 pi smoke 时核对）；
  - 依赖协议统一：agent-service 的 `@asterisk/agent-logger` 改为 `0.1.0`（与 scheduler/workflow-runner 存量形式一致）；
  - 并行冲突：T15 的 templates/ 自带 tsconfig 导致根 `yarn lint` 的 typescript-eslint 解析崩溃——根 eslint.config.js ignores 加 `templates/`（随 T15 提交）。

### T15 程序包模板

- 状态：完成
- 子 agent：agent-17（与 T11 并行派发）
- 开始：2026-09-29 23:02；完成：2026-09-29
- 验收证据：主 agent 独立复验——`bash scripts/verify-template.sh` 全绿（真实 npm install 408 包 + 模板六条命令全过 + e2e 2 用例）、根 format:check 绿、workspaces 无 my-package、模板内无 `../..` 相对路径
- commit：728488b
- 备注：
  - spec §4 回写 prettier 实际格式（package.json engines、eslint.config.js、main.test.ts 三处折行，无语义变化）；
  - README 按 §4.10 提纲成文，内容均取自 spec 既定表述。

### 资产模型定案（设计修订，非任务）

- 日期：2026-09-30
- commit：4618117（设计文档）
- 内容：资产单元从单一程序包演进为三族——包（业务代码单位，不共享）/ 工具（可复用代码组件）/ skill（可复用提示词组件）；git 三元组（url+commit+子路径）标识、属主 + 共享标记（创建时定、不可改）；EnvProvider 三类并为普通/安全两桶；平台不再内置资产（无 public/packages/、无 content/ 母本树）。`package-model.md` 删除，`asset-model.md` 全新编写；glossary 新增「核心组成关系」整体说明；core-modules/console-design/accounts/scheduler-loop-contracts/security/business-workflow/骨架同步。
- 影响：T16 spec 重写为 asset-registry（原 package-registry spec 作废，spec 文件改名 2026-09-30-t16-asset-registry-spec.md）；T17 描述同步（EnvProvider 两桶 + 资产绑定三族纳入）；T15 模板需小幅修订（清单删 skills、删内嵌示例 skill、main.ts 示例注释），随 T16 批次一并处理；T1–T11 已提交代码零改动（grep 证实 packages/ 内无可见性/services/资产相关代码）。

### T16 asset-registry

- 状态：完成
- 子 agent：agent-18（单发）
- 开始/完成：2026-09-30 22:31
- 验收证据：主 agent 独立复验——asset-registry 38 测试全过（2 套件，覆盖 spec §6 全部条目：ref 解析含注解 tag、幂等/属主维度唯一性、私有凭据流程、脱敏哨兵、ssh 拒绝、materialize 幂等与补拉、四类 validation_failed、持久化重开）、根六连全绿（build/test/typecheck/lint/format:check/circular）
- commit：10d8b66
- 设计修订随附（前置提交 7f47c02）：私有仓库凭据机制定案——`is_private` + `credential_key`（只存名字不存值）、凭据按**操作者维度**由调用方解析传入、进程内临时改写 https url 注入 + 错误脱敏、ssh url 不支持注入；平台不建读写权限模型（token 即权限）；总纲提示词补入组成公式（业务资料字段、不是资产、不共享）；AGENTS.md 沉淀「主动补全细节」核心原则（6f78da0）。
- 子代理合理裁决（主 agent 确认）：`commit` 是 SQLite 保留字，列名加双引号建表（列名不变）；`git ls-remote` 需同时传 `<ref>` 与 `<ref>^{}` 两个 pattern 才能拿到注解 tag 剥离行。
- 后续修订（commit 56f5590，用户审出）：`requires` 收为 **package 专属字段**——工具是叶子组件（机械能力、零 token），tool 清单出现 requires 即 `validation_failed`（防误配，也避免传递依赖解析与循环防判的复杂度）；AssetManifest 判别联合随之拆为 package/tool/skill 三支。asset-model §5.1 / T16 spec / T17 spec 同步。

### T17 runtime

- 状态：完成
- 子 agent：agent-19（单发）
- 开始/完成：2026-10-02 09:07
- 验收证据：主 agent 独立复验——runtime 25 测试全过（env-provider 8 / context-loader 9 / lifecycle 8）、registry 24 过（原 16 零改动 + 新 8）、workflow-runner 13 过（原 11 零改动 + 新 2）、根六连全绿、dpdm 无环（scheduler 仅 import type）
- commit：e8e16ee
- 设计要点（spec 决策点，用户已审）：channel_id 本包用 buildBusinessChannelId 自算（scheduler 零改动）；ContextLoader 不碰 ChannelStore（agent-service 自持 mapping）；RunRequest 加可选 run_id（四步时序要求 serve 先于 runner 且共知 workspace）；lifecycle_id 即 run_id；secrets 第一版明文存 platform.db；ExecutionResult.usage 暂不填；全局配额默认走工厂参数（ConfigStore 未实现）。
- 子代理合理裁决（主 agent 确认）：两表迁移常量放 env-provider.ts（spec §5.2 同节），lifecycle-store 复用；lifecycle 测试的 Task 类型经 `Parameters<EntryDriver["execute"]>[0]` 取，避免引入 spec 依赖清单外的 agent-queue。
- 同批前置修订（设计讨论沉淀，commits 1fb7e38 / 74ad373）：asset-model §7.1 补「注入差异」（sdk.run 子程序拿不到 secrets/endpoint、token 显式传递、依赖两层面）与「路径纪律」（跨资产禁相对路径）；console-design §6 repos 缓存路径加 host 维度（github/gitee 克隆各自独立）。

### T12 server

- 状态：完成
- 子 agent：agent-20（单发）
- 开始/完成：2026-10-04
- 验收证据：主 agent 独立复验——server 20 测试全过（config 5 / self-check 7 / exit-driver 6 / integration 2）、根六连全绿（build/test/typecheck/lint/format:check/circular）、spec §7.5 smoke（缺 AGENT_WORKSPACE 退出码 1；fixture 环境启动 → SIGTERM 优雅停 exit 0）、集成测试连跑 10 次全过
- commit：2dbb911（spec 与设计对账前置提交 35e589c）
- spec 两轮修订要点（用户已审）：webhook 入口适配器后移 T18（外部业务推送形态复杂，验签/会话标识/幂等随 T18 单独设计）；AibotConnector 维持归企微入口任务；入口流量与管理 API 各自独立 HTTP 服务；集成验证入口 = 直接落队（等价入口适配器的本质动作）；自检覆盖 git（asset-registry 的 git 子进程依赖）、node 不查（runner 用 process.execPath 恒真）；server 是空平台、console 是配置唯一生产入口。
- 同批设计对账（commit 35e589c）：core-modules §1/§2/§4.7/§5 对账 monorepo（补装配层、IdGen/Clock 收敛为 contracts 纯函数、ContextLoader 不碰 ChannelStore、§5 布局以 T0 spec 为准）；骨架 §2 总体架构图补装配层；新增模块组织图双格式源 `design/architecture-overview.puml/.mmd`（一循环一队列、通道池两池、通道池保序 vs 闸门限流）；AGENTS.md 新增核心原则 9「重大变更先确认」。
- 子代理合理裁决（主 agent 确认）：① config.ts 对单键做「保存→设置→调用→恢复」桥接以委托 env 包解析（env 包只读 process.env 的既定边界不变，config.ts 本就是 spec 允许的触点）；② git 自检测试改为真实子进程置空 PATH（jest ESM realm 改 process.env 不传播到 spawn 子进程）；③ 集成 fixture 程序写一行 stderr（runner 业务日志首行写入时才懒建文件）；④ server 包 test 脚本前缀全量 build（jest 跑编译产物需上游 dist 就绪）。

### T13 管理 API（console-api）

- 状态：完成
- 子 agent：agent-21（单发）
- 开始/完成：2026-10-06
- 验收证据：主 agent 独立复验——根六连全绿（FINAL_EXIT=0，circular 仅 exit-tools 既有噪音）；console-api 56 测试全过（8 套件）；asset-registry 43（+4 remove 用例）、registry 27（+3 list 用例）、app/server 24（+2）；抽查 accounts.ts（scrypt 自包含串 + timingSafeEqual、32 字节随机 token）、server.ts（不读 process.env）、bootstrap.ts diff（步骤 8.5 装配、清理链与 stop 先关 API 入口）与 spec §5 一致
- commit：5e8b86a（spec 前置提交 006929a）
- 范围（spec 决策点，用户已审）：账号体系全量落地（users/console_sessions、scrypt、httpOnly cookie 7 天固定有效期、首启 admin 由 AGENT_ADMIN_USERNAME/PASSWORD 注入、注入失败不阻断启动）；API 契约不进 contracts——DTO 由 console-api 包根导出，T14 console type-only 复用；ConfigStore 不做（GET /api/config 只读回显，改全局参数 = 改 env/config.json 重启）；监控全部只读（任务终止/重试后续立项）；私有资产凭据统一从通用层安全桶解析（env.getFor("")）。
- 契约增补（用户已确认）：`AssetRegistry.remove`（下架=删行+清缓存，不校验在役引用）、`BusinessRegistry.list`（业务列表读口）。
- 子代理合理裁决（主 agent 确认）：① 依赖版本沿用仓内 `"0.1.0"` 形式（workspaces 按版本匹配软链）；② 补错误码 `payload_too_large`（413 需统一错误体，spec 表外最小新增）；③ `CreateBusinessBody.entry_config` 经 create 后 removeMatch+addMatch 落定（CreateBusinessInput 无该字段，既有契约不动）；④ changePassword 失效范围 = 该用户全部会话（含当前，与测试清单一致）；⑤ member `GET /api/assets?scope=all` = 其可见全集（mine+shared）；⑥ 'missing' error 日志由 console-api 内记录（start 内调用，app/server 无从观察返回值）。

### T14 控制台 SPA（app/console）

- 状态：完成
- 子 agent：agent-22（单发）
- 开始/完成：2026-10-07
- 验收证据：主 agent 独立复验——根六连全绿（FINAL_EXIT=0，circular 仅既有噪音）；console 24 测试全过（6 套件：api-client/auth-guard/login/business-form/assets/pages-smoke）；console-api 63（+7 静态托管）、app/server 26（+2）不回归；抽查 static.ts（路径穿越防护 resolve 越根 404、SPA 回退、/api 优先、hash 产物 immutable）与 BusinessEditPage secret 分流（exit.{kind}.{field.key} 硬契约、secret 不进 ExitBinding.config、回填占位）与 spec 一致；冒烟实证：vite build 产物存在、server 托管下 GET / → index.html、/api/auth/me → 401、SPA 回退与缓存头正确
- commit：97b40c6（spec 前置提交 db844bd）
- 范围（spec 决策点，用户已审）：antd v5 组件库、六页一次做全（统计搜索页不做）、生产 = server 同进程托管静态文件（AGENT_CONSOLE_STATIC_DIR）+ 开发 vite proxy、React 18 + Vite 5、测试不用 vitest（esbuild --bundle 内联 antd 解决 CJS 解析）、编辑页 env 独立保存、入口/关注统一为匹配行编辑。
- 子代理合理裁决（主 agent 确认）：① esbuild --bundle 下 setupFiles 与测试各持一份 @testing-library/dom，configure 放 helpers.tsx；② jsdom + antd cssinjs 下 userEvent 的 pointer-events 检查极慢，setupUser() 统一关闭；③ @jest/globals 会被 bundle 进产物报错，api-client 测试用计数闭包代替 jest.fn；④ antd 双中文字符按钮空格渲染不稳定，测试用 /^登\s?录$/ 类正则；⑤ 路径穿越测试改用 %2f 编码斜杠重组（%2e%2e 被 WHATWG URL 预折叠）；⑥ jest testTimeout 120s（antd 全量 jsdom 重交互单条可达 35s）；⑦ eslint-plugin-react-hooks 用 ^7（peer 声明支持 eslint ^10）。
- 遗留（非阻塞）：console 测试全量约 2 分钟（jsdom+antd 固有成本）；vite build 有 500KB chunk 警告（antd 体积，未做代码分割）；yarn install 对 vite 依赖链 esbuild@0.21.5 build scripts 有警告级提示，实测不影响构建。

### T19 组合机制回炉（真机验证驱动）

**T19a 平台侧**

- 状态：完成
- 子 agent：agent-23（单发）
- 开始/完成：2026-10-07
- 验收证据：主 agent 独立复验——根六连全绿（exit 0，test 2m3s，circular 仅既有噪音）；diff 面抽查 34 文件无越界（未动 app/console 业务编辑页、未动 docs/、未动既有迁移 v1/v2）；SettingsPage `Record<keyof EffectiveConfigView>` 穷举映射因新字段挂 typecheck 是 spec 盲区，主 agent 补 2 行标签（models/agents）后全绿
- commit：0a54f1b（设计修订 1823282、spec 前置 b22c0ab）
- 范围：runner 信封/RunRequest 增加 programs（信封可选、RunRequest 必填）；sdk.run 按名查表（未知名抛错含可用名列表；子程序信封不带 programs，叶子语义物理成立）；ContextLoader 全量映射（同名首个命中，与 resolveResource 同语义）；registry model 缺省 'qwen3.8max'→''+迁移 v3 清历史行；console-api binding-validation.ts（存在性/凭据/权限含 admin 不例外/entry_program/程序名查重/skill 查重/requires 覆盖/model·agent_kind 合法性，全量收集一次 400；patch 不碰绑定字段零校验零物化；顺带落实业务初始化物化）；server models.ts（loadModelList 产 provider/id 全量、不读 apiKey）+ 自检④增强 + configView models/agents；模板 README 补包内程序 vs 共享工具分工
- 已知取舍（spec 不做项）：assets.get 同步物化阻塞管理 API 事件循环（配置期低频，接受并注释）；model 必填仅 console 表单强制（API 保持机械存储纪律，只做合法性校验）

**T19b console 业务编辑页重做**

- 状态：完成
- 子 agent：agent-24 两次派发均因模型 API 请求挂起超时（2h×2，wire 日志证实单次 llm.request 无响应 ~7500s，非工作循环；探索完成零改动），**主 agent 接手直接实施**
- 开始/完成：2026-10-07 ～ 2026-10-08
- 验收证据：console 28 测试全过（6 套件；business-form 9 条含新增 4 条）；根六连全绿（test 4m14s）；两处 prettier 格式问题 prettier --write 后复验 format/lint/typecheck 全过
- commit：8d8a38f
- 范围：agent/model 下拉 /api/config 驱动（删除全部硬编码；创建模式 agent 默认 agents[0]、model 必选无默认；编辑态原值不在可选集合标黄）；包/工具/skill 空列表引导 + 跳资产管理链接；出口机密项 已配置/未配置 Tag + 键名 exit.{kind}.{field.key} 标注 + 创建/编辑去向提示；叹号提示按「是什么/何时用/配错的后果」三段式重写（13 个模块）；资产绑定卡 Alert 补包/工具/skill/入口程序关系说明
- 实施中发现并处理：antd Select aria-label 命中多节点（测试取 INPUT，同 selectOption 惯例）；「请选择模型」占位文案与校验文案同词（断言限定 .ant-form-item-explain-error 内）；同步 getAllByLabelText 撞上 auth 加载态 spinner（先 await findByLabelText 业务名称）；同测试双 renderApp 撞查询范围（先 unmount 再挂）

**T20 包名改名 + sdk 发布准备**

- 状态：完成
- 执行：主 agent 直接实施（机械改动不派子代理）
- 开始/完成：2026-10-08
- 依据：`docs/decisions/2026-10-08-package-scope-rename.md`（无 spec，决策文档即依据）
- 验收证据：根六连全绿（build/test/typecheck/lint/format:check/circular exit 0；test 4m15s 含 console 28 条；sed 改名致 2 文件行宽越界，prettier --write 修复后复验）；`npm publish --dry-run` 通过（@asterisk/agent-sdk@0.1.0，12.2 kB，29 文件，registry npmjs + access public）；全仓 grep 无 `@easemob/agent-` 残留（`@easemob.com` 邮箱与 v2 参考包 `@easemob-agent/jira-mcp` 不受影响）
- commit：03860ec
- 范围：114 文件 sed 替换（15 packages + app/* + templates + scripts + docs）；yarn.lock 重新生成；sdk package.json 移除 private、补 files/publishConfig(access public)/prepublishOnly(发布前强制 build)；README「不对外发布」表述修正为「仅 sdk 对外发布」
- 待办：npm publish 由用户执行（需 npmjs @asterisk scope 登录态），必须早于 T22 真机验证（物化构建 npm ci 需从 registry 解析 sdk）

**T21a 物化构建链路 + 信封 dataDir + 出口 null 跳过**

- 状态：完成
- 子 agent：agent-26（单发，一次通过）
- 开始/完成：2026-10-08
- 验收证据：主 agent 独立复验根六连全绿（exit 0；test 4m26s 含 console 28 条；circular 零循环）；抽查 materialize.ts / exit-loop.ts / sdk.ts 与 spec §4/§5/§6 逐条相符；spec §12 T21a 测试清单逐条有落（含独立 CLI 跑通、stderr 尾 30 行、skill 不构建、子程序信封不含 dataDir）
- commit：63c3116
- 范围：asset-registry（materializeFromGit 共享实现 + materialize-cli + validate 两阶段拆）、workflow-runner（信封 dataDir + 三维目录派生）、sdk（dataDir()）、scheduler（出口 null 跳过）、server（AGENT_NPM_REGISTRY + 自检⑥npm ⑦registry 可达，runSelfCheck 改 async）、模板（agent.materialize.mjs 默认实现 + README）
- 已知取舍：npm ci 加 --no-audit --no-fund（零依赖场景不触网）；自检⑦有任何 HTTP 响应即算可达（不判状态码）；CLI kind 按「是否含 agent-package.json」探测（平台路径必传真实 kind）
