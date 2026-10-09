# T22 spec：首个平台业务迁移——单轮审查工单（jira-ticket-review）

- **日期**：2026-10-09
- **状态**：已实现（用户授权一口气做完，手动验证在用户侧）
- **依赖**：T21 全部（物化构建、jira-polling 入口、出口 null 跳过、sdk README）
- **迁移源**：`/Users/asterisk/Codes/ai/easemob-sdk-agent_v2`（下称 v2）

## 1. 背景

v3 平台全部模块已就位（T0–T21），但「业务可落地」链路从未被真实业务验证过。本任务把 v2 的单轮审查工单业务按 v3 平台规范重构为**首个平台业务**，作为平台端到端链路的真实试金石：入口（jira-polling 轮询）→ 队列/通道 → 业务包（去重 → 拉取脱敏 → 大模型审查 → 组装通知）→ 出口（wecom-webhook）。

本任务是**重构不是搬运**：v2 中平台已包办的能力（事件循环、并发、通知投递、agent 运行时、会话管理、webhook 分发、企微交互 bot）一律删除，业务只保留其核心——审查流程编排与审查标准（skill）。

## 2. 范围

**做**：

- 三个资产（同一独立 git 仓、三个 subpath）：
  - `package/`：包资产——胶水代码 + 入口程序 main
  - `skills/`：skill 集合资产——`jira-ticket-review`（SKILL.md）
  - `tools/jira-fetch/`：工具资产——jira 登录 + 拉取 + 脱敏
- v3 仓库 `.gitignore` 加 `business/`（业务仓独立，物理同目录仅为管理方便）
- 业务包工程六连（build/test/typecheck/lint/format/circular）全绿

**不做**（明确范围外）：

- 企微交互 bot（多轮对话、`工单审查 HIM-22543` 命令）、MCP server、jira webhook 分类订阅分发、健康检查邮件、延迟审查队列（v2 的 delayed-request-queue）——v2 包袱，首个业务不需要
- jira-client 的 createIssue/addComment/attachment/downloadAttachment/searchIssues——本业务只用 getIssue，少即是稳
- webhook 入口（jira 实时推送）——暂无法测试，先用 jira-polling 跑通
- sdk npm publish——用户手动动作（验证前置）
- v3 平台代码任何改动——迁移中若发现平台缺口，**停下报告，不擅自改平台**

## 3. 资产形态与落位

```
business/jira-ticket-review/        ← 独立 git 仓（用户已建空目录），与 v3 仓库无关联
├── package/                        ← 包资产（subpath=package）
│   ├── agent-package.json          ← 清单
│   ├── agent.materialize.mjs       ← 初始化脚本（模板默认实现：esbuild 转译 src→dist）
│   ├── package.json / tsconfig.json / eslint.config.js / jest.config.mjs / .prettierignore / .gitignore
│   ├── data/
│   │   └── jira-wecom-mapping.json ← 人员映射表（随包，见 §8）
│   ├── src/
│   │   ├── programs/main.ts        ← 入口程序（薄：读信封 → reviewFlow → sdk.return/fail）
│   │   ├── review-flow.ts          ← 主编排（§5）
│   │   ├── review-records.ts       ← 去重记录存储（v2 语义，落点改 sdk.dataDir()）
│   │   ├── review-output.ts        ← 审查输出解析（搬 v2）
│   │   ├── review-scenarios.ts     ← 15 场景常量白名单（搬 v2）
│   │   ├── person-mapping.ts       ← 映射表查询 + 拼音兜底（搬 v2 account-mapping-loader）
│   │   └── notify-message.ts       ← 企微消息组装（v2 ReviewNotificationObserver 的拼装逻辑）
│   └── tests/                      ← 单测（搬 v2 对应测试 + 新增 review-flow 编排测试）
├── skills/
│   └── jira-ticket-review/
│       └── SKILL.md                ← 技能名 = 目录名（§7）
└── tools/
    └── jira-fetch/                 ← 工具资产（subpath=tools/jira-fetch）
        ├── agent-package.json      ← 工具清单（无 requires 字段）
        ├── agent.materialize.mjs   ← 同模板默认实现
        ├── package.json / tsconfig.json / eslint.config.js / jest.config.mjs / .prettierignore / .gitignore
        ├── src/
        │   ├── programs/jira-fetch.ts ← 入口程序（§6）
        │   ├── jira-client.ts         ← 搬 v2 裁剪版（只留 getIssue 路径）
        │   └── masking.ts             ← 搬 v2 createIssueMasker 原样
        └── tests/
```

资产登记（手动验证时在控制台操作）：三个资产同一 git url + 同一 commit，subpath 分别为 `package` / `skills` / `tools/jira-fetch`。

## 4. 端到端处理链路

```text
jira-polling 适配器（平台，已内置）
  │  每 interval 秒 JQL search（project=HIM, updated >= -7d）
  │  每工单一个事件：source='jira', session_id=issueKey,
  │  event_id=jira:{issueKey}:{updated}, event_type='jira.issue.updated'
  │  payload={ issue_key, summary, status, priority, issue_type, assignee, reporter, updated }
  ▼
入口队列 → 通道（{jira, issueKey, business_id} 串行）→ runner 拉起 main.ts
  ▼
main.ts 胶水（本任务核心，§5）：
  去重判断 → sdk.run('jira-fetch') → 终态短路 → 人员标签
  → sdk.agent({skills:['jira-ticket-review']}) → 解析输出 → 写审查记录
  → 组装企微消息 → sdk.return({content, mentions}) 或 sdk.return(null) 或 sdk.fail(...)
  ▼
结果扇出（平台）：派生 internal 事件（下游业务，暂无）+ 出口队列
  ▼
wecom-webhook 出口工具（平台，已内置）→ 企业微信群
```

**与 v2 的行为差异（认账，不回改平台）**：同一 `(issueKey, updated)` 只进入业务一次——event_id 幂等是队列层既有契约。jira-fetch 拉取失败或模型输出非法导致 `sdk.fail` 后，同 updated 不会再自动重试（v2 polling 每分钟会重推），靠工单下次 updated 变化恢复。失败在控制台 run 记录可见。

## 5. 包胶水编排（review-flow.ts）

输入：`sdk.input()` 得入口事件信封（EventEnvelope 形状），取 `payload.issue_key`、`payload.updated`。payload 缺 issue_key → `sdk.fail('payload 缺 issue_key')`。

流程（严格按序）：

1. **去重判断**：`checkSkip(issueKey, payload.updated)`（§5.1）→ 有跳过原因 → `sdk.log('info', ...)` + `sdk.return(null)`（不写新记录）。
2. **拉取工单**：`sdk.run('jira-fetch', { input: { issue_key }, config: { jira_url: sdk.config().jira_url, username: sdk.secret('jira_username'), password: sdk.secret('jira_password') } })`。返回 `status:'error'` → `sdk.fail(\`获取工单 ${issueKey} 失败：${code} ${message}\`)`（含 ticket_not_found——失败语义进控制台 run 记录，不静默）。
3. **终态短路**：`ticket.statusCategory === 'Complete'` → `markReviewed(issueKey, 'skip', payload.updated)` + `sdk.return(null)`（不调大模型，v2 语义）。
4. **人员标签**：`lookupPersonTags({ emailAddress: identity?.assigneeEmail, name: identity?.assigneeName })`（§8），注入 prompt。
5. **大模型审查**：`sdk.agent({ skills: ['jira-ticket-review'], input, mode: 'fresh' })`，input 拼装（§5.2）。**`mode: 'fresh'` 必带**：单轮审查是无状态一次性任务（v2 `resetSession: true` 语义）——同工单 updated 变化后复审时，缺省 `channel` 模式会沿用该通道的历史会话，token 膨胀且陈旧上下文干扰审查判断。
6. **解析输出**：`parseReviewOutput(agentOutput)` → undefined → `sdk.fail('审查输出解析失败')`（不写记录；agent 返回非字符串时先 `typeof === 'string' ? : JSON.stringify(...)`）。
7. **写审查记录**：`markReviewed(issueKey, review.decision, payload.updated)`。
8. **skip 不通知**：`review.decision === 'skip'` → `sdk.return(null)`（v2 语义：非 Bug 只记录不通知）。
9. **pass/fail 通知**：组装 `{ content, mentions }`（§5.3）→ `sdk.return(...)`。

### 5.1 去重语义（review-records.ts，搬 v2 ReviewRecordStore 原语义）

- 落点：`sdk.dataDir()/review-records.json`（业务级持久目录，通道串行保证同目录读写无竞争，v2 的进程内写锁链保留无害）。
- `checkSkip`：无记录 → 审查；`pass` → `'already_passed'` 跳过；`fail/skip` 且 `ticketUpdatedAt === 当前 updated` → `'already_reviewed_no_changes'` 跳过；`fail/skip` 且 updated 变了 → 重审。
- `markReviewed(issueKey, status, ticketUpdatedAt?)`：`pass` 不记 ticketUpdatedAt；`fail/skip` 记录。原子写（temp + rename）。

### 5.2 agent input 拼装

````text
## 工单数据

以下为 Jira 工单 {issueKey} 的完整数据（已脱敏）：

```json
{JSON.stringify(ticket, null, 2)}
```

## 人员标签

工单处理人（Assignee）的人员分类标签：{tags.join('、') 或 '无'}
````

v2 的 system.md（企微多轮交互语境）与 jira-ticket-review.md（用户命令交互语境）**不搬**；其中有平台价值的约束（输出必须合法 JSON、中文引号「」）并入 SKILL.md（§7）。

### 5.3 企微消息组装（notify-message.ts，搬 v2 拼装逻辑）

- @ 人规则：pass → @ 负责人（identity.assigneeEmail/Name 查映射表）；fail → @ 创建者（identity.reporterEmail/Name）。映射表查不到 → 拼音全拼兜底（guessed，消息里带提示行）；仍无 → 消息里带「未找到企微账号」提示行，mentions 为空。
- content 形状（markdown，对齐 wecom-webhook 的 resultDoc）：

```text
**工单审查通过 ✅**            ← 或 不通过 ❌

> 工单：[HIM-22543]({config.jira_url}/browse/HIM-22543)
> 分类：Bug                     ← 仅 pass 且有 classification
> 原因：...                     ← 仅 fail 且有 reason
> 审查时间：2026/10/9 15:30:00   ← zh-CN / Asia/Shanghai

{guessed 提示行（如有）}
{未找到账号提示行（如有）}
{review.summary}
```

- 返回 `{ content, mentions: [wecomUserid]? }`——mentions 仅映射表命中或拼音猜中时携带。
- v2 的「分类订阅覆盖则不 @」（subscriptionStore）**不搬**——那是 v2 webhook 分发体系的逻辑。
- 工单链接从 `sdk.config().jira_url` 派生（`/browse/{key}`），消除 v2 的硬编码 `j1.private.easemob.com`。

## 6. 工具 jira-fetch（tools/jira-fetch/）

**契约**（一入一出，与流程程序同构）：

- `input`：`{ issue_key: string }`（缺/非字符串 → `sdk.fail`）。
- `config`：`{ jira_url, username, password }`（三键缺一 → `sdk.fail` 列出缺哪个）。**工具拿不到 secrets，凭据由胶水显式放进 config**（平台机制，sdk README §2.8）。
- 成功 `sdk.return({ status: 'success', data: <脱敏工单>, identity })`；jira 层失败也走 `sdk.return({ status: 'error', code, message })`（**不用 sdk.fail**——error 双态是业务可判别的正常输出，胶水据此决定措辞；sdk.fail 只留给信封/参数非法）。
- `identity`（脱敏前旁路）：`{ reporterEmail?, reporterName?, assigneeEmail?, assigneeName? }`，不进 data。

**jira-client.ts 裁剪**：从 v2 `src/jira/jira-client.ts` 搬 `JiraClient` 类，只保留 `getIssue` 公共方法及其私有依赖（fetchAuthed / ensureAuthenticated 表单登录 + cookie 罐 + 401 重登一次 / followRedirect / fetchText / mapIssue / extractIdentity / buildIssueUrl / readXxx 工具函数），删除 searchIssues/ping/addComment/createIssue/addAttachment/downloadAttachment/buildCreateIssueFields 及其专属代码。保留 `sanitizeIssueData` 脱敏钩子。`JiraClientConfig` 的 `redirectUsername/redirectPassword`（v2 的 redirect 形态）保留——表单登录链路可能用到，搬时按实际依赖取舍，删了导致登录链断就保留。

**masking.ts**：`createIssueMasker()` 原样搬（353 行），不改脱敏规则。

## 7. skill（skills/jira-ticket-review/SKILL.md）

以 v2 `.agents/skills/jira-ticket-review/SKILL.md`（version 1.4.0）为底，做以下最小修订，version bump 为 **1.5.0**：

1. **输入语境改写**：「审查输入来自 `jira_get_issue` 的输出」→「审查输入由调用方在 `## 工单数据` 段提供（脱敏后的工单完整数据）；**禁止调用任何 Jira 工具拉取或编辑工单**，`## 工单数据` 就是全部审查证据」。删除「（customfield_11901…）」前的 `jira_get_issue` 提法，字段说明本身保留。
2. **输出契约补充**（吸收 v2 业务提示词的平台价值约束）：「输出的 JSON 必须合法（可被 `JSON.parse` 直接解析）：字符串值内需要引用时一律使用中文引号「」，禁止在字符串内嵌套未转义的英文双引号。」
3. 其余（审查流程、模板剥离、15 场景表、堆栈认定、判 fail 情形、输出契约字段）**一字不动**。

## 8. 人员映射表（package/data/jira-wecom-mapping.json）

- 从 v2 `src/data/jira-wecom-mapping.json` 原样拷贝，形状 `{ people: [{ jiraUsername, jiraEmail?, wecomUserid, wecomName, tags? }] }`。
- **落位包根 `data/`（非 src/）**：esbuild 不处理 JSON，放 src 里转译后丢失。运行时定位：`fileURLToPath(import.meta.url)` 上溯两级（`dist/programs/` → 资产根）+ `data/jira-wecom-mapping.json`；物化产物与本地 dev 的相对位置一致。
- person-mapping.ts 搬 v2 `account-mapping-loader.ts`：`lookupWeComAccount`（email → username → 企微姓名 → 拼音全拼兜底 guessed）、`lookupPersonTags`（无兜底），加载路径按上段改写，pinyin-pro 依赖保留。

## 9. 配置与 secrets 清单（控制台登记口径）

| 类别 | 键 | 值 | 用途 |
| ---- | -- | -- | ---- |
| config | `jira_url` | `https://j1.private.easemob.com` | jira-fetch config + 通知消息工单链接派生 |
| secrets | `jira_username` | jira 用户名 | 胶水取出放进 jira-fetch config |
| secrets | `jira_password` | jira 密码 | 同上 |
| 入口 match 行 | source=`jira`, event_type=`jira.issue.updated` | entry_config：`{ jira_url, username_key: "jira_username", password_key: "jira_password", project: "HIM", days_back: 7, interval_seconds: 60 }` | jira-polling 适配器（secrets 键名与上行一致） |
| 出口 | wecom-webhook | webhook_url（secret 项，按平台 `exit.{kind}.{key}` 规则配置） | 群通知 |
| server 配置 | `AGENT_ENTRY_JIRA_POLLING_ENABLED` | `true`（默认 false，验证时开启） | 入口开关 |

**sdk 依赖**：`package/package.json` 与 `tools/jira-fetch/package.json` 的 dependencies 均为 `"@asteriskzuo/agent-sdk": "^0.1.0"`（npm 正式版）；`package` 另加 `"pinyin-pro": "^3"`（对齐 v2 实际版本）。

**package-lock.json 的交付状态**：sdk 未发布 npm 前无法生成可用 lock（npm install 解析不到 `@asteriskzuo/agent-sdk`）。交付物**不含 package-lock.json**；手动验证第一步 publish sdk 后，在 `package/` 与 `tools/jira-fetch/` 各跑 `npm install` 生成 lock 并提交业务仓（物化强制要求 lock 存在）。本地六连验证用临时 `file:` 改写兜底（§11），验证后恢复。

## 10. 工程文件

两资产的工程配置（tsconfig/eslint/jest/prettier/gitignore/agent.materialize.mjs/scripts）从 v3 模板 `templates/agent-package/` 原样拷贝（模板即规范），不改规则。jest 测试脚本同模板（esbuild 转译 src+tests → dist-test 后跑 jest）。

## 11. 测试与验收

**业务仓六连**（`package/` 与 `tools/jira-fetch/` 各自）：`npm run build && npm test && npm run typecheck && npm run lint && npm run format:check && npm run circular` 全绿。sdk 依赖解析：临时把 dependencies 里的 `@asteriskzuo/agent-sdk` 改为 `file:<v3 绝对路径>/packages/sdk`（v3 侧已 build），`npm install --no-package-lock` 装临时 node_modules 跑六连，**完成后恢复 `^0.1.0` 并删除 node_modules 与临时 lock**——交付物不含 file: 痕迹。

**单测最低线**（搬 v2 对应测试 + 新增）：

- review-records：四类去重分支（无记录/pass 跳过/fail 未更新跳过/fail 已更新重审）+ markReviewed 的 ticketUpdatedAt 记录规则
- review-output：直接 JSON / markdown 围栏 / 非法 JSON 字段级兜底 / scenarios 白名单过滤
- review-scenarios：code 白名单与 SKILL.md 场景表一致性（v2 有一致性测试，搬）
- person-mapping：email/username/企微姓名三级查找 + 拼音兜底 guessed + tags 查询
- notify-message：pass @ 负责人 / fail @ 创建者 / guessed 提示行 / 未找到账号提示行 / content 形状快照
- review-flow（新增，mock sdk 边界）：去重命中 return(null) → 不 fetch；fetch error → fail；终态短路写 skip 记录 + return(null) 不调 agent；agent 输出非法 → fail 不写记录；pass/fail 写记录 + return 带 mentions
- jira-fetch：本地 mock HTTP（表单登录 → getIssue 两段 + 401 重登一次）+ 脱敏生效（data 无原始邮箱）+ identity 旁路存在 + input/config 非法 fail

**v3 根六连**：仅 `.gitignore` 加 `business/` 一行，跑根六连确认无污染。

**手动验证清单**（交付给用户，平台侧不代为执行）：

1. `cd packages/sdk && npm publish`（前置，物化 npm ci 要解析 sdk）
2. 业务仓 `package/` 与 `tools/jira-fetch/` 各 `npm install` 生成 package-lock.json → 业务仓 commit
3. 控制台登记三资产（同 git url+commit，subpath=package / skills / tools/jira-fetch）→ 创建业务：包绑定 + 入口程序 main + skill 绑定 jira-ticket-review + 工具绑定 jira-fetch + §9 的入口/出口/config/secrets
4. server 开 `AGENT_ENTRY_JIRA_POLLING_ENABLED=true` 重启
5. 观察：jira-polling 产出事件 → run 执行 → 企微群收到通知；控制台 run 日志可查；dataDir 下 review-records.json 生成；同工单同 updated 不重复通知
6. 模板包 §13 集成验收（file:// 登记 → 物化构建成功）可借本次业务仓登记一并覆盖

## 12. 依赖关系

T22 依赖 T21 全部（已落地）。本任务无平台代码改动；若实现中发现平台缺口（契约不符、缺机制），**停下报告用户，不擅自修改平台包**。
