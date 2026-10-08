import type { ConfigField, ExitTool } from "./types.js";

const KIND = "jira";
const TIMEOUT_MS = 15_000;

/** JiraClient 构造配置：url/应用账号必填，网关 Basic 凭证可空（直连场景） */
export interface JiraClientOptions {
  /** Jira 站点地址，如 https://j1.private.easemob.com（尾部斜杠会被去掉） */
  url: string;
  /** 应用账号（login.jsp 表单 os_username） */
  username: string;
  /** 应用密码（login.jsp 表单 os_password） */
  password: string;
  /** 网关 Basic 账号，存在时每个请求都带 Authorization 头 */
  redirectUsername?: string;
  /** 网关 Basic 密码 */
  redirectPassword?: string;
}

type JiraCookie = { name: string; value: string };

type FetchOutcome = { ok: boolean; status: number; body: string };

/**
 * Jira 6.x 写操作客户端：网关 Basic（可选）→ login.jsp 表单登录 → cookie
 * 会话重放；任一请求收到 401 视为会话过期，清会话重登后原请求重试一次。
 * 实例持有 cookie 与登录态，调用方控生命周期；类内零 process.env、零全局状态。
 */
export class JiraClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly redirectUsername?: string;
  private readonly redirectPassword?: string;
  private cookies: JiraCookie[] = [];
  private authenticated = false;

  constructor(options: JiraClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.username = options.username;
    this.password = options.password;
    this.redirectUsername = options.redirectUsername;
    this.redirectPassword = options.redirectPassword;
  }

  /** 轻量健康探测：认证 + 一次只读 serverInfo 请求 */
  async ping(): Promise<void> {
    await this.fetchAuthed(`${this.baseUrl}/rest/api/2/serverInfo`);
  }

  /** 给工单添加评论，body 原样提交 */
  async addComment(issueKey: string, body: string): Promise<void> {
    await this.fetchAuthed(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      { "Content-Type": "application/json" },
      JSON.stringify({ body }),
    );
  }

  /** 创建工单：fields 原样包进 {"fields": ...} 提交；返回响应 JSON 里的 key */
  async createIssue(fields: Record<string, unknown>): Promise<{ key: string }> {
    const body = await this.fetchAuthed(
      `${this.baseUrl}/rest/api/2/issue`,
      { "Content-Type": "application/json" },
      JSON.stringify({ fields }),
    );
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("Jira 创建工单响应不是合法 JSON");
    }
    const key = (data as Record<string, unknown>)?.key;
    if (typeof key !== "string" || !key) {
      throw new Error("Jira 创建工单响应缺少 key");
    }
    return { key };
  }

  /** 带会话自愈的认证请求：401 清登录态重新登录后原请求重试一次 */
  private async fetchAuthed(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<string> {
    const first = await this.fetchAuthedOnce(url, headers, body);
    if (first.status !== 401) {
      if (!first.ok) throw httpError(first.status, first.body);
      return first.body;
    }

    this.authenticated = false;
    this.cookies = [];
    const second = await this.fetchAuthedOnce(url, headers, body);
    if (!second.ok) throw httpError(second.status, second.body);
    return second.body;
  }

  private async fetchAuthedOnce(
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<FetchOutcome> {
    await this.ensureAuthenticated();
    return this.fetch(
      url,
      {
        ...this.gatewayHeaders(),
        ...headers,
        Cookie: this.cookieHeader(),
      },
      body,
    );
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.authenticated) {
      return;
    }

    const loginPage = await this.fetch(
      `${this.baseUrl}/login.jsp`,
      this.gatewayHeaders(),
    );
    if (!loginPage.ok) throw httpError(loginPage.status, loginPage.body);

    const form = extractLoginForm(loginPage.body, `${this.baseUrl}/login.jsp`);
    if (!form) throw new Error("Jira 登录失败：登录表单未找到");

    const payload = new URLSearchParams(form.hiddenFields);
    payload.set("os_username", this.username);
    payload.set("os_password", this.password);
    payload.set("os_cookie", "true");
    if (!payload.get("os_destination")) {
      payload.set("os_destination", "/secure/Dashboard.jspa");
    }

    const loginPost = await this.fetch(
      form.actionUrl,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      payload.toString(),
    );
    if (loginPost.status < 300 || loginPost.status >= 400) {
      throw new Error(
        `Jira 登录失败：HTTP ${loginPost.status}${loginPost.body ? `，响应片段：${loginPost.body.slice(0, 200)}` : ""}`,
      );
    }
    this.authenticated = true;
  }

  private async fetch(
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<FetchOutcome> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: withoutEmptyHeaders(headers),
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `Jira 请求失败：无法连接（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    this.storeCookies(response.headers);
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
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
    return this.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private storeCookies(headers: Headers): void {
    for (const setCookie of collectSetCookieHeaders(headers)) {
      const cookie = parseSetCookie(setCookie);
      if (!cookie) continue;
      this.cookies = this.cookies.filter((c) => c.name !== cookie.name);
      this.cookies.push(cookie);
    }
  }
}

function httpError(status: number, body: string): Error {
  return new Error(
    `Jira 请求失败：HTTP ${status}${body ? `，响应片段：${body.slice(0, 200)}` : ""}`,
  );
}

/** 从 login.jsp HTML 提取登录表单：优先 id="login-form"，退化为首个 form；
 *  提取表单内全部 hidden input 的 name/value，action 缺省 /login.jsp */
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

function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }
  const value = headers.get("set-cookie");
  return value ? splitSetCookieHeader(value) : [];
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

const configSchema: ConfigField[] = [
  {
    key: "url",
    label: "Jira 站点地址",
    required: true,
    placeholder: "https://j1.private.easemob.com",
  },
  { key: "project", label: "项目 key", required: true, placeholder: "HIM" },
  { key: "issue_key", label: "工单 key", placeholder: "绑定到具体工单时填" },
  { key: "username", label: "应用账号", required: true },
  { key: "password", label: "应用密码", required: true, secret: true },
  { key: "redirect_username", label: "网关 Basic 账号", secret: true },
  { key: "redirect_password", label: "网关 Basic 密码", secret: true },
];

/** destination_id 片段：host / key 中文件路径不安全字符（'/' '\' ':' 及控制字符）替换为 '_' */
function sanitizePathSegment(value: string): string {
  return value.replace(/[/\\:\x00-\x1f]/g, "_");
}

function requireUrl(config: Record<string, string>): string {
  const url = config.url?.trim();
  if (!url) throw new Error(`出口工具 '${KIND}' 缺少必需配置项 'url'`);
  return url;
}

function requireProject(config: Record<string, string>): string {
  const project = config.project?.trim();
  if (!project) throw new Error(`出口工具 '${KIND}' 缺少必需配置项 'project'`);
  return project;
}

/** 缺省 client 工厂：把绑定配置（snake_case 键）映射为 JiraClientOptions */
function defaultCreateClient(config: Record<string, string>): JiraClient {
  return new JiraClient({
    url: config.url,
    username: config.username,
    password: config.password,
    redirectUsername: config.redirect_username,
    redirectPassword: config.redirect_password,
  });
}

/** Jira 操作出口工具（kind = 'jira'）。
 *  createClient 可注入（测试用），缺省直接 new JiraClient */
export function createJiraExitTool(
  options: {
    createClient?: (config: Record<string, string>) => JiraClient;
  } = {},
): ExitTool {
  const createClient = options.createClient ?? defaultCreateClient;
  return {
    kind: KIND,
    name: "Jira 操作",
    implemented: true,
    configSchema,
    resultDoc: `# Jira 操作：sdk.return 期望形状

业务返回一个带 \`op\` 字段的对象，两种操作：

| op | 字段 | 语义 |
| --- | --- | --- |
| \`comment\` | \`body\`（必填） | 给配置项 \`issue_key\` 指定的工单加评论（此时 \`issue_key\` 配置必填） |
| \`create\` | \`fields\`（必填对象，含非空 \`summary\`，可选 \`description\` 及其余自定义字段） | 在配置项 \`project\` 项目下建工单 |

\`body\` / 非字符串内容：字符串原样；其他 JSON 值转 json 围栏文本。

## 示例

\`\`\`json
{ "op": "comment", "body": "审查完成：通过" }
\`\`\`

\`\`\`json
{ "op": "create", "fields": { "summary": "自动审查发现的问题", "description": "详见平台运行记录" } }
\`\`\`
`,
    destinationOf(config) {
      const url = requireUrl(config);
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        throw new Error(`${KIND} 配置非法：url 不是合法地址（${url}）`);
      }
      const project = requireProject(config);
      const key = config.issue_key?.trim() || project;
      return `${sanitizePathSegment(host)}__${sanitizePathSegment(key)}`;
    },
    bind(config) {
      for (const field of configSchema) {
        if (field.required && !config[field.key]?.trim()) {
          throw new Error(`出口工具 '${KIND}' 缺少必需配置项 '${field.key}'`);
        }
      }
      requireUrl(config);
      const project = requireProject(config);
      const issueKey = config.issue_key?.trim();
      const client = createClient({ ...config });
      return {
        async deliver(result) {
          if (!result || typeof result !== "object" || Array.isArray(result)) {
            throw new Error(
              `出口工具 '${KIND}' 的 payload 非法：必须是对象，形如 { op: 'comment', body } 或 { op: 'create', fields }`,
            );
          }
          const payload = result as Record<string, unknown>;

          if (payload.op === "comment") {
            if (!issueKey) {
              throw new Error(
                `出口工具 '${KIND}' 的 payload op='comment' 需要配置项 'issue_key'（绑定到具体工单）`,
              );
            }
            const body = payload.body;
            const text =
              typeof body === "string"
                ? body
                : "```json\n" + JSON.stringify(body, null, 2) + "\n```";
            await client.addComment(issueKey, text);
            return;
          }

          if (payload.op === "create") {
            const fields = payload.fields;
            if (
              !fields ||
              typeof fields !== "object" ||
              Array.isArray(fields)
            ) {
              throw new Error(
                `出口工具 '${KIND}' 的 payload op='create' 需要 fields 对象（含 summary）`,
              );
            }
            const { summary, description, ...extra } = fields as Record<
              string,
              unknown
            >;
            if (typeof summary !== "string" || !summary.trim()) {
              throw new Error(
                `出口工具 '${KIND}' 的 payload op='create' 的 fields.summary 必须是非空字符串`,
              );
            }
            if (description !== undefined && typeof description !== "string") {
              throw new Error(
                `出口工具 '${KIND}' 的 payload op='create' 的 fields.description 必须是字符串`,
              );
            }
            await client.createIssue({
              project: { key: project },
              summary,
              ...(description ? { description } : {}),
              ...extra,
            });
            return;
          }

          throw new Error(
            `出口工具 '${KIND}' 的 payload 非法：op 必须是 'comment' 或 'create'`,
          );
        },
      };
    },
  };
}
