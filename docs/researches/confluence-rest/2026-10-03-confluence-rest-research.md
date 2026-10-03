# Confluence Server 5.8.10 REST API 调研（出口工具：创建/更新页面）

调研日期：2026-10-03（当日完成真实联机验证：认证链路 + AIR 空间建页/改页/查页全通，删页 403 未通；凭证为 jira 同款应用凭证 + 网关凭证）
调研目的：为出口工具（deliver 语义）实现「业务产出投递到 Confluence 页面」确认 Confluence Server 5.8.10（实例 `c1.private.easemob.com`，与 Jira 6.3.6 同属一套 Atlassian 体系、同一公网 SLB）的 REST API 可行性、认证链路、storage format 约束与版本冲突行为，为出口工具 spec 提供事实依据。

## 结论（先说结果）

**可行，且已完成真实端到端验证（2026-10-03）。** Confluence Server 5.8.10 官方 REST 存档文档完整覆盖「按标题查页 → 不存在则创建、存在则读取 version.number+1 后整体覆盖更新」的全部所需端点，且建页（POST /rest/api/content → 200）、改页（PUT 带 version+1 → 200）、查页（GET 按 title → size=1）均在 AIR 空间对 `c1.private.easemob.com` 真实验证通过。关键结论三条：

1. **认证：Basic 直连在本部署不可行，唯一可行链路是「网关 Basic + 表单登录 cookie」双段式（2026-10-03 实测确定）。** 前置 nginx/1.23.3 网关消费 `Authorization` 头做 Basic 挑战：c1 全路径匿名 401；应用凭证单独 Basic（无网关头）也 401（网关先拦）；网关凭证 Basic 能过网关但应用层未认证（/rest/api/space 返回空 results）。真实验证通过的链路是：**每个请求带网关 Basic（`TOOL__JIRA__REDIRECT_USERNAME/PASSWORD`）+ 应用层表单登录 cookie**——登录页是 `/login.action`（`/login.jsp` 在该实例 404），表单选择器 `name="loginform"`，POST 到 `/dologin.action`（os_username/os_password/os_cookie/os_destination），302 → index.action 获得 `seraph.confluence` 会话 cookie，带 cookie 调 REST 返回真实空间列表（II=Agora Chat、AG=Agora+Easemob、AIR=AI_ROBOT 等）。Confluence Server 原生支持 Basic Auth 直连这一点在官方文档层面成立，但在本部署被网关拦截，不能依赖。
2. **建页/更新页请求体**：`POST /rest/api/content` 最小体 `{type:"page", title, space:{key}, body:{storage:{value, representation:"storage"}}}`，可选 `ancestors:[{id}]` 指定父页；更新是 `PUT /rest/api/content/{id}`，**必须携带 `version:{number: 当前版本+1}`**（官方原文 "Must include the new version number"），版本过期返回 **409 Conflict**（5.8.10 API javadoc 的 ConflictException 明确映射 409）。按标题查页用 `GET /rest/api/content?type=page&spaceKey=...&title=...&expand=version,body.storage`。以上三条链路 2026-10-03 均已在 AIR 空间真实验证（建页返回 id 24278219）。
3. **storage format 是 XHTML 语法的 XML**（不是宽松 HTML）：`<p>`/`<h1>`–`<h6>`/`<ul><li>`/`<table>` 等标准标签 + `ac:`（宏/链接）与 `ri:`（资源引用）命名空间的自定义元素。纯文本/Markdown 转 storage 的最小策略：XML 转义 + 段落包 `<p>` + 换行转 `<br/>` 即可。**注意 5.8.10 的 `contentbody/convert` 不支持 wiki→storage 转换**（只支持 storage→view 和 editor→storage），Markdown 转换必须在工具内自行完成。

## 事实确认

### 1. 官方版本存档文档存在（5.8.10 精确匹配）

- Confluence 官方为每个版本生成 REST 文档存档，5.8.10 精确版本页面存在：`https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/`（内容标题 "Confluence REST API documentation"，示例响应时间戳 2015-08-28，与 5.8.10 发布年代吻合）。本调研所有「5.8.10 行为」均以该页面为准，而非新版文档。
  来源：[Confluence REST API documentation 5.8.10](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)

### 2. 创建页面：POST /rest/api/content

官方 5.8.10 文档给出的请求体示例（原文）：

```json
{"type":"page","title":"Example Content title","space":{"key":"TST"},"body":{"storage":{"value":"<p>This is a new page</p>","representation":"storage"}}}
```

- 响应 200（非 201），返回完整 content JSON，含 `id`、`version.number`（新页为 1）、`_links.self` 等。
- **2026-10-03 实测（AIR 空间）**：按上述最小体真实建页成功，返回 200、id=24278219——「建页返回 200 非 201」得到实测确认。
- `ancestors` 不是必填；要挂在父页下时传 `"ancestors":[{"id":456}]`（官方示例页有该用例）。出口工具 v1 可不支持父页，页面直接落在 space 根。
- 官方示例页（server 版）的创建示例：`curl -u admin:admin -X POST -H 'Content-Type: application/json' -d '{"type":"page","title":"new page","space":{"key":"TST"},"body":{"storage":{...}}}' http://localhost:8080/confluence/rest/api/content/`。
  来源：[5.8.10 REST 文档 /rest/api/content POST](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)、[Confluence REST API examples（Create a new page）](https://developer.atlassian.com/confdev/confluence-server-rest-api/confluence-rest-api-examples)

### 3. 按标题查页：GET /rest/api/content?title=...&spaceKey=...

5.8.10 文档的查询参数表（原文要点）：

- `type`：默认 `page`，可选 `page` / `blogpost`。
- `spaceKey`：限定空间。
- `title`：「the title of the page to find. **Required for page type**」——即按标题查页是官方一等支持的查询方式。
- `expand`：逗号分隔；默认 `history,space,version`。**查页时务必显式 `expand=version,body.storage`**：前者取 `version.number` 供更新 +1，后者取当前正文（如需追加而非覆盖）。
- `limit` 默认 25，`start` 分页；响应为 `{results:[...], size, ...}`，标题精确匹配时 `results` 至多一个元素（同 space 同标题页唯一；文档未明示唯一性保证，实现应按数组处理，取第一个并可校验）。
- **2026-10-03 实测（AIR 空间）**：对刚创建的页面按 `type=page&spaceKey=AIR&title=...&expand=version` 查询返回 `size=1`，标题精确查页可用，且 `expand=version` 正确返回 `version.number`。
  来源：[5.8.10 REST 文档 /rest/api/content GET](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)

### 4. 更新页面：PUT /rest/api/content/{id}（版本号必带，过期 409）

- 官方原文：「The body contains the representation of the content. **Must include the new version number.**」
- 请求体示例（官方）：`{"id":"3604482","type":"page","title":"...","space":{"key":"TST"},"body":{"storage":{"value":"<p>updated</p>","representation":"storage"}},"version":{"number":2,"minorEdit":false}}`——即 GET 当前 `version.number` 后 +1 再 PUT。
- 错误语义（官方）：400 = 参数无效/缺失；404 = 内容不存在或无权限查看。另有「Returned if the user does not have permission to **edit** the content」的 403 语义（同文档其它写操作段，PUT content 段未单列状态码，**403 的具体映射未在 5.8.10 文档逐条列出，标注：未找到官方逐状态码说明**）。
- **版本冲突 = HTTP 409**。5.8.10 API javadoc 的 `ConflictException` 原文：「Thrown when a request cannot be performed due to the state of the content, as per the semantics of the HTTP 409 'Conflict' status code. For example, when an UPDATE request is made with a **stale version number**」。且「Typically these operations can be retried successfully either by updating the information in the request to match the state of the content」——即 409 后重新 GET 再 +1 重试是官方认可的标准恢复动作。
- **2026-10-03 实测（AIR 空间）**：对新建页（version 1）携带 `version:{number:2}` 执行 PUT → 200，「更新必须 version+1」流程端到端真实验证通过。
  来源：[5.8.10 REST 文档 /rest/api/content/{id} PUT](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)、[ConflictException (Atlassian Confluence 5.8.10 API)](https://docs.atlassian.com/atlassian-confluence/5.8.10/com/atlassian/confluence/api/service/exceptions/ConflictException.html)、[Confluence REST API examples（Update a page）](https://developer.atlassian.com/confdev/confluence-server-rest-api/confluence-rest-api-examples)

### 5. 认证（2026-10-03 实测裁决）：Basic 直连不可行，唯一可行链路是「网关 Basic + 表单登录 cookie」

- **官方层面**：Server REST 示例页明确「示例使用用户名/密码的 basic authentication，PAT 是 Confluence 7.9 之后才有」——Basic 直连在裸 Server 上成立。Cloud 的 [Basic auth 废弃公告](https://developer.atlassian.com/cloud/confluence/deprecation-notice-basic-auth/)与 Server 无关。
  来源：[Confluence REST API examples（官方 Server 版）](https://developer.atlassian.com/confdev/confluence-server-rest-api/confluence-rest-api-examples)
- **本部署实测（2026-10-03，逐条验证）**：
  1. 匿名访问 c1 全路径（`/`、`/login.jsp`、`/rest/api/*`）→ **401**，响应头为 nginx/1.23.3 的网关 Basic 挑战；j1 同样全 401（2026-09-01 serverInfo 匿名 200 已不复存在）。
  2. 应用凭证单独 Basic（不带网关头）→ **401**：网关消费 `Authorization` 头，**Basic 直连在本部署不可行**。
  3. 网关凭证 Basic → **200 但 /rest/api/space 空 results**：仅过网关，应用层未认证。
  4. 唯一可行链路（真实验证通过）：**每个请求带网关 Basic（`Authorization: Basic base64(网关用户:网关密码)`）+ 应用层表单登录 cookie**。与 v2 jira 的关键差异：登录页是 **`/login.action`**（`/login.jsp` 在该实例 **404**），表单选择器是 **`<form name="loginform">`**（无 `id="login-form"`），POST 到表单 action **`/dologin.action`**（字段 os_username/os_password/os_cookie/os_destination），302 → index.action，获得 **`seraph.confluence` 会话 cookie**（同发 JSESSIONID）；带 cookie 调 `/rest/api/space` 返回真实空间列表（II=Agora Chat、AG=Agora+Easemob、AIR=AI_ROBOT 等）。2026-10-03 `confluence-verify.mjs` 只读复跑重现了该全链路（4 步状态 401/401/200-empty/200）。
- **对实现的裁决**：不做 Basic 直连路径，只做「网关 Basic 始终携带 + login.action/dologin.action 表单登录 + seraph.confluence cookie」一条链路；表单选择器兼容顺序 `name="loginform"` → `id="login-form"`（jira 风格）→ 首个 form，类可跨程序复用。401 会话自愈（清 cookie 重新登录重试一次）。
- **注意**：j1（Jira 6.3.6）与 c1（Confluence 5.8.10）虽同属一套 Atlassian 体系，但登录页路径与表单结构不同（jira 是 login.jsp + login-form，confluence 是 login.action + loginform），不能假设完全同构——这正是按实测写选择器兼容链的原因。

### 6. storage format：XHTML 语法的 XML，最小合法集

- 官方定义：「We refer to the Confluence storage format as 'XHTML-based.' Technically, it's **XML**」——必须良构（well-formed）：标签闭合、属性带引号、`&` `<` `>` 必须转义。`<p>This is <br/> a new page</p>` 是官方建页示例，即 `<p>` + `<br/>` 是最小合法单元。
- 常用最小标签集（官方 storage format 参考页）：`<h1>`–`<h6>`、`<p>`、`<br/>`、`<strong>/<em>/<code>/<pre>`、`<ul>/<ol>/<li>`、`<blockquote>`、`<table>/<tbody>/<tr>/<th>/<td>`、`<a href>`。
- 宏与资源引用走自定义命名空间：`<ac:structured-macro ac:name="...">`（宏，如 code/info/panel）、`<ac:link><ri:page ri:content-title="..."/>`（页间链接）、`<ac:image><ri:url .../></ac:image>`。body 的顶层可以混排标准 XHTML 与 `ac:`/`ri:` 元素。**5.8.10 接受 `ac:structured-macro` 没有问题**（官方建页/转换示例中大量使用），但宏名必须是实例上真实存在的宏，未知宏会被存为「未知宏」占位——v1 建议不用宏。
- 官方 storage format 参考页（版本无关，元素语义跨版本稳定）：
  来源：[Confluence Storage Format](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html)
- **Markdown → storage 最小转换策略**（实现建议，非官方规定）：
  1. 文本节点统一 XML 转义（`&`→`&amp;`、`&lt;`、`&gt;`、`"`→`&quot;`）；
  2. 空行分段 → `<p>...</p>`；段内换行 → `<br/>`；
  3. 需要标题/列表/表格时映射到上列官方标签；
  4. v1 只承诺「纯文本 + 简单标题/列表」，不引入 `ac:structured-macro`，避免宏名可用性问题。
- **5.8.10 的格式转换端点帮不上忙**：`/rest/api/contentbody/convert/{to}` 在 5.8.10 支持的转换只有 storage→view / export_view / editor 与 editor→storage（官方转换矩阵原文），**没有 wiki→storage、也没有 markdown→storage**。新版示例里的 wiki 转换是后来的版本才有的。转换必须工具内完成。
  来源：[5.8.10 REST 文档 /rest/api/contentbody/convert/{to}](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)

### 7. 与新版（7.x/8.x/Cloud）文档的差异提示

写实现时**只信 5.8.10 存档文档**，以下新版概念对 5.8.10 均不适用：

| 新版文档概念 | 5.8.10 是否支持 | 说明 |
| --- | --- | --- |
| Cloud `/wiki` 上下文路径、`/wiki/api/v2` v2 API | 否 | v2 API 是 Cloud 专属；Server 5.8.10 只有 `/rest/api/content` 这一套 |
| API token / OAuth 2.0 认证 | 否 | PAT 从 Confluence **7.9** 才有（官方示例页原文），5.8.10 只有 Basic 与表单会话 |
| `contentbody/convert` 的 wiki→storage | 否 | 5.8.10 转换矩阵无此项（见第 6 节） |
| `GET /rest/api/content/scan`（7.18+ 高性能遍历） | 否 | 官方示例页标注 7.18 起才有 |
| `id` 字段类型 | 数字字符串 | 5.8.10 示例 `"id":"1234"`；Cloud v2 是数值型 `id` + `pageId` |
| 响应状态码：建页 200 | 是（200，非 201） | 5.8.10 文档明确 POST 成功返回 200 |

来源：[Confluence REST API examples](https://developer.atlassian.com/confdev/confluence-server-rest-api/confluence-rest-api-examples)、[5.8.10 REST 文档](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)、[Cloud 版 content API（对照用，勿照抄）](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content/)

### 8. 错误体结构、权限、版本冲突

- **错误体结构**：Server 版 REST 错误为 JSON，形状为 `{"statusCode":403,"data":{"authorized":false,"valid":true,"errors":[],"successful":false},"message":"..."}`（`statusCode` 与 HTTP 状态一致，`message` 为人类可读信息，`data.errors` 为字段级错误列表）。**2026-10-03 实测确认**：删页 403 的真实错误体为 `{"statusCode":403,"data":{"authorized":false,"valid":true,"errors":[]},"message":"Unable to trash content..."}`，与社区归纳的形状一致。仍注意：**未找到官方文档对错误体结构的正式定义**（5.8.10 REST 存档只写状态码文字描述，不给出错误 JSON schema），实现解析时应宽容容错（非该形状时回退到 HTTP 状态码 + 原文）。
  来源（实测 + 社区佐证）：[Curl REST API - {"message":"Current user not permitted to use Confluence","statusCode":403}](https://community.atlassian.com/forums/discussion/1926027/curl-rest-api-message-current-user-not-permitted-to-use-confluence-statuscode-403)、[REST API too slow for finding new created page（statusCode:404 错误体）](https://community.atlassian.com/forums/Confluence-questions/REST-API-too-slow-for-finding-new-created-page/qaq-p/1070170)、[Bad Request - Create Confluence Content Page（statusCode:400 + errors[]）](https://community.developer.atlassian.com/t/bad-request-create-confluence-content-page/29464)
- **权限**：建页需要目标 space 的 Add page 权限；更新需要 edit 权限；无权限时按官方语义返回 403/404（对无 view 权限的内容，REST 统一表现 404 不暴露存在性——5.8.10 文档多处原文「there is no content with the given id, **or if the calling user does not have permission to view**」）。服务账号建议为该 space 配 Add/Edit page 权限。
  来源：[5.8.10 REST 文档](https://docs.atlassian.com/atlassian-confluence/REST/5.8.10/)
- **删页权限（2026-10-03 实测）**：`DELETE /rest/api/content/{id}` 对该服务账号返回 **403**（无 trash 权限，错误体 message 为 "Unable to trash content..."）。deliver 的 get-or-create 流程不含删除步骤，此权限缺失不影响出口工具；但意味着验证脚本/人工测试产生的页面**无法自删，会留残留**。
- **版本冲突**：PUT 携带过期 `version.number` → **409 Conflict**（`ConflictException` javadoc，见第 4 节）。官方明确 409 可通过「更新请求中的信息以匹配内容当前状态」重试成功，即标准恢复流：`GET 取最新 version → +1 → 重放 PUT`。出口工具建议 409 重试一次，仍失败则报错（视为并发写冲突）。
  来源：[ConflictException (5.8.10)](https://docs.atlassian.com/atlassian-confluence/5.8.10/com/atlassian/confluence/api/service/exceptions/ConflictException.html)

## 风险与缺口

1. ~~未真实联机验证~~ 已解决：2026-10-03 完成真实验证——认证链路（网关 Basic + login.action 表单登录）只读复跑通过，AIR 空间建页/改页/查页写链路通过，`confluence-verify.mjs` 可随时复验（默认只读，`--write` 跑写链路）。
2. **验证残留页（需人工清理）**：2026-10-03 `--write` 验证时因服务账号无 trash 权限（DELETE 403），AIR 空间留下一页「【验证残留，请管理员删除】出口工具验证页-2026-10-03」（**id=24278219**），内容已注明来由，**需 Confluence 管理员手动删除**。后续任何人跑 `--write` 都会产生新的带日期后缀的残留页，运行前须知悉。
3. **错误体结构无官方定义**（见第 8 节，实测形状与社区一致但仍需容错解析）。
4. **PUT 语义是整体覆盖**：5.8.10 没有「追加内容」端点，deliver 更新 = 先 GET `body.storage`（追加场景）或直接整体重写正文，需注意「读后合并」自身也可能引入 409 竞态（缓解：合并后提交遇 409 重新 GET 再合并再提交，最多一轮）。
5. **同 space 同标题页面的唯一性**：官方未明示 `title` 查询返回唯一；deliver 的「先查后建」在并发首次投递下可能建出两个同标题页（缓解：destination 串行化 + 建前再查一次，即 get-or-create 做成幂等流程）。
6. **页面标题唯一性限制**：Confluence 同 space 下同标题页面本就不该存在（新建重名页 UI 会自动追加序号），REST 创建重名页的行为（拒绝还是放行）未找到官方说明，依赖第 5 点的先查后建规避。
7. **服务账号权限边界已实测**：当前账号可建/改/查，**不可删**（403）。若未来 deliver 需要删页能力，需管理员另行授权；get-or-create 场景不需要。
8. **会话 cookie 有效期未实测**：seraph.confluence 会话的具体过期时间未验证（v2 jira 经验 remember-me 约 2 周）；实现须带 401 自愈重登，不能假设会话长期有效。

## 对出口工具实现的建议

### 工具类模式（owner 已裁决）：无业务知识的 ConfluenceClient 类

jira/confluence 等 Atlassian 客户端写成**工具类**：构造注入凭证、实例持有 cookie 会话、调用方控生命周期、类内零 `process.env` 零全局单例。**不做全局单例的原因之一是多个业务可能用不同用户凭证访问同一站点**；实例粒度 = 每绑定一实例。类可跨程序复用，出口侧只做薄适配（destination 解析、payload → storage 转换、结果记录）。

```ts
class ConfluenceClient {
  constructor(opts: {
    baseUrl: string;                 // 去尾斜杠，如 https://c1.private.easemob.com
    username: string;                // 应用凭证（Confluence 用户）
    password: string;
    gatewayUsername?: string;        // SLB 网关 Basic 凭证，可选
    gatewayPassword?: string;
    timeoutMs?: number;              // 默认 30000（实测网关偶发 >15s 响应）
  });

  /** 登录态自愈请求：cookie 失效(401)时清会话重新登录并重试一次 */
  private ensureSession(): Promise<void>;

  /** 按 spaceKey + title 查页；返回 { id, version } 或 null（未找到/无权限视为 null） */
  findPage(spaceKey: string, title: string): Promise<{ id: string; version: number } | null>;

  /** 建页，返回 { id, version: 1 } */
  createPage(input: { spaceKey: string; title: string; storageXhtml: string; parentId?: string }): Promise<{ id: string; version: number }>;

  /** 改页（整体覆盖）；409 时重新取 version +1 重试一次，仍败抛错 */
  updatePage(input: { id: string; spaceKey: string; title: string; storageXhtml: string; expectedVersion: number }): Promise<{ id: string; version: number }>;
}
```

- 会话实现要点（全部实测）：每个请求带网关 Basic 头；登录 GET `/login.action`（`/login.jsp` 兼容回退），表单选择器 `name="loginform"` → `id="login-form"` → 首个 form，POST 表单 action（`/dologin.action`），收 `seraph.confluence` cookie。
- 依赖管理四类归宿（见根 AGENTS.md）：baseUrl/凭证属构造注入；cookie 会话态属实例私有字段（上下文注入，**禁止全局单例**）；Markdown→storage 转换属纯函数。

### configSchema 建议

```json
{
  "type": "confluence",
  "nonSecret": {
    "baseUrl": "https://c1.private.easemob.com",
    "spaceKey": "AIR",
    "parentPageId": null
  },
  "secret": {
    "username": "<Confluence 用户（jira 同款应用账号）>",
    "password": "<Confluence 密码>",
    "gatewayUsername": "<SLB 网关用户，可空>",
    "gatewayPassword": "<SLB 网关密码，可空>"
  }
}
```

- 非机密：`baseUrl`（去尾斜杠）、`spaceKey`；`parentPageId` 可选（创建时放进 `ancestors`）。
- 机密：应用凭证 + 网关凭证**都进 secret**（网关凭证同样是秘密，v2 的 `redirectUsername/redirectPassword` 即按机密处理）。

### deliver(payload) 语义（get-or-create + 覆盖更新）

1. destination_id 约定：`confluence://{站点标识}/{spaceKey}/{pageTitle}`（**站点+space+title**，owner 裁决维持：创建型操作投递前页面 id 不存在，不能用 id 做投递键；同 destination 串行化天然落在同 title 上）。
2. 查：`GET /rest/api/content?type=page&spaceKey={k}&title={t}&expand=version,body.storage`。
3. 无 → 建：`POST /rest/api/content`，body 为 `{type:"page", title, space:{key}, body:{storage:{value, representation:"storage"}}}`（如需父页加 `ancestors:[{id}]`）。返回 id 记录。
4. 有 → 更新：`PUT /rest/api/content/{id}`，body 为 `{id, type:"page", title, space:{key}, body:{storage:{value, representation:"storage"}}, version:{number: 当前version+1, minorEdit:true}}`（`minorEdit:true` 避免刷站点活动流；可选）。
5. 遇 409：重新 GET 取 version，+1 重放一次；再败报错。
6. payload 正文转换：Markdown/纯文本 → storage XHTML（XML 转义、`<p>` 分段、`<br/>` 换行、标题/列表按需映射），v1 不用 `ac:structured-macro`。

### 错误映射建议

| HTTP | 出口工具错误语义 |
| --- | --- |
| 400 | 请求体非法（storage XHTML 不良构/字段缺失）→ 属实现 bug 或输入非法，记 error 不重试 |
| 401 | 认证失败（凭证错或会话失效，会话失效已由自愈重试吸收） |
| 403 | 服务账号无 Add/Edit page 权限；或无 trash 权限（DELETE，deliver 不涉及删除） |
| 404 | 页面/space 不存在（更新路径才可能；get-or-create 下罕见） |
| 409 | 版本冲突（重试一次后仍失败则报错） |
| 5xx | Confluence 服务端错误，可按队列策略退避重试 |
