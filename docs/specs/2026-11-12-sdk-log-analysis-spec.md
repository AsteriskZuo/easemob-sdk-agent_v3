# spec：第二个平台业务迁移——SDK 日志分析（sdk-log-analysis）

- **日期**：2026-11-12
- **状态**：已评审（2026-11-12 用户确认四点决策 + v2 生产过滤规则平移，见 §13）
- **迁移源**：`/Users/asterisk/Codes/easemob/sdk-log-bot`（下称 log-bot；其 OpenSpec 文档为业务语义的事实来源，本 spec 已内联所需全部规则）
- **过滤规则来源**：`/Users/asterisk/Codes/ai/easemob-sdk-agent_v2`（v2 生产环境的审查→下游派发规则，§4.3 逐条平移）
- **结构参照**：`docs/specs/2026-10-09-t22-jira-ticket-review-migration-spec.md`（首个业务迁移 spec，下称 T22）
- **红线**：**不修改既有业务仓 jira-ticket-review**（用户 2026-11-12 明确：业务彼此独立，联系仅契约）。v3 平台**仅允许三处已批准的小改**（用户逐次明确，详见 `docs/specs/2026-11-13-pi-tools-whitelist-spec.md` 与决策 D9）：① pi 工具白名单 + 路径守卫；② stdin 信封注入 `cacheDir` 字段 + `sdk.cacheDir()` 读口；③ 平台定时任务规则（后续任务，决策 D10）。除这三处外平台零改动；实现中若发现新的平台缺口（契约不符、缺机制），**停下报告用户，不擅自修改平台**。

## 1. 背景

v3 平台与首个业务（jira-ticket-review）已跑通，本任务迁移第二个业务：**SDK 日志分析**——给定一个 Jira 工单，拉取工单与其日志附件，按工单涉及的 SDK 版本检出对应源码，由大模型对照源码与日志做根因分析，产出结构化报告并通过企业微信通知。

log-bot 项目中，`add-jira-analysis-input`（Jira 工单作为分析输入）与 `add-rest-jira-analysis-webhook`（HTTP 触发 + 企微通知）两个变更已经形成了我们需要的完整单轮流程，本次迁移的就是这条流程的内容与规则；入口、队列、通知投递、agent 运行时全部交给平台。

本任务同时是**平台业务编排能力的首次实战**：日志分析业务的输入不是独立事件源，而是上游「工单审查」业务的产出——审查通过（pass）的工单自动流入日志分析。

## 2. 范围

**做**：

- 新业务仓 `business/sdk-log-analysis/`（独立 git 仓，同 T22 模式），三资产：
  - `package/`：包资产——胶水代码 + 三个平台保留程序（main / check-input / check-output）
  - `skills/`：skill 集合资产——`sdk-log-analysis`（SKILL.md，内容移植自 log-bot `sdk-knowledge/`）
  - `tools/jira-log-fetch/`：工具资产——jira 登录 + 拉工单 + 日志附件下载 + 脱敏
- 编排接线：日志分析业务订阅审查业务的派生事件（§3），平台零改动
- 下游自持过滤（§4.3，v2 生产规则平移）：负责人无 sdk 标签不分析、终态/非 Bug 复核跳过
- 业务仓六连（build/test/typecheck/lint/format/circular）全绿；local-runner 独立调试跑通

**不做**（明确范围外）：

- log-bot 的企微长连接 bot、REST webhook 服务、内存任务队列、流式回复、周报（weekly-report）、纠错闭环（correction-*）、确认修复 + PR 流（fix-engine）——平台已替代或本期不需要
- **结果不写 Jira comments**（用户 2026-11-12 明确）——分析结果只通过企业微信通知；`jira_add_comment` 等任何 Jira 写操作都不做，本业务只读 Jira
- mainline 审计的「已修复」结论只读展示，不做任何源码修改
- jira-ticket-review 业务仓的任何改动；v3 平台代码仅允许三处已批准的小改（见红线与决策 D9/D10）

## 3. 编排链路（核心设计）

### 3.1 机制：平台原生派生事件（已内置，非新能力）

平台入口循环在业务 run 成功后自动构造派生事件并扇出（`packages/scheduler/src/derive-event.ts` + `entry-loop.ts`）：

- `source = 'internal'`（contracts 包 EventSource 枚举的一等公民：`"internal" = 平台内派生事件`）
- `event_type = '{产出方 business_id}.completed'`（失败时为 `.failed`）
- `payload = 业务输出原样`——注意 `metrics` 是平台保留键，workflow-runner 在扇出前已从 output 剥离进 run_metrics，**下游 payload 里看不到 metrics**
- `session_id` / `correlation_id` 继承上游（全链溯源不变）；`hop_count + 1`，超 `config.hop_limit`（默认 8）防循环死信
- 派生事件同时投入口队列（下游业务关注者消化）与出口队列（产出方自己的出口绑定投递）

### 3.2 接线方式

日志分析业务注册一条匹配行：`source = 'internal'`，`event_type = '{审查业务 business_id}.completed'`（控制台创建业务时配置；当前开发环境审查业务 id = `b01M4QSEAC5MZA2N2RTNMEDDCX1`，以实际登记为准）。

链路全景（即用户 2026-11-12 确认的语义：审查输出 → 日志分析输入 → 日志分析输出 → 企微输出）：

```text
jira 事件(hop0) → 审查业务 run → 派生 b01….completed(hop1, payload=审查输出)
   → 出口队列：审查业务的 wecom 绑定 → 审查结论通知（既有行为，不变）
   → 入口队列：日志分析业务命中匹配行 → 日志分析 run → 派生 sdk….completed(hop2)
      → 出口队列：日志分析业务的 wecom 绑定 → 分析报告通知
      → 入口队列：无关注者 → 自然终结
```

### 3.3 为什么不是「webhook 出口回环」

讨论期曾提出方案 A（审查业务的 http 出口回调平台 webhook 入口）。核查后弃用，采用原生派生事件，理由：

1. **原生派生事件就是为编排设计的**（`producer_business_id` 注释：「出口循环按它做归属匹配」），无需任何新配置即可达成同一条链；
2. 回环会丢失 hop_count 链保护与 correlation_id 串联，多一次 HTTP 往返，还要额外维护一条自指配置；
3. 回环与原生机制在业务包内部完全同构，弃用无沉没成本。

### 3.4 下游必须容忍的「正常不做事」输入

审查业务每次 run 成功都会扇出（**包括产出 null 的 run**，平台对 success 一律派生），其中多数不该触发日志分析。日志分析主程序第一步过滤（细节见 §4.2 解析规则）：

1. `payload === null`：审查 skip 路径（去重命中/已终态/非 Bug/模型判 skip）的空产出 → 安静跳过；
2. 首行标题非「工单审查通过」：审查 fail（不通过）的工单不做日志分析（v2 规则「审查失败的工单不进入下游场景业务流转」平移）→ 安静跳过；
3. content 中解析不出工单 key：格式不符的异常输入 → warn 日志 + 安静跳过。

以上一律 `sdk.return(null)` 结束，**不是失败**——下游消费位的纪律：认不出/不该做就不做。

## 4. 包间契约：审查通知格式解析（jira-ticket-review 仓零改动）

用户 2026-11-12 决策：审查业务**不做任何修改**，两业务相互独立，联系仅为输出格式契约——「都按照格式进行约定，谁错谁修改」。因此下游从审查业务的既有通知输出中解析所需信息。

### 4.1 上游输出现状（钉死，勿重新推导）

审查业务 run 成功输出（`business/jira-ticket-review/package/packages/notify-message.ts` 的 `NotifyMessage` 形状）：

```json
{ "content": "<markdown 正文>", "mentions": ["<wecom userid>"] }
```

`metrics` 被平台剥离，下游不可见。content 的稳定形状：

```text
**工单审查通过 ✅**              ← 或 **工单审查不通过 ❌**
                                 ← 空行
> 工单：[HIM-24204](https://j1.private.easemob.com/browse/HIM-24204)
> 分类：Bug                      ← 仅 pass 且分类非空时存在；值域见下，不作为过滤依据
> 审查时间：2026/11/12 15:30:00
                                 ← 空行
（@ 相关提示行，如有）
（审查摘要文本）
```

**重要事实（v2 核查结论，纠 spec 初版之误）**：

- `分类` 行的值域是 `Bug | 类型误标：需求 | 类型误标：其他`（v3 审查 skill 输出契约），**没有「SDK前端」这个分类值**；spec 初版「非 SDK 前端分类不分析」的表述错误，弃用；
- v2 生产里「是不是 SDK 组的工单」的判据是**工单负责人在人员映射表里的 tags 含 `sdk`**（v2 `webhook-delivery-observer.ts` 的 `CATEGORY_SUBSCRIPTION_TAG = "sdk"`），不是模型的分类结论；
- 审查的 `scenarios`（15 个场景 code）与人员标签**不在 content 里**，下游不可见也不依赖——v2 里 scenarios 是「选哪个下游」的路由键（日志分析/crash 分析各有订阅），v3 本平台只有日志分析一个下游，路由键不需要平移；人员标签由下游自查（§4.3）。

### 4.2 下游解析规则（本业务的输入侧契约）

| 目标 | 规则 | 失败语义 |
| ---- | ---- | ---- |
| 是否通过 | content 首行包含 `工单审查通过`（且不含「不通过」） | 非通过 → 跳过 |
| 工单 key | 正则 `\[([A-Z][A-Z0-9_]+-\d+)\]\(` 匹配工单链接行 | 提取失败 → warn + 跳过 |
| 分类行 | **不解析、不过滤**（值域对下游无意义，§4.1） | — |
| mentions | **不消费**（上游 @ 谁与下游无关） | — |

解析逻辑集中在 `packages/notify-parse.ts` 一个模块，单测钉死；上游格式若变更，按「谁错谁修改」原则由责任方调整。

### 4.3 下游自持过滤（v2 生产规则平移，用户 2026-11-12 确认的下游职责）

解析通过后，下游**用自己的 jira-log-fetch 重新拉工单**，基于最新数据过滤（v2 这些规则在上游派发器里，v3 平台公平——上游不知道下游是谁，全部下沉到下游自持）：

| # | 过滤项 | 数据源 | 行为 |
| - | ---- | ---- | ---- |
| F1 | 工单最终形态（statusCategory 为终态，如「完成」） | 工具返回的实时工单 | 写去重记录 + info 日志 + return(null) |
| F2 | 非 Bug 工单 | 工具返回的 issueType | 同上 |
| F3 | **负责人无 `sdk` 标签**（v2 CATEGORY_SUBSCRIPTION_TAG 等价） | 工具 identity 旁路的 assigneeEmail/Name → 本业务自持的 `data/jira-wecom-mapping.json` 查 `tags` | 同上；**负责人查不到映射记录 → 视为无标签，跳过**（v2 同款语义）；标签值走业务 config `assignee_tag`（缺省 `sdk`），不硬编码 |
| F4 | 无日志附件 | 工具返回的 logs 为空 | §6 步骤 5 分支 |

v2 里 F1/F2 上游审查也会挡（终态/非 Bug 不产生通知），下游复核是双保险；F3 是 v2 派发的**实质门槛**，必须平移。新增过滤项按同模式扩展：判据 + 一条测试，不动编排骨架。

## 5. 资产形态与落位

```text
business/sdk-log-analysis/           ← 独立 git 仓（前置：用户建空目录/空仓）
├── package/                         ← 包资产（subpath=package）
│   ├── agent-package.json           ← 清单（name=sdk-log-analysis, version=0.1.0，requires 见下）
│   ├── contract.json                ← 业务契约（§9）
│   ├── agent.materialize.mjs        ← 模板默认实现，原样拷贝
│   ├── package.json / tsconfig.json / eslint.config.js / jest.config.mjs / .prettierignore / .gitignore
│   ├── data/
│   │   └── jira-wecom-mapping.json  ← 人员映射表（从审查业务仓原样拷贝，含 tags；@ 处理人用 + F3 过滤用）
│   ├── apps/
│   │   ├── main/index.ts            ← 主程序（薄壳：读信封 → analysis-flow → sdk.return/fail）
│   │   ├── check-input/index.ts     ← 模板薄壳原样（契约全 optional，见 §9）
│   │   └── check-output/index.ts    ← 审查业务仓版本（null 逃生门 + checkMetrics）
│   ├── packages/
│   │   ├── analysis-flow.ts         ← 主编排（§6）
│   │   ├── analysis-records.ts      ← 去重记录（§6.2）
│   │   ├── notify-parse.ts          ← 审查通知解析（§4.2）
│   │   ├── person-mapping.ts        ← 从审查业务仓原样拷贝（lookupWeComAccount + lookupPersonTags，含 pinyin-pro 依赖）
│   │   ├── ref-resolver.ts          ← SDK 版本/分支选择（§6.5，移植 log-bot 规则）
│   │   ├── worktree.ts              ← git worktree 管理（§6.6，移植 log-bot 规则）
│   │   ├── materialize.ts           ← conversation.md / task-context.md 落盘（§6.7）
│   │   ├── report-parse.ts          ← 模型报告 JSON 解析（多策略兜底，参照 review-output.ts 模式）
│   │   ├── mainline-audit.ts        ← msync 主线审计（§6.9）
│   │   └── notify-message.ts        ← 分析报告企微消息组装（§6.10）
│   └── tests/
├── skills/
│   └── sdk-log-analysis/
│       └── SKILL.md                 ← §8
└── tools/
    └── jira-log-fetch/              ← 工具资产（subpath=tools/jira-log-fetch）
        ├── agent-package.json       ← 工具清单（无 requires）
        ├── agent.materialize.mjs    ← 模板默认实现
        ├── package.json / tsconfig.json / eslint.config.js / jest.config.mjs / .prettierignore / .gitignore
        ├── src/
        │   ├── programs/
        │   │   └── jira-log-fetch.ts ← 入口程序（§7；布局同审查业务工具 src/programs/）
        │   ├── jira-client.ts       ← 审查业务 jira-fetch 的 jira-client 基础上补附件下载
        │   ├── masking.ts           ← 从审查业务仓 tools/jira-fetch/src/masking.ts 原样拷贝，不改脱敏规则
        │   └── log-ingest.ts        ← 附件筛选/解包/编码归一/限额（§7，移植 log-bot 规则）
        └── tests/
```

资产登记（手动验证时在控制台操作）：三资产同一 git url + 同一 commit，subpath 分别为 `package` / `skills` / `tools/jira-log-fetch`。

## 6. 包胶水编排（analysis-flow.ts）

输入：`sdk.input()` 得事件信封（派生事件，payload = 审查输出 `{content, mentions}` 或 null）。流程严格按序：

1. **输入过滤**（§3.4 + §4.2）：payload 非对象/null → return(null)；标题非通过 → return(null)；解析 issue_key 失败 → warn + return(null)。解析出的 issue_key 透传后续步骤。
2. **拉取工单与日志**：`sdk.run('jira-log-fetch', { input: { issue_key, workspace_subdir: 'input' }, config: {...} })`（§7）。返回 `status: 'error'` → `sdk.fail(...)`（ticket_not_found / authentication_failed 等原样透出）。工具已把归一化日志落在 run workspace `input/logs/`、脱敏工单快照落在 `input/jira-issue.json`；identity 旁路（assigneeEmail/Name 等）随返回带上。
3. **自持过滤**（§4.3）：实时工单 statusCategory 终态（F1）/ issueType 非 Bug（F2）→ 写去重记录 + info 日志 + return(null)；工具 identity 的 assignee 查本业务映射表，tags 不含 `config.assignee_tag`（缺省 `sdk`）或查不到人（F3）→ 同样安静跳过。
4. **去重**：`sdk.dataDir()` 下 `analysis-record.json` 记录 `{ last_analyzed_updated }`；工具返回的实时 `ticket.updated` 与记录相同 → return(null)；`updated` 缺失 → 不去重（每次都分析）+ warn。原子写（temp + rename）。同 session（= 工单 key）run 串行，无需自锁。**去重锚点用下游自己拉到的实时 updated**（上游输出里没有 updated 字段）。
5. **无日志分支**：`logs` 为空 → 写去重记录（reason='no_logs'）+ info 日志 + return(null)。**决策点 D2**：不通知、不失败——审查 pass 的工单不带日志附件是常见情形，通知会制造群噪音；控制台 run 记录里可见跳过原因。
6. **SDK 源码 ref 选择**（§6.5）：歧义无法消解 → `sdk.fail`（消息带候选列表，可行动失败）。
7. **worktree 准备**（§6.6）：ref 解析/检出失败 → `sdk.fail`。
8. **材料化**（§6.7）：`input/conversation.md` + `task-context.md` 落盘。
9. **大模型分析**：`sdk.agent({ skills: ['sdk-log-analysis'], input, mode: 'fresh' })`（§6.8，含 pi 适配纪律）。输出解析失败 → `sdk.fail('分析报告解析失败')`（先 `typeof === 'string' ? : JSON.stringify(...)`）。
10. **mainline 审计**（§6.9）：第二次 `sdk.agent`（fresh）+ git 只读验证；任何异常 → 降级 `unknown` 继续，**不 fail run**。
11. **组装输出**（§6.10）→ 写去重记录 → `sdk.return({ content, mentions, issue_key, url, root_cause, confidence, mainline_status, summary, metrics: {...} })`。`url` 由本业务 `config.jira_url` + key 自行派生（自持，不依赖上游）。

**日志纪律**（对齐 T22 §5）：每个关键节点一条 `sdk.log`——过滤原因（含解析出的字段值）、工单拉取结果（附件选中/跳过清单）、自持过滤命中项（F1/F2/F3 哪个）、去重命中、ref 选择结果与依据、worktree 路径与 commit、**大模型原始输出（完整文本，第一现场）**、报告解析结果、审计结论、通知组装结果。

### 6.5 ref 选择规则（移植 log-bot，一字不改语义）

优先级递减：

1. 工单叙述文本（summary + description）中显式出现的 branch / tag / commit / remote ref；
2. Jira `versions`（受影响版本）中唯一无歧义的值，归一化规则：`4.19.1` / `SDK 4.19.1` / `SDK_4.19.1` → `SDK_4.19.1`；
3. 已下载日志内的 `core version` 行。

多个候选版本时，可用日志 `core version` 消歧；仍歧义 → 失败并列出候选（不猜）。`fixVersions` 只是上下文，**绝不参与选 ref**（它通常指向修复目标版本）。选中值与依据（provenance）写入 `task-context.md`。

**解析失败回退主线（log-bot `fallbackRef` 语义）**：选中 ref（含归一化后的 `SDK_` tag）在解析阶梯（§6.6）中最终失败（含网络 fetch 失败）→ **回退 `config.mainline_ref`（缺省 msync）重试一次**，provenance 追加「ref 'X' 未命中，回退主线 msync」，版本置信度记 branch-head——log-bot ref-resolver.js 给版本推导 tag 附带 `fallbackRef = repo.defaultRef` + repository-set.js preparer 失败回退继续分析的同款语义（2026-11-13 用户核对 v2 生产代码确认的补移植）。选中的 ref 本来就是 mainline_ref 时不自我重复、直接失败；连主线也失败才 `sdk.fail`。

### 6.6 源码仓缓存与 worktree 规则（2026-11-13 重设计：远端仓 + bare 缓存 + 锁协议）

**实测依据（2026-11-13，GitHub 直连）**：emclient-linux bare clone **20 分钟未完成**（>80MB 时仍在下载）；本地热仓 `worktree add` 任意分支 **1.2–1.9s**，两个不同 commit 并发 add 各 1.5s 无冲突。结论：**「每事件拉仓」不可接受**——仓必须缓存，慢操作挪到闲时（预热见决策 D10）。

- **仓来源**：`sdk.config().sdk_repo_url`（控制台登记的**远端 URL**，如 `https://github.com/easemob/emclient-linux`）——不再是运行机本地路径；业务只认 URL，仓怎么来的（克隆/预热）是缓存层的事。
- **缓存结构**：bare 仓缓存于 `{sdk.cacheDir()}/repos/{slug}/`。`slug` = URL 归一化目录名（协议剥除、`/`→`-`，如 `github.com-easemob-emclient-linux`）。`cacheDir` 是信封新注入字段（平台小改，决策 D9）= `businesses/{business_id}/cache/`，与既有 `cache/agent-sessions/` 同根。bare 仓无主检出、含全部分支与 tag，体积最小。
- **首克隆（锁内，三动作之一）**：缓存目录不存在 → 取 `{cacheDir}/repos/.lock`（mkdir 原子锁；持锁超时的残留锁按 mtime 收割后重取，防崩溃死锁）→ `git clone --bare {url} {目标}.tmp-{pid}` 到临时目录、成功后 rename 到正式目录（防半成品）→ 释放锁。
- **ref 解析阶梯**（全部在 bare 仓上执行，一律 `--no-tags`）：
  1. 本地 `rev-parse --verify {ref}^{commit}`；
  2. 解析不到 → **锁内** `git fetch --no-tags origin`（三动作之二；缓存仓只有单 origin = sdk_repo_url，log-bot 的 ALLOWED_REMOTES 白名单随之废除）→ 再解析；
  3. 仍解析不到且 ref **形如裸版本号**（`^\d+\.\d+(\.\d+)?$`）→ 按 §6.5 归一化规则得 `SDK_{version}` tag **重试一次**（真 e2e 实证：叙述里的 `5.1.0` 是 emclient-ios 的 tag，verbatim 拿到 linux 仓解析不到）；
  4. 仍失败 → 单独 fetch 该精确 ref，用校验过的 `FETCH_HEAD` 检出；
  5. 最终失败 → 交编排层回退主线（§6.5）：回退成功则继续分析；回退也失败（或选中的本来就是主线）才 `sdk.fail`，带 ref 值与脱敏 git stderr 摘要。
- **检出**：`git -C {bare仓} worktree add --detach {workspace}/source {commit}`（detached HEAD，不动任何分支/标签）。**并发天然安全**：每个 run 检出各自 commit，无「切换分支」动作，git 内部锁保护元数据；`worktree prune` 为机会操作（add 前顺手执行，失败忽略）。worktree 元数据注册在 bare 仓的 gitdir 里，与检出目录分离。
- **凭据纪律（账号 key 约定，用户 2026-11-13 定：key 按账号，「容易留给用户，麻烦留给代码」）**：普通桶 `sdk_repo_account` 填**账号名**（该仓用哪个账号，一个账号可对应多个仓，多账号自行扩展命名）；安全桶 `git_account_{账号名}_username` / `git_account_{账号名}_token`（一对）。**公开仓读取常不配账号**——代码必须宽容读（`sdk.config()` 查得到才注入，绝不用 `sdk.secret()` 强制读，缺 key 会抛错）；但公开仓**也可能配账号**（未来 review 类业务要对公开仓写 PR comments，用户 2026-11-13 明确）——代码不做「公开仓=无账号」限制。凭据只以 `http.extraHeader=Authorization: Basic …` 形式挂在 clone/fetch 命令行（不落盘、不进 URL），**绝不进 sdk.log**；错误信息经脱敏（替换 username/token/两者 base64 对）。
- **删除「沿用本机 remote 凭据」分支**：缓存仓 remote 只有 origin（= sdk_repo_url），不存在本机凭据一说（2026-11-13 实测本机仓 remote 名为 asterisk/easemob 而非 origin，佐证该假设不可靠）。
- **清理**：worktree 在 run workspace 内，随 run 目录生命周期走，业务不做额外清理；bare 缓存**跨 run 保留**（缓存的意义所在），业务不做 TTL——保活由预热定时任务负责（决策 D10，下一任务）。
- **独立运行**：local-runner 复用同一 workflow-runner 派生逻辑，信封同样注入 cacheDir（local 缓存与平台运行互不干扰），本地 config.json 无需新增字段。

### 6.7 材料化（移植 log-bot 的任务目录契约，落点为 run workspace）

```text
{workspace}/
├── input/
│   ├── jira-issue.json      ← 脱敏白名单快照（工具落盘）
│   ├── conversation.md      ← Jira 语境文本（本步落盘）
│   └── logs/                ← 归一化日志（工具落盘）
├── source/                  ← SDK 源码 worktree（§6.6）
└── task-context.md          ← 轻量事实文件（本步落盘）
```

`conversation.md` 内容顺序（log-bot 契约）：① issue key + summary；② description；③ himBugContent；④ himRequirementContent + testScope（存在时）；⑤ versions / fixVersions / status / priority / updated。

`task-context.md`：工单 key、问题时间窗（若叙述中有）、日志文件清单（路径+大小）、选中 ref 与 provenance、审计 ref（`config.mainline_ref`，默认 `msync`）。**纪律：不内联日志原文进 prompt**——模型自行读文件（见 §6.8）。

### 6.8 大模型分析

`sdk.agent({ skills: ['sdk-log-analysis'], input, mode: 'fresh' })`，`mode: 'fresh'` 必带（单轮无状态任务，同 T22 §5 步骤 6 的理由）。

**pi 适配纪律**（用户 2026-11-12 明确要求注意 codex → pi 的迁移差异）：

1. **模型兜底链**：log-bot 时代是 codex 单模型假设；本平台沿用审查业务的 `runAgentReviewWithFallback` 模式——`sdk.models()` 枚举生效配置全部 provider/model，按声明顺序逐个 fresh 会话尝试，首个产出合法报告的模型即采纳；空枚举/枚举失败/全部失败 → `sdk.fail`（分析步骤与审计步骤各自独立兜底）。
2. **skill 格式按 pi 规范**：SKILL.md 遵循 pi 的 skill 约定（§8），不照搬 codex 的 prompt 文件组织方式。
3. **文件读取假设（实证点）**：本设计假设 pi agent 能读 run workspace 内的相对路径文件（审查业务的既有模式 + pi 为 agentic CLI）。**T4 的 local-runner 真实 LLM 端到端是实证点**：若 pi 不能读文件，停下报告用户，**不允许**用「把日志内联进 prompt」绕过（配额与上下文都会爆）。
4. prompt 纪律不变：不把原始日志贴进 prompt；不预选「可疑行」或预设排查路径。

input 拼装（文本）：

````text
## 任务
分析 Jira 工单 {issue_key} 的 SDK 日志，给出根因结论。

## 工作区文件（相对路径，自行读取）
- task-context.md：任务事实（工单、日志清单、源码版本）
- input/conversation.md：工单语境
- input/logs/：原始日志
- source/：对应版本 SDK 源码（只读）

## 输出
按 skill 定义的报告契约输出一个 JSON 对象。
````

用户给出具体时间点时，skill 指导模型从该点向前回溯至能解释成因或最近的 `EMChatClientImpl::init()` 边界。

**模型配额**：本业务一次 run 最多 2 次 agent 调用（分析 + 审计），控制台业务配置的 `max_agent_calls` ≥ 2。

### 6.9 mainline 审计（移植 log-bot 的只读审计）

目的：回答「这个问题在主线（默认 `msync`）上是否已修复」。

1. 准备第二个 worktree：`{workspace}/mainline-audit/source` 检出 `config.mainline_ref`（默认 `msync`）；
2. 第二次 `sdk.agent({ skills: ['sdk-log-analysis'], mode: 'fresh' })`，prompt 含分析报告 + 工单语境 + 审计 worktree 路径（只读）；
3. 审计输出契约：`{ status: 'already-fixed' | 'not-fixed' | 'unknown', summary: string, fix_commit?: string }`；
4. **git 验证兜底**：`already-fixed` 且带 `fix_commit` 时，代码验证该 SHA 是审计 worktree HEAD 的祖先（`git merge-base --is-ancestor`）并用 `git show` 的规范元数据替换模型自述；验证不过 → 降级 `unknown`。绝不发布未经验证的 SHA；
5. 本阶段任何异常（worktree 失败 / agent 失败 / 输出非法）→ 记 warn + `status: 'unknown'` 继续——**审计降级不拖垮主分析**。

**决策点 D3**：审计进第一期。它是 log-bot webhook 流程的标配产出，且对技术支持「要不要修」的决策价值最高；成本是一次额外 agent 调用（配额已含）。

### 6.10 输出组装（notify-message.ts）

- mentions：assignee（identity.assigneeEmail/Name）查 `data/jira-wecom-mapping.json`，命中 → userid；未命中 → 拼音全拼兜底（guessed，消息带提示行）；仍无 → 提示行 + mentions 空（与审查业务同款逻辑，person-mapping.ts 原样拷贝）。
- content 形状（markdown，对齐 wecom-webhook resultDoc，≤4000 字节截断由出口负责）：

```text
**SDK 日志分析报告：{issue_key}**

> 工单：[{issue_key}]({url})
> 根因：{root_cause 一句话}
> 置信度：{confidence}
> 主线状态：{already-fixed → 已修复（commit 短SHA） / not-fixed → 未修复 / unknown → 未确定}
> 分析时间：2026/11/12 15:30:00   ← zh-CN / Asia/Shanghai

{guessed / 未找到账号提示行（如有）}
{summary（报告摘要，模型产出）}
```

- 通知渠道只有企业微信：本业务输出 `{content, mentions}` 形状 → 派生事件 → 本业务绑定的 wecom-webhook 出口投递；**不写 Jira comments**。
- return 对象同时带结构化字段（`issue_key / url / root_cause / confidence / mainline_status / summary`）供下游与统计消费；`metrics` 键：`{ mainline_status, confidence }`（平台剥离进 run_metrics，不进 payload）。

## 7. 工具 jira-log-fetch（tools/jira-log-fetch/）

**契约**（一入一出，与流程程序同构）：

- `input`：`{ issue_key: string, workspace_subdir?: string }`（issue_key 缺/非字符串 → `sdk.fail`；workspace_subdir 缺省 `'input'`）。
- `config`：`{ jira_url, username, password, redirect_username?, redirect_password?, max_file_mb?, max_total_mb? }`——前三键缺一 → `sdk.fail` 列出缺哪个；redirect_* 为网关 Basic 凭据（easemob jira 前置网关，漏传 401，同 T22 §5 步骤 2 教训）；限额缺省 20MB / 100MB。**工具拿不到 secrets，凭据由胶水显式放进 config**（平台机制）。
- 成功 `sdk.return({ status: 'success', data, identity })`；jira 层失败走 `sdk.return({ status: 'error', code, message })`（**不用 sdk.fail**——error 双态是业务可判别的正常输出；sdk.fail 只留信封/参数非法）。
- `identity`（脱敏前旁路）：`{ reporterEmail?, reporterName?, assigneeEmail?, assigneeName? }`，不进 data；**F3 过滤的数据源**，必须有 assignee 两个字段。
- `data`：`{ issue: <脱敏白名单快照>, logs: [{ file, size, source_attachment }], skipped: [{ filename, reason }] }`。快照字段须覆盖 §4.3 过滤与 §6.5 ref 选择所需：`summary / description / himBugContent / himRequirementContent / testScope / versions / fixVersions / status / statusCategory / issueType / priority / updated`。

**行为**（移植 log-bot `add-jira-analysis-input` 的规则）：

1. 表单登录 + cookie 罐 + 401 重登一次（jira-client 复用审查业务工具同款实现）；
2. getIssue 取上述白名单字段 + 附件元数据；**不取 comments / changelog**（控量防杂讯）；
3. 附件筛选白名单：`.log` `.txt` `.zip` `.gz` `.tar.gz` `.tgz` 与无扩展名（按原始文本日志处理）；MIME 只记录不作为判据；图片/视频/文档等跳过并记原因；
4. 逐附件下载：实际字节数校验单文件 ≤ max_file_mb、累计 ≤ max_total_mb（超限跳过并记原因）；
5. 解包与编码归一（zip/gz/tar.gz 展开，文本编码归一为 UTF-8；移植 log-bot log-ingestion 规则），落盘 `{workspace}/{workspace_subdir}/logs/`，重名文件去重改名；脱敏工单快照落盘 `{workspace}/{workspace_subdir}/jira-issue.json`（**白名单字段，不落原始响应、不落凭据**）；
6. 返回选中与跳过清单。**日志可以为空**——空不是工具的错误（由胶水走 §6 步骤 5 分支）。

## 8. skill（skills/sdk-log-analysis/SKILL.md）

内容来源：log-bot `sdk-knowledge/`（domains / guides / repos / overview / INDEX.md）+ 其分析引擎的 prompt 纪律。迁移为单文件 SKILL.md（**按 pi 的 skill 规范编写**，不照搬 codex 的文件组织）：

1. **角色与输入语境**：你是 SDK 日志分析助手，单轮任务；输入由调用方在 prompt 中给出工作区相对路径（task-context.md / input/conversation.md / input/logs/ / source/），自行读取文件；**禁止假设其他取数渠道**。
2. **分析方法**：日志 ↔ 源码比对的方法论（来自 sdk-knowledge 的 domains/guides：各场景已知问题模式、关键日志特征、对应源码模块索引 repos/）。
3. **报告输出契约**：输出一个合法 JSON（可 `JSON.parse`；字符串内引用一律中文引号「」，禁止未转义英文双引号——同 T22 §7 的教训）：

```json
{
  "issue_key": "HIM-24204",
  "root_cause": "一句话根因",
  "summary": "报告摘要（markdown，含关键日志行与源码引用、证据与推断分离、建议的下一步排查）",
  "confidence": "high | medium | low",
  "evidence": ["关键证据条目"],
  "affected_modules": ["源码模块"]
}
```

4. **审计模式补充**：当 prompt 为审计任务时，输出 §6.9 的审计契约 JSON 而非分析报告。

skill 版本从 1.0.0 开始。

## 9. 业务契约（package/contract.json）

```json
{
  "version": 1,
  "input": {
    "fields": [
      { "path": "payload.content", "type": "string", "required": false, "desc": "上游审查通知 markdown 正文（唯一必需信息源；null/缺省属正常输入，主程序过滤）" },
      { "path": "payload.mentions", "type": "string[]", "required": false, "desc": "上游 @ 列表，本业务不消费" }
    ]
  },
  "output": {
    "fields": [
      { "path": "content", "type": "string", "required": true, "desc": "企微 markdown 正文。产出非空时必填——无日志/被过滤路径合法产出 null，由 check-output 逃生门放行" },
      { "path": "mentions", "type": "string[]", "required": false, "desc": "@ 的企微 userid 列表" },
      { "path": "issue_key", "type": "string", "required": true, "desc": "工单 key（下游与统计锚点）" },
      { "path": "url", "type": "string", "required": true, "desc": "工单链接" },
      { "path": "root_cause", "type": "string", "required": true, "desc": "一句话根因" },
      { "path": "confidence", "type": "string", "required": true, "desc": "high/medium/low" },
      { "path": "mainline_status", "type": "string", "required": true, "desc": "already-fixed/not-fixed/unknown" },
      { "path": "summary", "type": "string", "required": true, "desc": "报告摘要（markdown）" }
    ]
  },
  "metrics": {
    "fields": [
      { "key": "mainline_status", "type": "string", "required": true, "desc": "主线修复状态（平台剥离进 run_metrics）" },
      { "key": "confidence", "type": "string", "required": true, "desc": "置信度分桶" },
      { "key": "skill_version", "type": "string", "required": false, "desc": "skill 版本（取 agent-package.json version，供质量追溯）" }
    ]
  }
}
```

**决策点 D4**：input 字段全 `required: false`。下游业务的正常输入包含 null 与缺字段 payload（§3.4），required 校验会把正常输入判成 run 失败。语义过滤在主程序步骤 1；契约文件承担文档与控制台展示价值。

`agent-package.json`：

```json
{
  "name": "sdk-log-analysis",
  "version": "0.1.0",
  "programs": {
    "main": "dist/apps/main/index.js",
    "check-input": "dist/apps/check-input/index.js",
    "check-output": "dist/apps/check-output/index.js"
  },
  "requires": { "tools": ["jira-log-fetch"], "skills": ["sdk-log-analysis"] }
}
```

## 10. 配置与 secrets 清单（控制台登记口径）

| 类别 | 键 | 值 | 用途 |
| ---- | -- | -- | ---- |
| config | `jira_url` | `https://j1.private.easemob.com` | jira-log-fetch config + 通知链接派生 |
| config | `sdk_repo_url` | `https://github.com/easemob/emclient-linux` | 源码仓远端 URL（bare 缓存克隆源，§6.6） |
| config | `sdk_repo_account` | 账号名（如 `ci-bot`）；公开仓读取可缺省 | 该仓用哪个 git 账号；缺省 = 匿名克隆/拉取（§6.6 凭据纪律） |
| config | `mainline_ref` | `msync`（缺省） | 主线审计 ref |
| config | `assignee_tag` | `sdk`（缺省） | F3 过滤：负责人映射记录 tags 须含此标签才分析（v2 CATEGORY_SUBSCRIPTION_TAG 平移，§4.3） |
| secrets | `jira_username` / `jira_password` | jira 账号 | 胶水取出放进工具 config |
| secrets | `jira_redirect_username` / `jira_redirect_password` | 网关 Basic 凭据 | 同上（前置网关必须） |
| secrets | `git_account_{账号名}_username` / `git_account_{账号名}_token` | git 平台账号 / access token | **可选**：配置了 `sdk_repo_account` 才需要，一对账号可对应多个仓（§6.6）；clone/fetch 以 http.extraHeader 注入，绝不落盘 |
| 入口 match 行 | source=`internal`，event_type=`{审查业务 id}.completed` | 无 entry_config | 编排订阅（§3.2） |
| 出口 | wecom-webhook | url：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={{wecom_key}}`（真值存安全桶） | 分析报告通知（唯一通知渠道） |
| 业务配置 | `max_agent_calls` | ≥ 2 | 分析 + 审计两次调用（§6.8） |

**决策点 D5**：人员映射表拷贝自持（`package/data/jira-wecom-mapping.json` 从审查业务仓原样拷贝，**tags 字段必须随表拷贝**——F3 过滤与 @ 处理人都依赖它）。两业务各持一份运营数据，与审查业务现状一致；平台没有共享数据资产机制，不为此引入新概念。代价是两份映射表需同步维护，当前规模可接受。

## 11. 工程文件

两资产（package、tools/jira-log-fetch）的工程配置从 v3 模板 `templates/agent-package/` 原样拷贝，不改规则；sdk 依赖 `"@asteriskzuo/agent-sdk": "^0.5.0"`（对齐审查业务当前版本）；package 另加 `"pinyin-pro": "^3"`。jest 测试脚本同模板。物化强制要求 package-lock.json——登记前在 `package/` 与 `tools/jira-log-fetch/` 各跑 `npm install` 生成并提交业务仓（同 T22 §9/§11 的既有流程）。

## 12. 测试与验收

**业务仓六连**（`package/` 与 `tools/jira-log-fetch/` 各自）全绿；sdk 依赖解析若用 registry 加速（如 npmmirror）不得保留指向它的 lock 文件，登记前用默认 registry 重新生成。

**单测最低线**（mock sdk 边界与 git/HTTP）：

- notify-parse：通过/不通过标题判别、key 正则提取、缺 key 的跳过语义、content 形状快照；**不断言分类行**（值域对下游无意义，§4.1）
- analysis-flow：payload null / 非通过标题 / 解析失败三类 return(null)；F1 终态、F2 非 Bug、F3 负责人无 sdk 标签（含查不到映射记录）三类自持过滤 return(null)；去重命中跳过；无日志分支写记录 return(null)；工具 error → fail；ref 歧义 → fail 带候选；**选中 ref 解析失败 → 回退 mainline_ref 成功继续（provenance 含回退说明）；主线也失败 → fail（§6.5 回退语义）**；agent 输出非法 → fail；审计异常降级 unknown 不 fail；正常路径输出形状含全部契约字段
- analysis-records：updated 相同跳过 / 不同重分析 / 缺失不去重；原子写
- ref-resolver：三级优先级、版本名归一化（`4.19.1`/`SDK 4.19.1`/`SDK_4.19.1`）、多候选 + core version 消歧、fixVersions 不参与
- worktree：URL→slug 归一化；冷仓锁内 bare clone（临时目录+rename、锁超时收割）；热仓 ref 解析阶梯（本地 → 锁内 `fetch --no-tags origin` → 裸版本号 `SDK_` 归一化重试一次 → 精确 ref FETCH_HEAD）；`worktree add --detach` 命令拼装；凭据注入（extraHeader 拼装与日志/错误脱敏）；失败语义（git 操作可用注入执行器 mock）
- report-parse：直接 JSON / markdown 围栏 / 字段级兜底（同 review-output 模式）
- mainline-audit：SHA 祖先校验通过与不过降级、`git show` 元数据替换、agent 失败降级
- notify-message：@ 命中 / 拼音兜底 / 未找到提示行、content 形状快照
- jira-log-fetch：mock HTTP（登录 → getIssue → 附件下载）+ 白名单筛选 + 单文件/累计限额 + 脱敏生效（快照无原始邮箱）+ identity 旁路（含 assignee 两字段）+ 非法 input/config fail + 空日志合法返回

**local-runner 独立调试**：用真实派生事件 JSON（payload = 审查业务真实输出 `{content, mentions}`，可从平台导出事件或按 §4.1 形状手构造）+ 本地 config/secrets 走 `docs/refs/2026-11-09-local-run-guide.md` 流程，真实 LLM 端到端产出报告。

**上线验证清单**（交付给用户，平台侧不代执行）：

1. 平台侧 release：`packages/sdk` 版本升至 0.6.0 并 `npm publish`（新增 `cacheDir()`；物化时业务仓 `npm ci` 从 registry 拉 sdk，必须先发版）→ 根仓 build/test 全绿；
2. 业务仓两资产 `npm install` 生成 lock → 业务仓 commit 推送；
3. 控制台登记三资产 → 创建业务（包绑定 + 入口程序 main + skill 绑定 + 工具绑定 + §10 配置；config 用 `sdk_repo_url`/`sdk_repo_account` 新口径，secrets 按 `git_account_{账号名}_*` 命名）；
4. 配置编排 match 行（§10）；**审查业务保持现状零改动**；
5. 手动验证：构造/挑选一个**带日志附件、负责人带 sdk 标签**的 Bug 测试工单走完审查 pass → 自动触发日志分析 → 企微群收到分析报告；控制台可见两个业务的 run 记录、统计二维表、run 日志；
6. 幂等验证：同工单同 updated 复审不重复触发分析；
7. 负向验证：无附件工单 pass → 日志分析 run 安静结束（return null，不通知、不失败）；fail 审查 / 负责人无 sdk 标签 / 非 Bug / 终态工单不触发分析。

## 13. 决策点汇总

| 编号 | 决策 | 结论 | 状态 |
| ---- | ---- | ---- | ---- |
| D1 | 编排机制 | 原生派生事件（§3.3），语义即「审查输出 → 日志分析输入 → 日志分析输出 → 企微」 | **已定**（2026-11-12 用户确认语义） |
| D2 | 无日志附件时的行为 | return(null) 安静跳过（§6 步骤 5） | **已定** |
| D3 | mainline 审计是否进第一期 | 进（§6.9） | 默认进，用户未异议 |
| D4 | input 契约全 optional | 是（§9） | 不需确认（理由内联） |
| D5 | 人员映射表拷贝自持（含 tags） | 是（§10） | 默认采纳，用户未异议 |
| D6 | 审查业务是否为零改动 | **零改动**；下游解析通知格式（§4），自持过滤（§4.3） | **已定**（2026-11-12 用户明确） |
| D7 | 结果通知渠道 | 只走企业微信，不写 Jira comments | **已定**（2026-11-12 用户明确） |
| D8 | 下游过滤规则的准确来源 | 平移 v2 生产规则（§4.3）：实质门槛 = 审查 pass + 负责人 tags 含 `sdk`（v2 `CATEGORY_SUBSCRIPTION_TAG`）；「SDK前端分类」表述纠正为人员标签判据；scenarios 路由键不平移（v3 单下游，路由无意义） | **已定**（2026-11-12 用户指认 v2 仓库核实） |
| D9 | 源码仓从「本机路径」改为「远端 URL + bare 缓存」 | 实测 bare clone >20 分钟（每事件拉仓不可接受）、worktree add ~1.5s（缓存+预热成立）；信封注入 `cacheDir`（`businesses/{bid}/cache/`）+ `sdk.cacheDir()`（sdk 升 0.6.0 发布）；锁协议三动作：首克隆（临时目录+rename）、fetch、prune；并发靠 detached worktree 天然解决；废除 ALLOWED_REMOTES 白名单与「沿用本机凭据」分支；叙述裸版本号按 `SDK_` 归一化重试一次 | **已定**（2026-11-13 用户逐点确认） |
| D10 | 仓保活方式 | 平台新增「定时任务规则」：业务包声明周期性动作（agent-package.json），平台按节奏或手动触发**无事件 run**，预热脚本与运行时**共用同一锁**；fetch 全部分支（不枚举分支清单）；本期 T4 只留运行时 fetch 兜底，平台规则 + 预热脚本为下一任务 | **已定**（2026-11-13 用户认可方案） |
| D11 | git 账号 key 口径 | key 按**账号**（用户定：容易留给用户，麻烦留给代码）：普通桶 `sdk_repo_account` + 安全桶 `git_account_{账号名}_username/token`，一对账号多仓共用；公开仓读取常不配（代码宽容读），但公开仓也可能配（未来 review 写 PR comments）——代码不做「公开仓=无账号」限制 | **已定**（2026-11-13 用户明确） |
| D12 | ref 解析失败回退主线 | 选中 ref 在解析阶梯最终失败 → 回退 `config.mainline_ref`（缺省 msync）重试一次，provenance 记回退说明、版本置信度 branch-head；选中的本来就是主线不自我重复；连主线也失败才 fail（§6.5/§6.6）。log-bot ref-resolver.js `fallbackRef` + repository-set.js preparer 语义的补移植 | **已定**（2026-11-13 用户核对 v2 生产代码确认） |

## 14. 依赖关系

- 依赖既有：平台全部模块、审查业务（其 jira-fetch 工具实现作为移植底本、其通知输出格式作为输入契约、其人员映射表作为拷贝源，**均只读引用**）、local-runner、模板包；
- 过滤规则依据 v2 生产代码 `src/observers/webhook-delivery-observer.ts` + `src/data/jira-wecom-mapping.json`（只读核查，2026-11-12）；
- log-bot 仓为只读迁移源，不做任何修改；
- 平台代码仅三处已批准小改（红线见文首，D9/D10）；审查业务仓零改动；实现中发现平台新缺口 → 停下报告。
