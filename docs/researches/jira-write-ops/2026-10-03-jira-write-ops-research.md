# Jira 写操作（出口工具）技术调研

调研日期：2026-10-03（源码级通读；认证链路只读验证经 `jira-readonly-verify.mjs` 实测通过，写操作未做真实端到端验证）
调研目的：为新项目（v3）实现「Jira 出口工具」——`deliver(payload)` 投递业务产出到 Jira 6.3.6 实例（j1.private.easemob.com）——沉淀移植参考。全部事实取材于 v2 生产代码 `easemob-sdk-agent_v2/src/jira/jira-client.ts`（1040 行，长期生产运行稳定，用户确认可直接使用）。

## 结论（先说结果）

**可行，v2 客户端整体可直接搬。** v2 `JiraClient` 已覆盖出口工具所需的全部写操作（addComment / createIssue / addAttachment）加只读辅助（getIssue / searchIssues / ping / downloadAttachment），认证链路（网关 Basic + login.jsp 表单登录 + cookie 会话 + 401 自愈重登）与错误映射完整且生产验证。移植到 v3 出口工具主要做三件事：

1. **包一层 `ExitTool` 外壳**：按 `packages/exit-tools/src/types.ts` 的约定实现 `kind/configSchema/destinationOf/bind/deliver`，内部复用 v2 客户端逻辑；
2. **定 payload 约定**：v2 方法是细粒度参数（issueKey/body/CreateIssueInput），v3 的 `deliver(result: unknown)` 是单个 payload，需要定义 payload 判别结构（评论 / 建单 / 附件）；
3. **`destination_id` 取值要改语义**：v2 以「已存在的工单 key」为目标，出口工具「创建新工单」场景下投递前无 key，`destinationOf` 不能以 key 为第二维（详见下文建议，该项为 spec 待裁决项）。

认证链路（网关 Basic + login.jsp 表单登录 + cookie 会话）已由同目录 `jira-readonly-verify.mjs` 只读冒烟脚本实测通过（2026-10-03，对 j1.private.easemob.com 完成 serverInfo 与 search 各一次只读请求）。

## 事实确认

### 1. 公开能力清单

所有方法经私有 `fetchAuthed`（带 401 自愈）发出，返回统一判别结构 `JiraClientResult = { status: "success", data, identity? } | { status: "error", code, message }`（类型定义：v2 行 4-105）。

| 方法 | 行号 | 端点 | 请求要点 | 成功返回 data |
| --- | --- | --- | --- | --- |
| `getIssue(issueKey, {includeComments, includeChangelog})` | 130-163 | `GET /rest/api/2/issue/{key}?expand=...` | expand 按需拼 `changelog`、`renderedFields,comment`（buildIssueUrl：行 630-648） | `mapIssue` 后的扁平化工单对象 + 旁路 `identity`（reporter/assignee 原始邮箱姓名，行 77-82、688-698） |
| `searchIssues({project, assignees, daysBack})` | 165-212 | `GET /rest/api/2/search?jql=...&fields=...` | JQL 由 buildJql 拼装（行 951-977）：`project = "X" AND assignee in ("a","b") AND updated >= -Nd ORDER BY updated DESC`，无_clause 时退化为 `1=1`；fields 固定白名单 SEARCH_FIELDS（行 979-991：summary/description/status/priority/issuetype/components/labels/assignee/reporter/updated/comment） | `{ issues: [...], identities: {key: IssueIdentity} }`，逐单 mapIssue + 脱敏 |
| `ping()` | 221-235 | `GET /rest/api/2/serverInfo` | 轻量只读，健康自检用 | `{}` |
| `addComment(issueKey, body)` | 237-252 | `POST /rest/api/2/issue/{key}/comment` | JSON body `{ body }` | `{}` |
| `createIssue(CreateIssueInput)` | 254-287 | `POST /rest/api/2/issue` | JSON body `{ fields: buildCreateIssueFields(input) }` | `{ id, key, self, url }`——`url` 是拼出来的给人看的页面地址 `${jiraUrl}/browse/${key}`（行 282-285） |
| `addAttachment(issueKey, filePath)` | 293-328 | `POST /rest/api/2/issue/{key}/attachments` | **multipart/form-data**，文件从本地磁盘 `readFile` 读入，文件名取 `basename`；必须带 `X-Atlassian-Token: no-check`；Content-Type 不由手动设置，交给 fetch 按 FormData 生成带 boundary 的头（行 289-292 注释） | `{}`；文件不可读返回 `invalid_input` |
| `downloadAttachment(contentUrl, destPath)` | 336-363 | contentUrl 取自 `getIssue` 的 `attachments[].content` | 支持相对地址（基于 jiraUrl 补全）；二进制下载，经 `fetchAuthedBinary`（行 535-570），manual redirect 下手动跟随 301（http→https 网关跳转），最多 3 次防循环（行 552-553 注释） | `{ path, size }`；写盘失败返回 `invalid_input` |

补充：构造函数（行 120-128）对 `jiraUrl` 去尾部斜杠，默认超时 `timeoutMs = 30000`。`sanitizeIssueData` 是 v2 特有的脱敏钩子（MCP/polling 防 prompt 泄漏），出口工具场景不需要。

### 2. 认证链路细节

三层结构：**网关 Basic（可选）→ login.jsp 表单登录 → cookie 会话重放 + 401 自愈**。

- **网关 Basic 在哪层加**（行 599-609）：`gatewayHeaders()` 只在配置了 `redirectUsername` + `redirectPassword` 时返回 `Authorization: Basic base64(user:pass)`，**每个请求都带**（fetchAuthedOnce 行 394-402、ensureAuthenticated 的 login.jsp 和表单 POST 也带）。未配置返回 `{}`（直连 Jira 场景）。这是链路最外层，与 Jira 账号体系无关。
- **login.jsp 表单解析**（ensureAuthenticated：行 405-480）：
  1. GET `${jiraUrl}/login.jsp`，从响应 HTML 提取登录表单：`findLoginForm` 优先找 `id="login-form"` 的 form（行 873-881），找不到退化为第一个完整 `<form>` 或裸 form 开标签（行 847-850）；
  2. 表单 `action` 属性解析为绝对地址（缺省 `/login.jsp`，基于响应 URL 补全，行 855-859）——**没有硬编码 xsrf/atl_token 字段名**，而是提取表单内**全部** `type="hidden"` 的 input 的 name/value（行 860-869），因此 xsrf token 之类隐藏字段天然被携带；
  3. 在隐藏字段之上覆盖业务字段（行 429-435）：`os_username`、`os_password`、`os_cookie=true`（remember-me，对应注释中「cookie 默认约 2 周失效」），无 `os_destination` 时补 `/secure/Dashboard.jspa`；
  4. POST 到表单 action，`Content-Type: application/x-www-form-urlencoded`，并带上当前已存 cookie（行 437-445）；
  5. 登录 POST 若返回 3xx（isRedirect：行 947-949），手动跟随 Location 一次（followRedirect：行 482-505）；非重定向且非 2xx 走 HTTP 错误映射；
  6. **登录验证**（行 461-476）：GET `/secure/Dashboard.jspa`，`isAnonymous`（行 883-904）三重判据——① `x-ausername` 响应头为 `anonymous` 则失败、非空则成功；② `<meta name="ajs-remote-user" content="">` 为空则失败；③ 页面含 `log in - easemob jira` 或 `name="os_username"`（又渲染出登录框）则失败。通过才置 `authenticated = true`。
- **cookie 存储与重放**（行 611-628）：每次 fetch 响应都过 `storeCookies`——收集 `set-cookie` 头（优先 `Headers.getSetCookie()`，Node 18 兼容回退到手动 split，行 906-925），只取 `name=value` 段（忽略 Path/Expires/Domain 等属性，行 927-937），**同名覆盖**存入内存数组；请求时拼成 `Cookie: a=1; b=2` 重放（`cookieHeader`，行 611-615）。纯内存、单实例、不过期检查。
- **会话过期重登策略**（fetchAuthed：行 365-382）：任何业务请求收到 **401 即视为会话过期**（remember-me cookie 约 2 周），清掉 `authenticated` 与全部 cookie，重新走完整登录流程后**原请求重试一次**；重试仍失败按原样返回。二进制版 `fetchAuthedBinary` 同逻辑（行 535-544）。
- 全部 fetch `redirect: "manual"`（行 522、583），重定向只在上述明确位置手动跟随，其余 3xx 会落入 `mapHttpError`（3xx 不在映射表 → `invalid_response`）。

### 3. 字段模型

**CreateIssueInput（行 48-70）与组装（buildCreateIssueFields：行 655-686）**：

| 输入字段 | 提交到 Jira 的字段 | 语义 / 约束 |
| --- | --- | --- |
| `project`（必填） | `project: { key }` | 项目 key |
| `summary`（必填） | `summary` | 标题 |
| `issueType?` | `issuetype: { name }`，**缺省 `"Bug"`** | 类型名 |
| `description?` | `description` | 纯文本 |
| `assignee?` | `assignee: { name }` | 登录名 |
| `himBugContent?` | `customfield_11901` | HIM 缺陷内容，HIM Bug 单的主内容字段（创建必填项，注释行 55-56） |
| `testScope?` | `customfield_11906` | 测试内容及范围 |
| `components?` | `components: [{ name }, ...]` | **必须是项目中已存在的组件名**（HIM 建单必填，注释行 59-60） |
| `duedate?` | `duedate`，`YYYY-MM-DD` | HIM 建单必填 |
| `estimate?` | `timetracking: { originalEstimate }`，如 `"3d"`/`"4h"` | HIM 建单必填 |
| `extraFields?` | 展开合并进 fields，**优先级最高可覆盖以上全部** | 通用逃生口：Jira 新增必填自定义字段时无需改代码（注释行 65-68） |

组装规则：先放恒等三字段（project/issuetype/summary），其余按「有值才放」，最后 `{ ...fields, ...input.extraFields }`。该函数单独导出，供 v2 skill 脚本 `--dry-run` 预览复用（注释行 652-654）——v3 可直接照搬这一份映射。

**读回解析（mapIssue：行 700-733）**：除标准字段外解析 4 个自定义字段——`customfield_11901` → `himBugContent`、`customfield_11900` → `himRequirementContent`（**只读，创建侧不写入**）、`customfield_11906` → `testScope`、`customfield_10306` → `epicLink`。`statusCategory`（New/In Progress/Complete）被特别注释为终态判断依据（行 716-718）。附件（行 735-752）解析出 `id/filename/mimeType/size/created/author/content`，`content` 即 downloadAttachment 的入参；评论（行 754-766）解析 `author/body/created/updated`。所有解析经 `readString`（空串归一为 undefined，行 817-819）与 `toRecord`（非对象归一为 {}，行 821-826）防御，异常形状不抛错。

### 4. 错误处理与边界

- **错误码全集**（行 4-12）：`invalid_input / authentication_failed / permission_denied / ticket_not_found / rate_limited / jira_server_error / network_error / invalid_response`。
- **HTTP 状态映射**（mapHttpError：行 997-1036）：400→`invalid_input`（会尝试解析 body 里的 `errorMessages[]` 或 `errors{}` 拼成具体 message，行 999-1017）；401→`authentication_failed`；403→`permission_denied`；404→`ticket_not_found`；429→`rate_limited`；≥500→`jira_server_error`；其余（含 3xx）→`invalid_response`。
- **重定向**：全局 `redirect: "manual"`。登录 POST 的 3xx 手动跟随一次（followRedirect）；附件下载最多跟随 3 次防循环；其他 3xx 不跟随、映射为 `invalid_response`。
- **超时**：每次 fetch 独立 `AbortController` + `setTimeout(timeoutMs)`（默认 30s），超时/网络异常统一吞为 `network_error`（"Failed to connect to Jira"，行 507-532、572-597）——注意 abort 与其他网络错误未区分。
- **JSON 解析**：`parseJsonObject`（行 828-841）对非对象/数组/非法 JSON 返回 `invalid_response`，不抛。
- **附件边界**：上传前 `readFile` 失败、下载后 `writeFile` 失败都归 `invalid_input`（行 297-305、350-357）；FormData/Blob 用 Node 内建全局，无第三方依赖。
- **单实例有状态**：cookie、`authenticated` 在实例字段上（行 117-118），同类多实例各自登录；并发首个请求会重复登录但 storeCookies 同名覆盖，无正确性问题。

## 风险与缺口

1. **未做真实写验证**：本次为源码级调研，createIssue/addComment/addAttachment 的端到端写操作未在 v3 环境实测（v2 生产稳定可作旁证）。
2. **登录取决于 HTML 结构**：表单解析是正则-based（`id="login-form"` 优先 + hidden input 全提取），Jira 6.3.6 升级或登录页改版会破认证；好消息是无硬编码 token 字段名，隐藏字段机制本身有一定前向兼容。
3. **「components 必须已存在」**：HIM 建单要求组件名预先存在于项目中，错误只在 Jira 返回 400 时暴露，出口工具侧无预检。
4. **payload 形态未定**：v3 `deliver(result: unknown)` 收到的是派生事件 payload，如何把「评论 / 建单 / 附件」表达进一个 payload 结构，需出口工具 spec 决策（v2 没有任何现成约定可搬）。
5. **附件来源**：v2 addAttachment 从本地路径读文件；出口工具的 payload 能否携带本地文件路径（依赖产出先落盘）还是需支持内联内容，未确认。

## 实现建议

> 本节前两节为 owner 已定结论（2026-10-03），直接约束 spec 与实现；后两节为调研方建议，待 spec 裁决。

### 架构分层：无业务知识的工具类 + 出口侧薄适配（owner 已定）

1. **工具类模式**：Jira 写为无业务知识的工具类 `JiraClient`——构造注入 url/应用凭证/网关凭证（对应 v2 的 `jiraUrl`/`username`/`password`/`redirectUsername`/`redirectPassword`），实例持有 cookie 会话与 authenticated 标志，**调用方（装配根）控生命周期**，类内零 process.env、零全局单例。
   - **不做全局单例的原因（owner 明确）**：jira/confluence 是用户登录，**不同业务可能用不同用户**。
   - 粒度 = **每绑定一实例**，会话复用仅在同一绑定内。
   - 工具类要能在别的程序和平台直接复用，因此**不含任何业务概念**：不知道 issue 类型、字段业务语义，只暴露通用 `addComment`/`createIssue` 等方法。
2. **出口侧薄适配**：exit-tools 包的 Jira 出口只做薄适配——`bind(config)` 时创建 `JiraClient` 实例，`deliver(payload)` 按 op 字段翻译为工具类调用，不含认证/会话/字段映射逻辑。

### 工具类可直接搬的部分（逻辑级复制，基本零改动）

- v2 `JiraClient` 全文 1040 行除 `sanitizeIssueData`/`IssueIdentity`（v2 防 prompt 泄漏专用，属业务概念，不进工具类）外全部可搬：认证链（ensureAuthenticated/followRedirect/gatewayHeaders/cookie 管理）、`fetchAuthed` 401 自愈、`mapHttpError`、`buildCreateIssueFields`、`mapIssue`。
  - 注意：`CreateIssueInput` 里的 `himBugContent`/`testScope` 等 HIM 业务语义命名属业务概念，搬到工具类时应退化为通用字段（如直接经 `extraFields` 透传自定义字段），业务侧在 payload → 工具类调用的翻译层再填 `customfield_11901` 等。
- 认证配置项直接沿用 v2 语义：`jiraUrl` / `username` / `password`（Jira 账号）+ `redirectUsername` / `redirectPassword`（网关 Basic，可空）+ `timeoutMs`（可空，默认 30s）。

### configSchema 建议（对齐 mail.ts 的 ConfigField 约定）

| key | label | required | secret | 说明 |
| --- | --- | --- | --- | --- |
| `jiraUrl` | Jira 地址 | 是 | 否 | `https://j1.private.easemob.com` |
| `username` | Jira 账号 | 是 | 否 | login.jsp 表单 `os_username` |
| `password` | Jira 密码 | 是 | **是** | 表单 `os_password` |
| `redirectUsername` | 网关 Basic 账号 | 否 | 否 | 缺省 = 不走网关 |
| `redirectPassword` | 网关 Basic 密码 | 否 | **是** | 同上 |
| `project` | 默认项目 key | 是* | 否 | 建单场景的目标项目，如 `HIM`；若 payload 自带 project 可作缺省值 |
| `timeoutMs` | 超时毫秒 | 否 | 否 | 缺省 30000 |

*`project` 是否 required 取决于 payload 约定：若 payload 必须自带 project 则可降为可选缺省。

### destination_id（channel_id 第二维）取值

> **spec 待裁决项**（维持调研原文结论，正式开发时定）。

`destinationOf` 要求「从非机密配置提取、文件路径安全」。**「创建新工单」场景投递前没有工单 key，不能以 key 为第二维**。建议按绑定粒度取 **`jiraUrl` 的 host（如 `j1.private.easemob.com`）+ `project`（如 `HIM`）拼成 `j1.private.easemob.com/HIM`**：同一绑定的所有投递（无论哪张单）归属同一 destination，路径安全（host 无斜杠、project 大写字母数字），且把「站点+项目」这个真正区分投递去向的维度表达出来。若未来出现「投递到指定已有工单」的 payload 类型，destination 粒度变粗（整站/整项目一个 channel）不影响正确性，只是通知聚合维度。

### payload 约定（待 spec 决策，推荐判别结构）

```ts
type JiraPayload =
  | { op: "comment"; issueKey: string; body: string }
  | { op: "create"; summary: string; description?: string; /* + CreateIssueInput 其余可选字段 */ }
  | { op: "attach"; issueKey: string; filePath: string; /* 或 { filename, contentBase64 } */ };
```

`deliver` 内按 `op` 分发到对应 client 方法，错误（`status: "error"`）统一抛错交给调度循环判失败（对齐 `Exit.deliver` 「失败抛错」约定）。建单成功后新 key 无处可回（deliver 返回 void），至少打 info 日志（`{ id, key, url }`），并在文档中说明 channel 历史里看不到「本次建的是哪张单」这一限制。
