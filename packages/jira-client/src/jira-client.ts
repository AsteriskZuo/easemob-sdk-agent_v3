/** easemob jira 客户端：表单登录认证链（cookie 罐 + 401 自愈重登）+ 通用 REST 便利方法。
 *  认证形态 = easemob jira 表单登录（login.jsp 提交 os_username/os_password，
 *  非标准 REST 基本认证 / API Token）；可选网关 Basic（配置后每个请求带 Authorization 头）。
 *  认证链骨架搬运自 v2 生产客户端（login.jsp 表单解析 → 跟随重定向 → Dashboard 匿名态验证），
 *  与 exit-tools 版做行为并集（网关 Basic 头、空值请求头过滤）。
 *  实例持有 cookie 与登录态，调用方控生命周期；类内零 process.env、零全局状态、零三方依赖
 *  （node 24 全局 fetch）。错误模型 = 双态结果 JiraResult<T>：不抛异常、不打日志（调用方各自记）。 */

/** 客户端配置 */
export interface JiraClientConfig {
  /** jira 站点根地址（尾部斜杠内部去掉） */
  baseUrl: string;
  /** 表单登录用户名（os_username） */
  username: string;
  /** 表单登录密码（os_password） */
  password: string;
  /** 网关 Basic 账号（可选；配置后每个请求带 Authorization 头） */
  redirectUsername?: string;
  /** 网关 Basic 密码 */
  redirectPassword?: string;
  /** 单请求超时毫秒；缺省 30000 */
  timeoutMs?: number;
}

/** 失败错误码 */
export type JiraErrorCode =
  | "invalid_input" // 入参非法（空请求路径、空 issueKey、fields 非对象等）
  | "authentication_failed" // 登录失败 / 401 重登后仍 401
  | "permission_denied" // 403
  | "ticket_not_found" // 404
  | "rate_limited" // 429
  | "jira_server_error" // 5xx
  | "network_error" // 连接失败 / 超时中止
  | "invalid_response"; // 非预期响应形状（非法 JSON、缺预期字段、未列举的状态码）

/** 双态结果：jira 错误是调用方可判别的正常输出 */
export type JiraResult<T> =
  | { status: "success"; data: T }
  | { status: "error"; code: JiraErrorCode; message: string };

/** searchIssues 查询条件（JQL 由 options 构造） */
export interface JiraSearchOptions {
  /** 项目 key（JQL `project = "X"`）；缺省不过滤 */
  project?: string;
  /** 负责人过滤（JQL `assignee in (...)`）；缺省/空数组 = 不过滤 */
  assignees?: string[];
  /** JQL `updated >= -Nd`；缺省 7 */
  daysBack?: number;
  /** 单次返回上限（jira maxResults 参数）；缺省 100 */
  maxResults?: number;
}

/** 工单轻量字段（标准字段的通用映射，不含任何私有/customfield 字段） */
export interface JiraIssueLite {
  /** 工单 key（如 PRJ-123） */
  key: string;
  /** 摘要；缺字段 = 空串 */
  summary: string;
  /** 状态名（如 "In Progress"）；缺字段 = 空串 */
  status: string;
  /** 优先级名；缺字段 = 空串 */
  priority: string;
  /** 工单类型名；缺字段 = 空串 */
  issue_type: string;
  /** 负责人用户名；未指派 = null */
  assignee: string | null;
  /** 报告人用户名；缺字段 = null */
  reporter: string | null;
  /** 最近更新时间（jira 原样字符串）；缺字段 = 空串 */
  updated: string;
}

interface Cookie {
  name: string;
  value: string;
}

type FetchTextResult =
  | { status: "success"; response: Response; body: string }
  | { status: "error"; code: JiraErrorCode; message: string };

/** search 拉取字段（与 JiraIssueLite 一一对应的轻量字段集） */
const SEARCH_FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "assignee",
  "reporter",
  "updated",
].join(",");

function failure(
  code: JiraErrorCode,
  message: string,
): { status: "error"; code: JiraErrorCode; message: string } {
  return { status: "error", code, message };
}

/** HTTP 状态码 → 错误码映射 */
function mapHttpError(status: number): {
  status: "error";
  code: JiraErrorCode;
  message: string;
} {
  if (status === 401) return failure("authentication_failed", "jira 认证失败");
  if (status === 403) return failure("permission_denied", "jira 权限不足");
  if (status === 404) return failure("ticket_not_found", "jira 工单不存在");
  if (status === 429) return failure("rate_limited", "jira 限流");
  if (status >= 500) return failure("jira_server_error", "jira 服务端错误");
  return failure("invalid_response", `jira 返回非预期 HTTP 状态: ${status}`);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** JQL 值加引号（转义反斜杠与双引号） */
function quoteJqlValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 构造 JQL：project / assignee in / updated >= -Nd，按 updated 倒序 */
function buildJql(options: JiraSearchOptions): string {
  const clauses: string[] = [];
  if (options.project !== undefined && options.project !== "") {
    clauses.push(`project = ${quoteJqlValue(options.project)}`);
  }
  if (options.assignees !== undefined && options.assignees.length > 0) {
    const quoted = options.assignees.map(quoteJqlValue).join(", ");
    clauses.push(
      options.assignees.length === 1
        ? `assignee = ${quoted}`
        : `assignee in (${quoted})`,
    );
  }
  const daysBack = options.daysBack ?? 7;
  if (daysBack > 0) {
    clauses.push(`updated >= -${daysBack}d`);
  }
  const base = clauses.length > 0 ? clauses.join(" AND ") : "1=1";
  return `${base} ORDER BY updated DESC`;
}

/** 从登录页 HTML 提取表单：优先 id="login-form" 的 form，退化为第一个 form；
 *  返回 action 绝对地址 + hidden 字段表（含 CSRF token 等，POST 时原样回带） */
function extractLoginForm(
  html: string,
  responseUrl: string,
): { actionUrl: string; hiddenFields: Record<string, string> } | undefined {
  let formMatch: RegExpMatchArray | undefined;
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const m of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(m[0])) {
      formMatch = m;
      break;
    }
  }
  formMatch ??= /<form\b[^>]*>[\s\S]*?<\/form>/i.exec(html) ?? undefined;
  if (formMatch === undefined) return undefined;

  const actionMatch = /\saction=["']([^"']*)["']/i.exec(formMatch[0]);
  const actionUrl = new URL(
    actionMatch?.[1] ?? "/login.jsp",
    responseUrl,
  ).toString();
  const hiddenFields: Record<string, string> = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = /\sname=["']([^"']+)["']/i.exec(input)?.[1];
    if (name === undefined) continue;
    hiddenFields[name] = /\svalue=["']([^"']*)["']/i.exec(input)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields };
}

/** 判定响应是否「匿名态」（登录失败的判据）：x-ausername 头优先，退化为页面特征 */
function isAnonymous(response: Response, body: string): boolean {
  const headerUser = response.headers.get("x-ausername")?.trim().toLowerCase();
  if (headerUser === "anonymous") return true;
  if (headerUser) return false;
  const remoteUser =
    /<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i.exec(
      body,
    );
  if (remoteUser !== null) {
    return remoteUser[1]?.trim() === "";
  }
  const lowered = body.toLowerCase();
  return lowered.includes('name="os_username"');
}

/** 收集 Set-Cookie 头（node fetch 的 Headers 带 getSetCookie） */
function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const value = headers.get("set-cookie");
  if (value === null) return [];
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function parseSetCookie(value: string): Cookie | undefined {
  const pair = value.split(";")[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  };
}

/** 过滤空值请求头（如无 cookie 时的空 Cookie 头，避免发出 `Cookie: ` 空串） */
function withoutEmptyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== ""),
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** 取 jira 用户对象的登录名（name 优先，退化为 key）；非用户对象/无名字 → null */
function readUserName(value: unknown): string | null {
  const record = toRecord(value);
  return readString(record.name) ?? readString(record.key) ?? null;
}

/** 取带 name 字段对象的展示名（status/priority/issuetype 通用） */
function readNamedValue(value: unknown): string {
  return readString(toRecord(value).name) ?? "";
}

/** request 原语的附加参数 */
export interface JiraRequestInit {
  /** HTTP 方法；缺省 = 有 body 时 POST、否则 GET */
  method?: string;
  /** 附加请求头（在 Accept: application/json 之上合并，同名覆盖） */
  headers?: Record<string, string>;
  /** 请求体（原样发送；Content-Type 由调用方经 headers 指定） */
  body?: string;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly redirectUsername?: string;
  private readonly redirectPassword?: string;
  private readonly timeoutMs: number;
  private cookies: Cookie[] = [];
  private authenticated = false;

  constructor(config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.redirectUsername = config.redirectUsername;
    this.redirectPassword = config.redirectPassword;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /** 认证请求原语（业务扩展点）：path 相对站点根（如 /rest/api/2/issue/KEY，
   *  带不带前导斜杠均可），返回解析后的 JSON（响应无 body 时 data 为 undefined）。
   *  业务拿它调任意 jira REST 路径；认证、cookie 重放、401 自愈全部内置。 */
  async request(
    path: string,
    init: JiraRequestInit = {},
  ): Promise<JiraResult<unknown>> {
    const trimmed = path.trim();
    if (trimmed === "") {
      return failure("invalid_input", "jira 请求路径不能为空");
    }
    const url = `${this.baseUrl}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...init.headers,
    };
    const response = await this.fetchAuthed(
      url,
      headers,
      init.body,
      init.method,
    );
    if (response.status === "error") return response;
    if (!response.response.ok) {
      return mapHttpError(response.response.status);
    }
    if (response.body.trim() === "") {
      return { status: "success", data: undefined };
    }
    try {
      return { status: "success", data: JSON.parse(response.body) as unknown };
    } catch {
      return failure("invalid_response", "jira 响应不是合法 JSON");
    }
  }

  /** 健康探测：认证 + GET /rest/api/2/serverInfo */
  async ping(): Promise<JiraResult<unknown>> {
    return this.request("/rest/api/2/serverInfo");
  }

  /** 拉工单原始 JSON（未映射）：GET /rest/api/2/issue/{key}；404 → ticket_not_found */
  async getIssueRaw(issueKey: string): Promise<JiraResult<unknown>> {
    if (issueKey.trim() === "") {
      return failure("invalid_input", "issueKey 不能为空");
    }
    return this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`);
  }

  /** JQL 搜索 + 通用轻映射（标准字段，无私有字段）；JQL 由 options 构造 */
  async searchIssues(
    options: JiraSearchOptions = {},
  ): Promise<JiraResult<JiraIssueLite[]>> {
    const jql = buildJql(options);
    const query = new URLSearchParams({
      jql,
      fields: SEARCH_FIELDS,
      maxResults: String(options.maxResults ?? 100),
    });
    const response = await this.fetchAuthed(
      `${this.baseUrl}/rest/api/2/search?${query.toString()}`,
      { Accept: "application/json" },
    );
    if (response.status === "error") return response;
    if (!response.response.ok) {
      return mapHttpError(response.response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return failure("invalid_response", "jira 搜索响应不是合法 JSON");
    }
    const data = toRecord(parsed);
    if (!Array.isArray(data.issues)) {
      return failure("invalid_response", "jira 搜索响应缺 issues 数组");
    }

    const issues: JiraIssueLite[] = [];
    for (const raw of data.issues) {
      const record = toRecord(raw);
      const key = readString(record.key);
      if (key === undefined) continue;
      const fields = toRecord(record.fields);
      issues.push({
        key,
        summary: readString(fields.summary) ?? "",
        status: readNamedValue(fields.status),
        priority: readNamedValue(fields.priority),
        issue_type: readNamedValue(fields.issuetype),
        assignee: readUserName(fields.assignee),
        reporter: readUserName(fields.reporter),
        updated: readString(fields.updated) ?? "",
      });
    }
    return { status: "success", data: issues };
  }

  /** 加评论：body 原样提交（包进 {"body": ...}） */
  async addComment(
    issueKey: string,
    body: string,
  ): Promise<JiraResult<unknown>> {
    if (issueKey.trim() === "") {
      return failure("invalid_input", "issueKey 不能为空");
    }
    return this.request(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  }

  /** 建工单：fields 原样包进 {"fields": ...}；成功 data = { key } */
  async createIssue(
    fields: Record<string, unknown>,
  ): Promise<JiraResult<{ key: string }>> {
    if (
      fields === null ||
      typeof fields !== "object" ||
      Array.isArray(fields)
    ) {
      return failure("invalid_input", "fields 必须是对象");
    }
    const result = await this.request("/rest/api/2/issue", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (result.status === "error") return result;
    const key = readString(toRecord(result.data).key);
    if (key === undefined) {
      return failure("invalid_response", "jira 创建工单响应缺少 key");
    }
    return { status: "success", data: { key } };
  }

  private cookieHeader(): string {
    return this.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private storeCookies(headers: Headers): void {
    for (const header of collectSetCookieHeaders(headers)) {
      const cookie = parseSetCookie(header);
      if (cookie === undefined) continue;
      this.cookies = this.cookies.filter(
        (existing) => existing.name !== cookie.name,
      );
      this.cookies.push(cookie);
    }
  }

  /** 网关 Basic 头（配置 redirect 凭据时每个请求都带） */
  private gatewayHeaders(): Record<string, string> {
    if (!this.redirectUsername || !this.redirectPassword) {
      return {};
    }
    return {
      Authorization: `Basic ${Buffer.from(
        `${this.redirectUsername}:${this.redirectPassword}`,
      ).toString("base64")}`,
    };
  }

  /** 底层 fetch（文本）：手动重定向（登录流程要自己看 302），超时中止，网络层失败 → network_error */
  private async fetchText(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
    method?: string,
  ): Promise<FetchTextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: withoutEmptyHeaders(headers),
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      this.storeCookies(response.headers);
      return { status: "success", response, body: await response.text() };
    } catch (err) {
      return failure(
        "network_error",
        `jira 连接失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 表单登录：GET /login.jsp 解析 hidden fields + CSRF → POST os_username/os_password/os_cookie=true
   *  → 跟随一次重定向 → GET /secure/Dashboard.jspa 验证非匿名。成功置 authenticated */
  private async ensureAuthenticated(): Promise<
    { status: "error"; code: JiraErrorCode; message: string } | undefined
  > {
    if (this.authenticated) return undefined;

    const loginPage = await this.fetchText(
      `${this.baseUrl}/login.jsp`,
      this.gatewayHeaders(),
    );
    if (loginPage.status === "error") return loginPage;
    if (!loginPage.response.ok) {
      return mapHttpError(loginPage.response.status);
    }

    const form = extractLoginForm(loginPage.body, `${this.baseUrl}/login.jsp`);
    if (form === undefined) {
      return failure("authentication_failed", "jira 登录页未找到登录表单");
    }

    const payload = new URLSearchParams(form.hiddenFields);
    payload.set("os_username", this.username);
    payload.set("os_password", this.password);
    payload.set("os_cookie", "true");
    if (!payload.get("os_destination")) {
      payload.set("os_destination", "/secure/Dashboard.jspa");
    }

    const loginPost = await this.fetchText(
      form.actionUrl,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      payload.toString(),
    );
    if (loginPost.status === "error") return loginPost;
    if (isRedirect(loginPost.response.status)) {
      const location = loginPost.response.headers.get("location");
      if (location === null) return mapHttpError(loginPost.response.status);
      const followed = await this.fetchText(
        new URL(location, form.actionUrl).toString(),
        {
          ...this.gatewayHeaders(),
          Cookie: this.cookieHeader(),
        },
      );
      if (followed.status === "error") return followed;
      if (!followed.response.ok) return mapHttpError(followed.response.status);
    } else if (!loginPost.response.ok) {
      return mapHttpError(loginPost.response.status);
    }

    const verify = await this.fetchText(
      `${this.baseUrl}/secure/Dashboard.jspa`,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
      },
    );
    if (verify.status === "error") return verify;
    if (!verify.response.ok) return mapHttpError(verify.response.status);
    if (isAnonymous(verify.response, verify.body)) {
      return failure(
        "authentication_failed",
        "jira 认证失败（登录后仍为匿名态）",
      );
    }

    this.authenticated = true;
    return undefined;
  }

  /** 带会话自愈的认证请求：401 视为会话过期，清登录态重登后原请求重试一次；再失败按原样返回 */
  private async fetchAuthed(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
    method?: string,
  ): Promise<FetchTextResult> {
    const once = async (): Promise<FetchTextResult> => {
      const authError = await this.ensureAuthenticated();
      if (authError !== undefined) return authError;
      return this.fetchText(
        url,
        {
          ...this.gatewayHeaders(),
          ...headers,
          Cookie: this.cookieHeader(),
        },
        body,
        method,
      );
    };
    const first = await once();
    if (first.status === "error" || first.response.status !== 401) return first;
    this.authenticated = false;
    this.cookies = [];
    return once();
  }
}
