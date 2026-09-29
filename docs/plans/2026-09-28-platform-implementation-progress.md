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
| T7 env | 未开始 | — | — |
| T8 scheduler | 未开始 | — | — |
| T9 exit-tools | 未开始 | — | — |
| T10 WorkflowRunner + SDK | 未开始 | — | — |
| T11 AgentService | 未开始 | — | — |
| T12 server | 未开始 | — | — |
| T13 管理 API | 未开始 | — | — |
| T14 console | 未开始 | — | — |

> 2026-09-28 计划变更：插入 T2 database（core-modules §4.7 唯一数据访问口的落地），原 T2–T12 顺延为 T3–T13。
> 2026-09-29 计划变更：「依赖管理四类归宿」顶级规则定稿；插入 T7 env，原 T7–T13 顺延为 T8–T14；T6 logger 改为全局外观形态。

## 任务记录

### T0 工程骨架

- 状态：完成
- 子 agent：agent-2（前台派发）
- 开始：2026-09-28 12:04；完成：2026-09-28 12:15
- 验收证据：主 agent 独立复验 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` + `import '@easemob/agent-contracts'` 全绿
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
