# @asteriskzuo/agent-jira-client

easemob jira 客户端基础包：**表单登录认证链单点化**（登录 + cookie 罐 + 401 自愈重登）+ 通用 REST 便利方法。平台包与业务包共同依赖；业务侧可直接使用，也可经 `request` 原语扩展调用任意 jira REST 路径。

- 安装：`npm install @asteriskzuo/agent-jira-client`
- 运行时：Node.js ≥ 24，ESM；**零运行时依赖**（纯 node 全局 fetch）
- 导出：`import { JiraClient } from "@asteriskzuo/agent-jira-client"` + 类型 `JiraClientConfig` / `JiraResult` / `JiraErrorCode` / `JiraSearchOptions` / `JiraIssueLite` / `JiraRequestInit`

---

## 1. 认证形态（先读）

本包面向 easemob jira（Jira 6.x）的**表单登录**形态，**不是**标准 REST 基本认证 / API Token：

1. `GET /login.jsp` 解析登录表单（优先 `id="login-form"`，hidden 字段含 CSRF token 原样回带）；
2. `POST` 表单 `os_username` / `os_password` / `os_cookie=true`，成功后 Set-Cookie 建立会话；
3. 手动跟随一次重定向，再 `GET /secure/Dashboard.jspa` 验证非匿名态（登录失败的判据）；
4. 后续请求重放 cookie 罐；任一请求收到 **401 视为会话过期**——清登录态重登一次、原请求重试一次，重登后仍 401 → `authentication_failed`。

可选**网关 Basic**：配置 `redirectUsername` / `redirectPassword` 后，每个请求（含登录页）都带 `Authorization: Basic ...` 头（表单登录链路经过 redirect 网关的场景）。

其他纪律：单请求超时默认 30s（`timeoutMs` 可调，AbortController 中止）；实例持有 cookie 与登录态，**调用方控生命周期**；类内零 `process.env`、零全局状态；错误一律走双态结果，**不抛异常、不打日志**（调用方各自记）。

## 2. 快速开始

```ts
import { JiraClient } from "@asteriskzuo/agent-jira-client";

const client = new JiraClient({
  baseUrl: "https://j1.private.easemob.com",
  username: "bot",
  password: "secret",
  // redirectUsername / redirectPassword: 网关 Basic（可选）
  // timeoutMs: 30000（缺省）
});

const result = await client.searchIssues({ project: "HIM", daysBack: 7 });
if (result.status === "error") {
  console.error(result.code, result.message); // 调用方自行记日志
} else {
  for (const issue of result.data) console.log(issue.key, issue.summary);
}
```

## 3. API

### 3.1 `new JiraClient(config: JiraClientConfig)`

```ts
interface JiraClientConfig {
  baseUrl: string; // 站点根地址（尾部斜杠内部去掉）
  username: string; // 表单登录 os_username
  password: string; // 表单登录 os_password
  redirectUsername?: string; // 网关 Basic 账号（可选；配置后每个请求带 Authorization 头）
  redirectPassword?: string; // 网关 Basic 密码
  timeoutMs?: number; // 单请求超时毫秒，缺省 30000
}
```

构造不发起任何请求；首次调用任意方法时按需登录。

### 3.2 `request(path, init?): Promise<JiraResult<unknown>>`

**认证请求原语，业务扩展点**。`path` 相对站点根（如 `/rest/api/2/issue/HIM-1`，带不带前导斜杠均可），返回解析后的 JSON（响应无 body 时 `data` 为 `undefined`）。认证、cookie 重放、401 自愈全部内置，业务拿它调任意 jira REST 路径。

```ts
interface JiraRequestInit {
  method?: string; // 缺省 = 有 body 时 POST、否则 GET
  headers?: Record<string, string>; // 附加请求头（在 Accept: application/json 之上合并）
  body?: string; // 请求体原样发送；Content-Type 经 headers 自指定
}
```

扩展示例——业务自定义调用（如拉工单并展开 changelog）：

```ts
const res = await client.request(
  `/rest/api/2/issue/${encodeURIComponent(key)}?expand=changelog`,
);
if (res.status === "success") {
  const raw = res.data as Record<string, unknown>; // 未映射原始 JSON，业务自行 map/脱敏
}

// 写操作示例：转换工单状态
await client.request(`/rest/api/2/issue/${key}/transitions`, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transition: { id: "31" } }),
});
```

### 3.3 `ping(): Promise<JiraResult<unknown>>`

健康探测：认证 + `GET /rest/api/2/serverInfo`，返回解析 JSON。

### 3.4 `getIssueRaw(issueKey): Promise<JiraResult<unknown>>`

拉工单**原始 JSON（未映射）**：`GET /rest/api/2/issue/{key}`。404 → `ticket_not_found`；空 issueKey → `invalid_input`。字段映射、私有字段（customfield_*）解读、脱敏一律留给业务。

### 3.5 `searchIssues(options?): Promise<JiraResult<JiraIssueLite[]>>`

JQL 搜索 + 通用轻映射（只含标准字段，无私有字段）。JQL 由 options 构造，固定 `ORDER BY updated DESC`：

```ts
interface JiraSearchOptions {
  project?: string; // JQL project = "X"；缺省不过滤
  assignees?: string[]; // JQL assignee in (...)；缺省/空 = 不过滤
  daysBack?: number; // JQL updated >= -Nd；缺省 7
  maxResults?: number; // 缺省 100
}
```

```ts
interface JiraIssueLite {
  key: string;
  summary: string; // 缺字段 = 空串
  status: string; // 状态名；缺字段 = 空串
  priority: string; // 优先级名；缺字段 = 空串
  issue_type: string; // 工单类型名；缺字段 = 空串
  assignee: string | null; // 未指派 = null
  reporter: string | null;
  updated: string; // jira 原样字符串；缺字段 = 空串
}
```

### 3.6 `addComment(issueKey, body): Promise<JiraResult<unknown>>`

加评论：`POST /rest/api/2/issue/{key}/comment`，body 原样包进 `{"body": ...}` 提交。空 issueKey → `invalid_input`。

### 3.7 `createIssue(fields): Promise<JiraResult<{ key: string }>>`

建工单：`POST /rest/api/2/issue`，fields 原样包进 `{"fields": ...}` 提交；成功 `data = { key }`。fields 非对象 → `invalid_input`；响应缺 key → `invalid_response`。

## 4. 错误模型与错误码表

所有方法返回双态结果，**不抛异常**：

```ts
type JiraResult<T> =
  | { status: "success"; data: T }
  | { status: "error"; code: JiraErrorCode; message: string };
```

| code | 触发条件 |
| ---- | -------- |
| `invalid_input` | 入参非法：空请求路径、空 issueKey、fields 非对象 |
| `authentication_failed` | 登录失败（登录页无表单 / 登录后仍匿名态）/ 401 重登后仍 401 |
| `permission_denied` | HTTP 403 |
| `ticket_not_found` | HTTP 404 |
| `rate_limited` | HTTP 429 |
| `jira_server_error` | HTTP 5xx |
| `network_error` | 连接失败 / 超时中止 |
| `invalid_response` | 非法 JSON、缺预期字段（issues 数组 / createIssue 的 key）、未列举的 HTTP 状态码 |

需要异常语义的出口/边界层自行转换，例如：`throw new Error(\`${result.code}: ${result.message}\`)`。
