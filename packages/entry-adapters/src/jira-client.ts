/** 轻量 jira 客户端：jira-polling 入口适配器内嵌，只含「表单登录 + searchIssues」最小集。
 *  搬运自 v2 src/jira/jira-client.ts 的登录/search 路径（零三方依赖，node 24 全局 fetch）。
 *  与业务工具 jira-fetch 的完整客户端是两份代码，v1 接受（适配器只 search，范围小）。
 *  认证形态 = easemob jira 表单登录（非标准 REST 基本认证/Token） */

/** 客户端配置 */
export interface JiraSearchClientConfig {
  /** jira 站点根地址（尾部斜杠会被去掉） */
  baseUrl: string;
  /** 登录用户名（os_username） */
  username: string;
  /** 登录密码（os_password） */
  password: string;
  /** 单请求超时毫秒；缺省 30000 */
  timeoutMs?: number;
}

/** searchIssues 查询条件 */
export interface JiraSearchOptions {
  /** 项目 key（JQL `project = "X"`）；缺省不过滤 */
  project?: string;
  /** 负责人过滤（JQL `assignee in (...)`）；缺省/空数组 = 不过滤 */
  assignees?: string[];
  /** JQL `updated >= -Nd`；缺省 7 */
  daysBack?: number;
}

/** 工单轻量字段（事件 payload 的原料；详情由业务自行拉取，平台不做预取） */
export interface JiraIssueLite {
  /** 工单 key（如 PRJ-123） */
  key: string;
  /** 摘要 */
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

/** 失败错误码（最小集） */
export type JiraSearchErrorCode =
  | "authentication_failed" // 登录失败 / 会话失效重登后仍 401
  | "permission_denied" // 403
  | "rate_limited" // 429
  | "jira_server_error" // 5xx
  | "network_error" // 连接失败/超时
  | "invalid_response"; // 非预期响应形状/状态码

export type JiraSearchResult =
  | { status: "success"; issues: JiraIssueLite[] }
  | { status: "error"; code: JiraSearchErrorCode; message: string };

interface Cookie {
  name: string;
  value: string;
}

type FetchTextResult =
  | { status: "success"; response: Response; body: string }
  | { status: "error"; code: JiraSearchErrorCode; message: string };

/** search 拉取字段（与 spec §7.3 一致：轻量字段集） */
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
  code: JiraSearchErrorCode,
  message: string,
): { status: "error"; code: JiraSearchErrorCode; message: string } {
  return { status: "error", code, message };
}

/** HTTP 状态码 → 错误码映射（最小集） */
function mapHttpError(status: number): {
  status: "error";
  code: JiraSearchErrorCode;
  message: string;
} {
  if (status === 401) return failure("authentication_failed", "jira 认证失败");
  if (status === 403) return failure("permission_denied", "jira 权限不足");
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
export function buildJql(options: JiraSearchOptions): string {
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

/** 创建轻量 jira 客户端：表单登录（cookie 罐）+ searchIssues + 401 清态重登一次 */
export function createJiraSearchClient(config: JiraSearchClientConfig): {
  searchIssues(options: JiraSearchOptions): Promise<JiraSearchResult>;
} {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30000;
  let cookies: Cookie[] = [];
  let authenticated = false;

  function cookieHeader(): string {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  function storeCookies(headers: Headers): void {
    for (const header of collectSetCookieHeaders(headers)) {
      const cookie = parseSetCookie(header);
      if (cookie === undefined) continue;
      cookies = cookies.filter((existing) => existing.name !== cookie.name);
      cookies.push(cookie);
    }
  }

  /** 底层 fetch（文本）：手动重定向（登录流程要自己看 302），超时中止，网络层失败 → network_error */
  async function fetchText(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<FetchTextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      storeCookies(response.headers);
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
  async function ensureAuthenticated(): Promise<
    { status: "error"; code: JiraSearchErrorCode; message: string } | undefined
  > {
    if (authenticated) return undefined;

    const loginPage = await fetchText(`${baseUrl}/login.jsp`);
    if (loginPage.status === "error") return loginPage;
    if (!loginPage.response.ok) {
      return mapHttpError(loginPage.response.status);
    }

    const form = extractLoginForm(loginPage.body, `${baseUrl}/login.jsp`);
    if (form === undefined) {
      return failure("authentication_failed", "jira 登录页未找到登录表单");
    }

    const payload = new URLSearchParams(form.hiddenFields);
    payload.set("os_username", config.username);
    payload.set("os_password", config.password);
    payload.set("os_cookie", "true");
    if (!payload.get("os_destination")) {
      payload.set("os_destination", "/secure/Dashboard.jspa");
    }

    const loginPost = await fetchText(
      form.actionUrl,
      {
        Cookie: cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      payload.toString(),
    );
    if (loginPost.status === "error") return loginPost;
    if (isRedirect(loginPost.response.status)) {
      const location = loginPost.response.headers.get("location");
      if (location === null) return mapHttpError(loginPost.response.status);
      const followed = await fetchText(
        new URL(location, form.actionUrl).toString(),
        {
          Cookie: cookieHeader(),
        },
      );
      if (followed.status === "error") return followed;
      if (!followed.response.ok) return mapHttpError(followed.response.status);
    } else if (!loginPost.response.ok) {
      return mapHttpError(loginPost.response.status);
    }

    const verify = await fetchText(`${baseUrl}/secure/Dashboard.jspa`, {
      Cookie: cookieHeader(),
    });
    if (verify.status === "error") return verify;
    if (!verify.response.ok) return mapHttpError(verify.response.status);
    if (isAnonymous(verify.response, verify.body)) {
      return failure(
        "authentication_failed",
        "jira 认证失败（登录后仍为匿名态）",
      );
    }

    authenticated = true;
    return undefined;
  }

  /** 带会话自愈的认证请求：401 视为会话过期，清登录态重登后重试一次；再失败按原样返回 */
  async function fetchAuthed(url: string): Promise<FetchTextResult> {
    const once = async (): Promise<FetchTextResult> => {
      const authError = await ensureAuthenticated();
      if (authError !== undefined) return authError;
      return fetchText(url, {
        Accept: "application/json",
        Cookie: cookieHeader(),
      });
    };
    const first = await once();
    if (first.status === "error" || first.response.status !== 401) return first;
    authenticated = false;
    cookies = [];
    return once();
  }

  return {
    /** JQL 搜索：返回工单轻量字段集（每工单一条，顺序 = jira 返回序） */
    async searchIssues(options: JiraSearchOptions): Promise<JiraSearchResult> {
      const jql = buildJql(options);
      const query = new URLSearchParams({ jql, fields: SEARCH_FIELDS });
      const response = await fetchAuthed(
        `${baseUrl}/rest/api/2/search?${query.toString()}`,
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
      return { status: "success", issues };
    },
  };
}

/** 轻量 jira 客户端类型（createJiraSearchClient 的返回） */
export type JiraSearchClient = ReturnType<typeof createJiraSearchClient>;
