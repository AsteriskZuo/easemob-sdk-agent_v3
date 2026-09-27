import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

export type JiraClientErrorCode =
  | "invalid_input"
  | "authentication_failed"
  | "permission_denied"
  | "ticket_not_found"
  | "rate_limited"
  | "jira_server_error"
  | "network_error"
  | "invalid_response";

export interface JiraClientConfig {
  jiraUrl: string;
  username: string;
  password: string;
  redirectUsername?: string;
  redirectPassword?: string;
  timeoutMs?: number;
  /**
   * 可选的数据脱敏钩子：在 mapIssue 之后、返回之前应用到每个工单数据。
   * 不传时行为不变。典型用法：MCP / polling 场景传入 createIssueMasker()。
   */
  sanitizeIssueData?: (
    data: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface JiraClientSuccess {
  status: "success";
  data: Record<string, unknown>;
  /**
   * 工单相关人的原始身份（未脱敏）旁路数据，仅 getIssue 返回。
   * 不进入 data，避免随 prefetch 注入 prompt 泄漏；用于延迟审查执行时刷新通知身份。
   */
  identity?: IssueIdentity;
}

export interface JiraClientError {
  status: "error";
  code: JiraClientErrorCode;
  message: string;
}

export type JiraClientResult = JiraClientSuccess | JiraClientError;

/** 创建工单的最小字段集：project/summary 必填，issueType 默认 Bug */
export interface CreateIssueInput {
  project: string;
  summary: string;
  issueType?: string;
  description?: string;
  assignee?: string;
  /** HIM缺陷内容（customfield_11901），HIM Bug 单的主内容字段 */
  himBugContent?: string;
  /** 测试内容及范围（customfield_11906） */
  testScope?: string;
  /** 组件名列表（HIM 建单必填），必须是项目中已存在的组件名 */
  components?: string[];
  /** 截止日期，YYYY-MM-DD（HIM 建单必填） */
  duedate?: string;
  /** 预估工时，如 "3d" / "4h"（HIM 建单必填，映射 timetracking.originalEstimate） */
  estimate?: string;
  /**
   * 通用透传字段，合并进 fields 且优先级最高。
   * 用于 Jira 新增必填自定义字段时无需改代码即可绕过。
   */
  extraFields?: Record<string, unknown>;
}

/**
 * 工单相关人的原始身份（未脱敏），用于通知等内部路由用途。
 * 由 searchIssues / getIssue 在脱敏前提取，作为旁路数据返回，不进入 issue 记录本身，
 * 避免随 prefetch 注入 prompt 泄漏。
 */
export type IssueIdentity = {
  reporterEmail?: string;
  reporterName?: string;
  assigneeEmail?: string;
  assigneeName?: string;
};

type JiraCookie = {
  name: string;
  value: string;
};

type JiraFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  url?: string;
  headers: Headers;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type FetchTextResult =
  | { status: "success"; response: JiraFetchResponse; body: string }
  | JiraClientError;

type FetchBinaryResult =
  | { status: "success"; response: JiraFetchResponse; body: Buffer }
  | JiraClientError;

export class JiraClient {
  private readonly jiraUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly redirectUsername?: string;
  private readonly redirectPassword?: string;
  private readonly timeoutMs: number;
  private readonly sanitizeIssueData?: (
    data: Record<string, unknown>,
  ) => Record<string, unknown>;
  private cookies: JiraCookie[] = [];
  private authenticated = false;

  constructor(config: JiraClientConfig) {
    this.jiraUrl = config.jiraUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.redirectUsername = config.redirectUsername;
    this.redirectPassword = config.redirectPassword;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.sanitizeIssueData = config.sanitizeIssueData;
  }

  async getIssue(
    issueKey: string,
    options: {
      includeComments?: boolean;
      includeChangelog?: boolean;
    } = {},
  ): Promise<JiraClientResult> {
    const response = await this.fetchAuthed(
      this.buildIssueUrl(issueKey, options),
      { Accept: "application/json" },
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    const parsed = parseJsonObject(
      response.body,
      "Jira returned an invalid issue response",
    );
    if (parsed.status === "error") {
      return parsed;
    }

    const mapped = mapIssue(parsed.data, issueKey);
    return {
      status: "success",
      identity: extractIdentity(mapped),
      data: this.applySanitizer(mapped),
    };
  }

  async searchIssues(
    options: {
      project?: string;
      assignees?: string[];
      daysBack?: number;
    } = {},
  ): Promise<JiraClientResult> {
    const jql = buildJql(options);
    const query = new URLSearchParams({ jql, fields: SEARCH_FIELDS });
    const response = await this.fetchAuthed(
      `${this.jiraUrl}/rest/api/2/search?${query.toString()}`,
      { Accept: "application/json" },
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    const parsed = parseJsonObject(
      response.body,
      "Jira returned an invalid search response",
    );
    if (parsed.status === "error") {
      return parsed;
    }

    const issues = [];
    const identities: Record<string, IssueIdentity> = {};
    const rawIssues = Array.isArray(parsed.data.issues)
      ? parsed.data.issues
      : [];
    for (const issue of rawIssues) {
      const record = toRecord(issue);
      const key = readString(record.key);
      if (!key) {
        continue;
      }
      const mapped = mapIssue(issue, key);
      // 脱敏前提取原始身份，作为旁路数据随结果返回（见 IssueIdentity 注释）
      identities[key] = extractIdentity(mapped);
      issues.push(this.applySanitizer(mapped));
    }

    return { status: "success", data: { issues, identities } };
  }

  private applySanitizer(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.sanitizeIssueData ? this.sanitizeIssueData(data) : data;
  }

  /** 轻量健康探测：认证 + 一次只读 serverInfo 请求，供定时健康自检使用 */
  async ping(): Promise<JiraClientResult> {
    const response = await this.fetchAuthed(
      `${this.jiraUrl}/rest/api/2/serverInfo`,
      { Accept: "application/json" },
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    return { status: "success", data: {} };
  }

  async addComment(issueKey: string, body: string): Promise<JiraClientResult> {
    const response = await this.fetchAuthed(
      `${this.jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      { "Content-Type": "application/json" },
      JSON.stringify({ body }),
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    return { status: "success", data: {} };
  }

  async createIssue(input: CreateIssueInput): Promise<JiraClientResult> {
    const response = await this.fetchAuthed(
      `${this.jiraUrl}/rest/api/2/issue`,
      { "Content-Type": "application/json" },
      JSON.stringify({ fields: buildCreateIssueFields(input) }),
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    const parsed = parseJsonObject(
      response.body,
      "Jira returned an invalid create issue response",
    );
    if (parsed.status === "error") {
      return parsed;
    }

    const key = readString(parsed.data.key);
    return {
      status: "success",
      data: {
        id: readString(parsed.data.id),
        key,
        // self 是 REST API 地址；url 是给人看的工单页面地址
        self: readString(parsed.data.self),
        url: key ? `${this.jiraUrl}/browse/${key}` : undefined,
      },
    };
  }

  /**
   * 上传附件：multipart/form-data POST，需 X-Atlassian-Token: no-check。
   * Content-Type 不手动设置，由 fetch 依据 FormData 生成带 boundary 的头。
   */
  async addAttachment(
    issueKey: string,
    filePath: string,
  ): Promise<JiraClientResult> {
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return error(
        "invalid_input",
        `Attachment file could not be read: ${filePath}`,
      );
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(content)]),
      basename(filePath),
    );

    const response = await this.fetchAuthed(
      `${this.jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
      { "X-Atlassian-Token": "no-check" },
      form,
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    return { status: "success", data: {} };
  }

  /**
   * 下载附件到本地文件。contentUrl 取自 getIssue 返回的 attachments[].content，
   * 支持绝对地址或以 / 开头的相对地址（基于 jiraUrl 补全）。
   * Jira 返回的 content 可能是 http（服务端 base URL 未配 https），网关会
   * 301 到 https，由 fetchBinaryOnce 跟随重定向。
   */
  async downloadAttachment(
    contentUrl: string,
    destPath: string,
  ): Promise<JiraClientResult> {
    const url = new URL(contentUrl, this.jiraUrl).toString();
    const response = await this.fetchAuthedBinary(url);
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status);
    }

    try {
      await writeFile(destPath, response.body);
    } catch {
      return error(
        "invalid_input",
        `Attachment file could not be written: ${destPath}`,
      );
    }

    return {
      status: "success",
      data: { path: destPath, size: response.body.length },
    };
  }

  /**
   * 带会话自愈的认证请求：401 视为会话过期（Jira remember-me cookie
   * 默认约 2 周失效），清除登录态重新登录后重试一次；重试仍失败按原样返回。
   */
  private async fetchAuthed(
    url: string,
    headers: Record<string, string> = {},
    body?: string | FormData,
  ): Promise<FetchTextResult> {
    const first = await this.fetchAuthedOnce(url, headers, body);
    if (first.status === "error" || first.response.status !== 401) {
      return first;
    }

    this.authenticated = false;
    this.cookies = [];
    return this.fetchAuthedOnce(url, headers, body);
  }

  private async fetchAuthedOnce(
    url: string,
    headers: Record<string, string>,
    body?: string | FormData,
  ): Promise<FetchTextResult> {
    const authResult = await this.ensureAuthenticated();
    if (authResult) {
      return authResult;
    }

    return this.fetchText(
      url,
      {
        ...this.gatewayHeaders(),
        ...headers,
        Cookie: this.cookieHeader(),
      },
      body,
    );
  }

  private async ensureAuthenticated(): Promise<JiraClientError | undefined> {
    if (this.authenticated) {
      return undefined;
    }

    const loginPage = await this.fetchText(
      `${this.jiraUrl}/login.jsp`,
      this.gatewayHeaders(),
    );
    if (loginPage.status === "error") {
      return loginPage;
    }
    if (!loginPage.response.ok) {
      return mapHttpError(loginPage.response.status, loginPage.body);
    }

    const form = extractLoginForm(
      loginPage.body,
      loginPage.response.url ?? `${this.jiraUrl}/login.jsp`,
    );
    if (!form) {
      return error("authentication_failed", "Jira login form was not found");
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
    if (loginPost.status === "error") {
      return loginPost;
    }
    if (isRedirect(loginPost.response.status)) {
      const followed = await this.followRedirect(
        loginPost.response,
        form.actionUrl,
      );
      if (followed) {
        return followed;
      }
    } else if (!loginPost.response.ok) {
      return mapHttpError(loginPost.response.status, loginPost.body);
    }

    const verify = await this.fetchText(
      `${this.jiraUrl}/secure/Dashboard.jspa`,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
      },
    );
    if (verify.status === "error") {
      return verify;
    }
    if (!verify.response.ok) {
      return mapHttpError(verify.response.status, verify.body);
    }
    if (isAnonymous(verify.response, verify.body)) {
      return error("authentication_failed", "Jira authentication failed");
    }

    this.authenticated = true;
    return undefined;
  }

  private async followRedirect(
    response: JiraFetchResponse,
    baseUrl: string,
  ): Promise<JiraClientError | undefined> {
    const location = response.headers.get("location");
    if (!location) {
      return mapHttpError(response.status, "");
    }

    const redirected = await this.fetchText(
      new URL(location, baseUrl).toString(),
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
      },
    );
    if (redirected.status === "error") {
      return redirected;
    }
    if (!redirected.response.ok) {
      return mapHttpError(redirected.response.status, redirected.body);
    }
    return undefined;
  }

  private async fetchText(
    url: string,
    headers: Record<string, string> = {},
    body?: string | FormData,
    method?: string,
  ): Promise<FetchTextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const httpMethod = method ?? (body === undefined ? "GET" : "POST");
      const response = (await fetch(url, {
        method: httpMethod,
        headers: withoutEmptyHeaders(headers),
        body,
        redirect: "manual",
        signal: controller.signal,
      })) as unknown as JiraFetchResponse;
      this.storeCookies(response.headers);
      return { status: "success", response, body: await response.text() };
    } catch {
      return error("network_error", "Failed to connect to Jira");
    } finally {
      clearTimeout(timeout);
    }
  }

  /** fetchAuthed 的二进制版本，用于附件下载，同样带 401 会话自愈重试 */
  private async fetchAuthedBinary(url: string): Promise<FetchBinaryResult> {
    const first = await this.fetchBinaryOnce(url);
    if (first.status === "error" || first.response.status !== 401) {
      return first;
    }

    this.authenticated = false;
    this.cookies = [];
    return this.fetchBinaryOnce(url);
  }

  private async fetchBinaryOnce(url: string): Promise<FetchBinaryResult> {
    const authResult = await this.ensureAuthenticated();
    if (authResult) {
      return authResult;
    }

    // fetch 是 manual redirect：附件地址可能先 301（Jira 返回的 content 是
    // http，网关跳 https），手动跟随，最多 3 次防循环。
    let current = url;
    for (let redirects = 0; ; redirects += 1) {
      const result = await this.fetchBinary(current);
      if (
        result.status === "error" ||
        !isRedirect(result.response.status) ||
        redirects >= 3
      ) {
        return result;
      }
      const location = result.response.headers.get("location");
      if (!location) {
        return result;
      }
      current = new URL(location, current).toString();
    }
  }

  private async fetchBinary(url: string): Promise<FetchBinaryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = (await fetch(url, {
        method: "GET",
        headers: withoutEmptyHeaders({
          ...this.gatewayHeaders(),
          Cookie: this.cookieHeader(),
        }),
        redirect: "manual",
        signal: controller.signal,
      })) as unknown as JiraFetchResponse;
      this.storeCookies(response.headers);
      return {
        status: "success",
        response,
        body: Buffer.from(await response.arrayBuffer()),
      };
    } catch {
      return error("network_error", "Failed to connect to Jira");
    } finally {
      clearTimeout(timeout);
    }
  }

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

  private cookieHeader(): string {
    return this.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private storeCookies(headers: Headers): void {
    for (const cookieHeader of collectSetCookieHeaders(headers)) {
      const cookie = parseSetCookie(cookieHeader);
      if (!cookie) {
        continue;
      }
      this.cookies = this.cookies.filter(
        (existing) => existing.name !== cookie.name,
      );
      this.cookies.push(cookie);
    }
  }

  private buildIssueUrl(
    issueKey: string,
    options: { includeComments?: boolean; includeChangelog?: boolean },
  ): string {
    const url = new URL(
      `${this.jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
    );
    const expand = [];
    if (options.includeChangelog) {
      expand.push("changelog");
    }
    if (options.includeComments) {
      expand.push("renderedFields", "comment");
    }
    if (expand.length > 0) {
      url.searchParams.set("expand", expand.join(","));
    }
    return url.toString();
  }
}

/**
 * 由 CreateIssueInput 构造提交给 Jira 的 fields 对象。
 * 单独导出以便 skill 脚本的 --dry-run 预览与 createIssue 共用同一份映射。
 */
export function buildCreateIssueFields(
  input: CreateIssueInput,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: { key: input.project },
    issuetype: { name: input.issueType ?? "Bug" },
    summary: input.summary,
  };
  if (input.description) {
    fields.description = input.description;
  }
  if (input.assignee) {
    fields.assignee = { name: input.assignee };
  }
  if (input.himBugContent) {
    fields.customfield_11901 = input.himBugContent;
  }
  if (input.testScope) {
    fields.customfield_11906 = input.testScope;
  }
  if (input.components && input.components.length > 0) {
    fields.components = input.components.map((name) => ({ name }));
  }
  if (input.duedate) {
    fields.duedate = input.duedate;
  }
  if (input.estimate) {
    fields.timetracking = { originalEstimate: input.estimate };
  }
  // 透传字段最后合并，可覆盖上面的所有已知字段
  return { ...fields, ...input.extraFields };
}

/** 从 mapIssue 结果中提取 reporter/assignee 的原始身份（须在脱敏前调用） */
function extractIdentity(mapped: Record<string, unknown>): IssueIdentity {
  const reporter = toRecord(mapped.reporter);
  const assignee = toRecord(mapped.assignee);
  return {
    reporterEmail: readString(reporter.emailAddress),
    reporterName: readString(reporter.name),
    assigneeEmail: readString(assignee.emailAddress),
    assigneeName: readString(assignee.name),
  };
}

function mapIssue(
  data: Record<string, unknown>,
  fallbackKey: string,
): Record<string, unknown> {
  const fields = toRecord(data.fields);
  return {
    key: readString(data.key) ?? fallbackKey,
    summary: readString(fields.summary) ?? "",
    description: readString(fields.description),
    himBugContent: readString(fields.customfield_11901),
    himRequirementContent: readString(fields.customfield_11900),
    testScope: readString(fields.customfield_11906),
    assignee: readUser(fields.assignee),
    creator: readUser(fields.creator),
    reporter: readUser(fields.reporter),
    status: readNamedValue(fields.status),
    // statusCategory（New / In Progress / Complete）是终态判断依据：
    // 终态工单（Complete、部署完成）在 agent-runner 直接短路 skip，不调大模型
    statusCategory: readNamedValue(toRecord(fields.status).statusCategory),
    resolution: readNamedValue(fields.resolution),
    issueType: readNamedValue(fields.issuetype),
    priority: readNamedValue(fields.priority),
    project: readNamedValue(fields.project),
    components: readNamedArray(fields.components),
    labels: readStringArray(fields.labels),
    versions: readNamedArray(fields.versions),
    fixVersions: readNamedArray(fields.fixVersions),
    epicLink: readString(fields.customfield_10306),
    attachments: readAttachments(fields.attachment),
    comments: readComments(fields.comment),
    created: readString(fields.created),
    updated: readString(fields.updated),
  };
}

function readAttachments(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const record = toRecord(item);
    return {
      id: readString(record.id),
      filename: readString(record.filename),
      mimeType: readString(record.mimeType),
      size: typeof record.size === "number" ? record.size : undefined,
      created: readString(record.created),
      author: readUser(record.author),
      /** 附件下载地址，传给 downloadAttachment */
      content: readString(record.content),
    };
  });
}

function readComments(value: unknown): Record<string, unknown>[] {
  const comment = toRecord(value);
  const comments = Array.isArray(comment.comments) ? comment.comments : [];
  return comments.map((item) => {
    const record = toRecord(item);
    return {
      author: readUser(record.author),
      body: readString(record.body) ?? "",
      created: readString(record.created),
      updated: readString(record.updated),
    };
  });
}

function readUser(value: unknown): Record<string, string> | undefined {
  const record = toRecord(value);
  const user: Record<string, string> = {};
  const name = readString(record.name);
  const key = readString(record.key);
  const displayName = readString(record.displayName);
  const emailAddress = readString(record.emailAddress);

  if (name) {
    user.name = name;
  }
  if (key) {
    user.key = key;
  }
  if (displayName) {
    user.displayName = displayName;
  }
  if (emailAddress) {
    user.emailAddress = emailAddress;
  }

  return Object.keys(user).length > 0 ? user : undefined;
}

function readNamedValue(value: unknown): string | undefined {
  const record = toRecord(value);
  return (
    readString(record.name) ??
    readString(record.key) ??
    readString(record.displayName)
  );
}

function readNamedArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readNamedValue)
    .filter((item): item is string => Boolean(item));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(
  body: string,
  invalidShapeMessage: string,
): JiraClientResult {
  try {
    const data = JSON.parse(body) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return error("invalid_response", invalidShapeMessage);
    }
    return { status: "success", data: data as Record<string, unknown> };
  } catch {
    return error("invalid_response", "Jira returned an invalid JSON response");
  }
}

function extractLoginForm(
  html: string,
  responseUrl: string,
): { actionUrl: string; hiddenFields: Record<string, string> } | undefined {
  const formMatch =
    findLoginForm(html) ??
    html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*>/i);
  if (!formMatch) {
    return undefined;
  }

  const actionMatch = formMatch[0].match(/\saction=["']([^"']*)["']/i);
  const actionUrl = new URL(
    actionMatch?.[1] ?? "/login.jsp",
    responseUrl,
  ).toString();
  const hiddenFields: Record<string, string> = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = input.match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) {
      continue;
    }
    hiddenFields[name] = input.match(/\svalue=["']([^"']*)["']/i)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields };
}

function findLoginForm(html: string): RegExpMatchArray | undefined {
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const formMatch of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(formMatch[0])) {
      return formMatch;
    }
  }
  return undefined;
}

function isAnonymous(response: JiraFetchResponse, body: string): boolean {
  const headerUser = response.headers.get("x-ausername")?.trim().toLowerCase();
  if (headerUser === "anonymous") {
    return true;
  }
  if (headerUser) {
    return false;
  }

  const remoteUser = body.match(
    /<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i,
  );
  if (remoteUser) {
    return remoteUser[1].trim() === "";
  }

  const lowered = body.toLowerCase();
  return (
    lowered.includes("log in - easemob jira") ||
    lowered.includes('name="os_username"')
  );
}

function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }

  const value = headers.get("set-cookie");
  if (!value) {
    return [];
  }
  return splitSetCookieHeader(value);
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function parseSetCookie(value: string): JiraCookie | undefined {
  const [pair] = value.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  };
}

function withoutEmptyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== ""),
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function buildJql(options: {
  project?: string;
  assignees?: string[];
  daysBack?: number;
}): string {
  const clauses = [];

  if (options.project) {
    clauses.push(`project = ${quoteJqlValue(options.project)}`);
  }

  if (options.assignees && options.assignees.length > 0) {
    const quoted = options.assignees.map(quoteJqlValue).join(", ");
    clauses.push(
      options.assignees.length === 1
        ? `assignee = ${quoted}`
        : `assignee in (${quoted})`,
    );
  }

  if (options.daysBack && options.daysBack > 0) {
    clauses.push(`updated >= -${options.daysBack}d`);
  }

  const base = clauses.length > 0 ? clauses.join(" AND ") : "1=1";
  return `${base} ORDER BY updated DESC`;
}

const SEARCH_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "issuetype",
  "components",
  "labels",
  "assignee",
  "reporter",
  "updated",
  "comment",
].join(",");

function quoteJqlValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function mapHttpError(status: number, body?: string): JiraClientError {
  if (status === 400) {
    let message = "Jira rejected the issue key or request parameters";
    if (body) {
      try {
        const errorData = JSON.parse(body) as Record<string, unknown>;
        const errorMessages = errorData.errorMessages;
        const errors = errorData.errors;
        if (Array.isArray(errorMessages) && errorMessages.length > 0) {
          message = errorMessages
            .filter((item) => typeof item === "string")
            .join(", ");
        } else if (errors && typeof errors === "object") {
          message = Object.entries(errors as Record<string, unknown>)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(", ");
        }
      } catch {
        // Keep the safe default message.
      }
    }
    return error("invalid_input", message);
  }
  if (status === 401) {
    return error("authentication_failed", "Jira authentication failed");
  }
  if (status === 403) {
    return error("permission_denied", "Jira permission denied");
  }
  if (status === 404) {
    return error("ticket_not_found", "Jira ticket was not found");
  }
  if (status === 429) {
    return error("rate_limited", "Jira rate limit exceeded");
  }
  if (status >= 500) {
    return error("jira_server_error", "Jira server error");
  }
  return error("invalid_response", "Jira returned an unexpected HTTP status");
}

function error(code: JiraClientErrorCode, message: string): JiraClientError {
  return { status: "error", code, message };
}
