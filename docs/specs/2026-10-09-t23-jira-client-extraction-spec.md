# T23 spec：jira 客户端抽取为可发布基础包（@asteriskzuo/agent-jira-client）

- **日期**：2026-10-09
- **状态**：已实现（用户授权：先抽包 → 用户手动发布 sdk + agent-jira-client → 再继续后续任务）
- **决策来源**：2026-10-09 讨论结论——基础工具包可发布 npm，平台包与业务包共同依赖，认证链（登录 + cookie + 401 自愈）单点化；业务侧「直接使用或者扩展」

## 1. 背景

jira 客户端现有三份，各自重复实现同一套认证机制（表单登录 + cookie 罐 + 401 清会话重登重试）：

| 位置 | 能力 | 错误模型 |
| ---- | ---- | -------- |
| `packages/exit-tools/src/jira.ts`（456 行） | 登录链 + ping/addComment/createIssue | 抛异常 |
| `packages/entry-adapters/src/jira-client.ts`（406 行） | 登录链 + searchIssues | 双态结果 |
| `business/jira-ticket-review/tools/jira-fetch/src/jira-client.ts`（666 行） | 登录链 + getIssue + 脱敏钩子 + identity 旁路 | 双态结果 |

认证链是稳定、非平凡、易错的传输机制（easemob jira 表单登录形态），不含业务判断——单点化收益明确。抽取边界切在「认证 + 传输 + 通用便利方法」，业务差异化内容（私有字段映射、脱敏、identity 旁路）不进包，共享包没有膨胀受力点。

## 2. 范围

**做**：

- 新包 `packages/jira-client`（`@asteriskzuo/agent-jira-client`，version 0.1.0，**发布 npm**）
- `exit-tools` 重构：删除内嵌 JiraClient，改依赖共享包
- `entry-adapters` 重构：删除内嵌 jira-client，改依赖共享包
- 文档回写：`core-modules.md` 模块全景加包、计划/进度文档
- 发布准备验证（npm pack dry-run）

**不做（范围外）**：

- github / wecom 抽取——出现第二个消费者再抽，模式照本任务（jira 是 pilot）
- `business/jira-ticket-review/tools/jira-fetch` 重构为依赖 npm 包——**用户发布完成后**的后续任务（需 registry 能解析包）
- masking 脱敏、easemob 私有字段映射（customfield_11901 等）、identity 旁路——永远留在业务侧
- ExitTool / EntryAdapter 接口——不动，无契约变化

## 3. 新包设计（packages/jira-client）

### 3.1 工程形态

- 镜像 sdk 的发布配置：`"files": ["dist"]`、`"publishConfig": { "access": "public" }`、`"prepublishOnly": "npm run build"`、version `0.1.0`；**不加 `private: true`**。
- **零 `dependencies`**（可发布的硬约束：不能依赖 monorepo 内部包——内部包不发布、workspace 版本号在 npm 无法解析；也不需要三方库）。纯 node 24 全局 fetch。devDependencies 同 sdk（jest/esbuild/typescript）。
- 六脚本同 T0 规范（build/test/typecheck，根级 lint/format/circular 覆盖），jest 配置、tsconfig 与现有包对齐。
- **不依赖 logger**：返回双态结果，不打日志（调用方各自记）。
- 包内附 `README.md`（公开文档，随 npm 发布）：认证形态说明（easemob jira 表单登录，非标准 REST 基本认证/API Token）、API 逐个说明、`request` 原语扩展示例（业务调任意 REST 路径）、错误码表。

### 3.2 API

```ts
export interface JiraClientConfig {
  baseUrl: string; // 站点根地址（尾部斜杠内部去掉）
  username: string; // 表单登录 os_username
  password: string; // 表单登录 os_password
  redirectUsername?: string; // 网关 Basic 账号（可选；配置后每个请求带 Authorization 头）
  redirectPassword?: string; // 网关 Basic 密码
  timeoutMs?: number; // 单请求超时，缺省 30000
}

export type JiraErrorCode =
  | "invalid_input" // 入参非法（空调用路径、空 issueKey 等）
  | "authentication_failed" // 登录失败 / 401 重登后仍 401
  | "permission_denied" // 403
  | "ticket_not_found" // 404
  | "rate_limited" // 429
  | "jira_server_error" // 5xx
  | "network_error" // 连接失败 / 超时中止
  | "invalid_response"; // 非预期响应形状

export type JiraResult<T> =
  | { status: "success"; data: T }
  | { status: "error"; code: JiraErrorCode; message: string };

export class JiraClient {
  constructor(config: JiraClientConfig);

  /** 认证请求原语（业务扩展点）：path 相对站点根（如 /rest/api/2/issue/KEY），
      返回解析后的 JSON（无 body 时 data 为 undefined）。业务拿它调任意 jira REST 路径。 */
  request(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<JiraResult<unknown>>;

  /** 健康探测：认证 + GET /rest/api/2/serverInfo */
  ping(): Promise<JiraResult<unknown>>;

  /** 拉工单原始 JSON（未映射）：GET /rest/api/2/issue/{key}；404 → ticket_not_found */
  getIssueRaw(issueKey: string): Promise<JiraResult<unknown>>;

  /** JQL 搜索 + 通用轻映射（标准字段，无私有字段）；JQL 由 options 构造 */
  searchIssues(options?: {
    project?: string; // JQL project = "X"；缺省不过滤
    assignees?: string[]; // JQL assignee in (...)；缺省/空 = 不过滤
    daysBack?: number; // JQL updated >= -Nd；缺省 7
    maxResults?: number; // 缺省 100
  }): Promise<JiraResult<JiraIssueLite[]>>;

  /** 加评论：body 原样提交 */
  addComment(issueKey: string, body: string): Promise<JiraResult<unknown>>;

  /** 建工单：fields 原样包进 {"fields": ...}；成功 data = { key } */
  createIssue(
    fields: Record<string, unknown>,
  ): Promise<JiraResult<{ key: string }>>;
}

export interface JiraIssueLite {
  key: string;
  summary: string;
  status: string;
  priority: string;
  issue_type: string;
  assignee: string | null;
  reporter: string | null;
  updated: string;
}
```

设计说明：

- **错误模型统一双态结果**（三份中两份的既有风格；jira 错误是调用方可判别的正常输出）。exit-tools 适配层把 error 转 throw（§4）。
- 实例持有 cookie 与登录态（与三份现状一致），调用方控生命周期；类内零 process.env、零全局状态。
- `getIssueRaw` / `request` 当前平台无消费者——消费者是业务包（jira-fetch 后续任务）与未来业务，属本任务的确认需求（用户：「业务包可以直接使用或者扩展」），非预测式扩展。

### 3.3 认证链合并规则

以 v2 搬运链（entry-adapters 版的 fetchAuthed / ensureAuthenticated / followRedirect / cookie 罐 / fetchText）为骨架，与 exit-tools 版做**行为并集**。必须覆盖的行为（测试逐条对应）：

1. 表单登录：`POST /auth/1/session`（或现状实现的 login.jsp 路径——以三份中实际可用者为准，合并时若两份登录路径不同，以 v2 搬运链为准并在 README 写明）→ 成功后 cookie 罐保存会话 cookie
2. 后续请求重放 cookie；网关 Basic 配置时每个请求带 `Authorization: Basic ...`
3. 任一请求 401 → 清登录态重登一次 → 原请求重试一次；重登后仍 401 → `authentication_failed`
4. 403 → `permission_denied`；404 → `ticket_not_found`；429 → `rate_limited`；5xx → `jira_server_error`；连接失败/超时中止 → `network_error`；JSON 解析失败/形状非预期 → `invalid_response`
5. 超时用 AbortController，默认 30s
6. redirect 跟随策略与现状保持一致（v2 链有 followRedirect，合并保留）

合并时发现三份有细微行为差异（错误消息措辞、cookie 处理细节），**以 v2 搬运链为准**（生产验证最久），差异点写进实现汇报。

## 4. exit-tools 重构

- `src/jira.ts` 删除内嵌 `JiraClient` 类及其私有方法（约 400 行），保留 ExitTool 包装（`KIND`、`configSchema`、`destinationOf`、`bind`、deliver 逻辑、resultDoc——接口与配置面一字不动）。
- deliver 内部：`new JiraClient(...)`（共享包）调 addComment/createIssue；`status: "error"` → `throw new Error(\`${code}: ${message}\`)`（出口 deliver 本就是 try/catch 失败语义）。
- package.json dependencies 加 `"@asteriskzuo/agent-jira-client": "0.1.0"`（monorepo 内部精确版本号惯例，yarn workspace 解析）。
- 测试：exit-tools 的 jira 单测改为 mock 共享客户端（或构造 fake JiraClient 注入）；原 HTTP 级认证链测试**迁移到共享包**（见 §6），不在 exit-tools 重复。

## 5. entry-adapters 重构

- 删除 `src/jira-client.ts`（406 行）；`jira-poller.ts` 改为从 `@asteriskzuo/agent-jira-client` 导入 `JiraClient` / `JiraIssueLite` / 错误码类型。
- 适配器原有的 `JiraSearchClientConfig` / `JiraSearchOptions` / `JiraSearchResult` 等类型如与共享包重复则删除，以共享包为准；jira-poller 对外行为（事件形状、event_id、错误日志）不变。
- package.json dependencies 加 `"@asteriskzuo/agent-jira-client": "0.1.0"`。
- 测试：jira-poller 单测改为 mock 共享客户端接口；原 `tests/jira-client` 的 HTTP 级测试（表单登录 → search 两段、401 重登、错误码映射）**迁移到共享包**。

## 6. 测试清单（最低线）

**packages/jira-client**（HTTP 级，本地 mock server 不触网）：

- 表单登录成功 → cookie 重放后续请求
- 网关 Basic 配置时请求带 Authorization 头
- 401 → 重登 → 原请求重试一次成功；重登后仍 401 → authentication_failed
- 403 / 404 / 429 / 5xx / 网络失败 / 非法 JSON → 对应错误码
- searchIssues：JQL 构造（project/assignees/daysBack 组合与缺省）+ lite 映射字段逐项
- getIssueRaw：404 → ticket_not_found；成功返回未映射原始 JSON
- addComment / createIssue：请求体形状；createIssue 响应缺 key → invalid_response
- request 原语：自定义 method/headers/body 透传
- 超时中止 → network_error

**exit-tools / entry-adapters**：既有测试全绿（重构后 mock 点变更的用例同步改写）；jira 相关 HTTP 级断言不再出现于两包（已迁走）。

## 7. 验收

- 根六连全绿（含新包）
- `cd packages/jira-client && npm pack --dry-run`：产物仅 dist + README + package.json，无 src/tests/临时文件
- exit-tools 的 jira 出口与 jira-polling 入口的对外行为与重构前一致（接口/配置面/事件形状不变）

## 8. 文档回写

- `docs/designs/2026-09-14-skill-platform-spec-v3/design/core-modules.md`：模块全景加 jira-client 包（定位：可发布基础客户端，平台包与业务包共同依赖）
- 计划文档加 T23 行；进度文档登记
- sdk README 不动（jira-client 不是 sdk 的一部分；jira-fetch 重构时在业务仓 README 体现依赖）

## 9. 依赖关系与后续任务

- T23 ← T21（无代码依赖，顺序依赖：避免与 T22 真机验证并行动 jira 代码——用户已决策先抽包）
- **后续任务（用户发布 sdk + agent-jira-client 后启动）**：business jira-fetch 重构为依赖 `@asteriskzuo/agent-jira-client@^0.1.0`（删 666 行内嵌客户端，保留 mapIssue/masking/identity 旁路）→ 业务仓六连 → T22 真机验证
- 版本纪律：monorepo 内 jira-client 版本号与 npm 发布号同步递增；平台包用精确版本号经 workspace 解析，业务包用 `^` 范围经 npm 解析
