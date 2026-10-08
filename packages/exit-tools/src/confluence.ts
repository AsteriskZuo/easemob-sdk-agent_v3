import type { ConfigField, ExitTool } from "./types.js";

const KIND = "confluence";

/** ConfluenceClient 构造参数：凭证全部构造注入，类内零 process.env、零全局状态 */
export interface ConfluenceClientOptions {
  /** 站点根地址（自动去尾斜杠），如 https://c1.private.easemob.com */
  baseUrl: string;
  /** 应用凭证：Confluence 用户名（表单登录用） */
  username: string;
  /** 应用凭证：Confluence 密码 */
  password: string;
  /** SLB 网关 Basic 用户名（存在时每个请求都带网关 Authorization 头） */
  gatewayUsername?: string;
  /** SLB 网关 Basic 密码 */
  gatewayPassword?: string;
  /** 请求超时毫秒数，缺省 30000（实测网关偶发 >15s 响应） */
  timeoutMs?: number;
}

/** 页面引用：findPage 的返回；version 为当前 version.number，更新时需 +1 */
export interface PageRef {
  id: string;
  version: number;
}

/** 登录表单解析结果：action 可能为相对路径，hidden 为全部 hidden input 的 name/value */
interface LoginForm {
  action: string;
  hidden: Array<[string, string]>;
}

/** 从登录页 HTML 解析登录表单。选择器兼容链（实测裁决）：
 *  name="loginform"（Confluence 实测）→ id="login-form"（Jira 风格兜底）→ 首个 form */
function parseLoginForm(html: string): LoginForm | undefined {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(
    (m) => m[0],
  );
  if (forms.length === 0) return undefined;
  const formHtml =
    forms.find((f) => /\bname\s*=\s*["']loginform["']/i.test(f)) ??
    forms.find((f) => /\bid\s*=\s*["']login-form["']/i.test(f)) ??
    forms[0];
  const action = /<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/i.exec(
    formHtml,
  )?.[1];
  const hidden: Array<[string, string]> = [];
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\btype\s*=\s*["']hidden["']/i.test(tag)) continue;
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    hidden.push([name, value]);
  }
  return { action: action ?? "/dologin.action", hidden };
}

/** 无业务知识的 Confluence Server REST 客户端（5.8.10 实测链路）。
 *  认证：每个请求带网关 Basic（凭证存在时）；应用层经 login.action 表单登录
 *  获得 seraph.confluence 会话 cookie；REST 401 时清会话重登一次重试。
 *  实例持有 cookie 与 authenticated 标志，每绑定一实例，禁止全局单例。 */
export class ConfluenceClient {
  readonly #baseUrl: string;
  readonly #username: string;
  readonly #password: string;
  readonly #gatewayAuth?: string;
  readonly #timeoutMs: number;
  /** 实例私有会话 cookie（name → value） */
  #cookies = new Map<string, string>();
  /** 是否已完成表单登录（登录成功后 REST 401 才触发自愈重登） */
  #authenticated = false;

  constructor(options: ConfluenceClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#username = options.username;
    this.#password = options.password;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (options.gatewayUsername && options.gatewayPassword) {
      this.#gatewayAuth = `Basic ${Buffer.from(
        `${options.gatewayUsername}:${options.gatewayPassword}`,
      ).toString("base64")}`;
    }
  }

  /** 表单登录：GET /login.action → 解析登录表单 → POST dologin.action。
   *  302 判定成功并收纳 Set-Cookie；其余状态抛错（含 200，登录失败重渲染表单页） */
  async login(): Promise<void> {
    const pageRes = await fetch(`${this.#baseUrl}/login.action`, {
      redirect: "manual",
      headers: this.#headers(),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    this.#storeCookies(pageRes);
    if (pageRes.status === 401) {
      throw new Error("Confluence 网关认证失败：HTTP 401（检查网关凭证）");
    }
    if (!pageRes.ok) {
      throw new Error(`Confluence 获取登录页失败：HTTP ${pageRes.status}`);
    }
    const form = parseLoginForm(await pageRes.text());
    if (!form) {
      throw new Error("Confluence 登录页解析失败：未找到登录表单");
    }
    // hidden input 全量提取 + 覆盖登录字段（os_cookie/os_destination 来自 hidden）
    const body = new URLSearchParams();
    for (const [name, value] of form.hidden) body.set(name, value);
    body.set("os_username", this.#username);
    body.set("os_password", this.#password);
    const loginRes = await fetch(
      new URL(form.action, this.#baseUrl + "/").toString(),
      {
        method: "POST",
        redirect: "manual",
        headers: this.#headers({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: body.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    this.#storeCookies(loginRes);
    if (loginRes.status < 300 || loginRes.status >= 400) {
      throw new Error(`Confluence 登录失败：HTTP ${loginRes.status}`);
    }
    this.#authenticated = true;
  }

  /** 按 spaceKey + 标题查页。返回 { id, version }；未找到返回 undefined。
   *  GET /rest/api/content?type=page&spaceKey=..&title=..&expand=version，取 results[0] */
  async findPage(
    spaceKey: string,
    title: string,
  ): Promise<PageRef | undefined> {
    const qs = new URLSearchParams({
      type: "page",
      spaceKey,
      title,
      expand: "version",
    });
    const res = await this.#request(`/rest/api/content?${qs}`);
    if (!res.ok) {
      throw new Error(await this.#errorText("查询页面失败", res));
    }
    const data: unknown = await res.json();
    const first = (data as { results?: unknown[] }).results?.[0] as
      { id?: unknown; version?: { number?: unknown } } | undefined;
    if (!first) return undefined;
    return { id: String(first.id), version: Number(first.version?.number) };
  }

  /** 建页。POST /rest/api/content，5.8.10 成功返回 200（非 201）；
   *  非 2xx 抛错（含状态码与响应片段）。返回新页 id */
  async createPage(
    spaceKey: string,
    title: string,
    xhtml: string,
  ): Promise<string> {
    const res = await this.#request("/rest/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "page",
        title,
        space: { key: spaceKey },
        body: { storage: { value: xhtml, representation: "storage" } },
      }),
    });
    if (!res.ok) {
      throw new Error(await this.#errorText("创建页面失败", res));
    }
    const data: unknown = await res.json();
    const id = (data as { id?: unknown }).id;
    if (id === undefined || id === null) {
      throw new Error("创建页面失败：响应缺少 id");
    }
    return String(id);
  }

  /** 整体覆盖更新。PUT /rest/api/content/{id}，body 同 createPage 且必须带
   *  version:{number: version+1}；409（版本过期）抛带明确消息的错误，
   *  不做自动重试（重试归调度循环）；其余非 2xx 抛错（含状态码与响应片段） */
  async updatePage(
    id: string,
    version: number,
    spaceKey: string,
    title: string,
    xhtml: string,
  ): Promise<void> {
    const res = await this.#request(`/rest/api/content/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        type: "page",
        title,
        space: { key: spaceKey },
        body: { storage: { value: xhtml, representation: "storage" } },
        version: { number: version + 1 },
      }),
    });
    if (res.status === 409) {
      throw new Error(
        `更新页面失败：HTTP 409 版本冲突（页面 ${id} 基于过期版本 ${version}，请重查后重试）`,
      );
    }
    if (!res.ok) {
      throw new Error(await this.#errorText("更新页面失败", res));
    }
  }

  /** 登录态自愈请求：未登录先登录；REST 401 时清会话重新登录并重试一次 */
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.#authenticated) await this.login();
    const res = await this.#rawFetch(path, init);
    if (res.status === 401) {
      this.#authenticated = false;
      this.#cookies.clear();
      await this.login();
      return this.#rawFetch(path, init);
    }
    return res;
  }

  async #rawFetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(this.#baseUrl + path, {
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeoutMs),
      ...init,
      headers: this.#headers(
        (init.headers as Record<string, string> | undefined) ?? {},
      ),
    });
  }

  /** 组装公共请求头：网关 Basic（存在时）+ 会话 cookie（存在时） */
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers = { ...extra };
    if (this.#gatewayAuth) headers.Authorization = this.#gatewayAuth;
    const cookie = [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  /** 收纳响应 Set-Cookie（取每个 cookie 的 name=value 首段） */
  #storeCookies(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx > 0)
        this.#cookies.set(
          pair.slice(0, idx).trim(),
          pair.slice(idx + 1).trim(),
        );
    }
  }

  async #errorText(action: string, res: Response): Promise<string> {
    const snippet = await res.text().catch(() => "");
    return `${action}：HTTP ${res.status} ${snippet.slice(0, 200)}`;
  }
}

const configSchema: ConfigField[] = [
  {
    key: "base_url",
    label: "站点地址",
    required: true,
    placeholder: "https://c1.private.easemob.com",
  },
  { key: "space_key", label: "空间 Key", required: true, placeholder: "AIR" },
  { key: "page_title", label: "页面标题", required: true },
  { key: "username", label: "Confluence 用户名", required: true },
  { key: "password", label: "Confluence 密码", required: true, secret: true },
  { key: "gateway_username", label: "网关用户名", secret: true },
  { key: "gateway_password", label: "网关密码", secret: true },
];

/** destination_id 段清洗：'/' '\' ':' 与控制字符替换为 '_'（文件路径安全） */
function sanitizeSegment(s: string): string {
  return s.replace(/[/\\:\x00-\x1f\x7f]/g, "_");
}

function requireField(config: Record<string, string>, key: string): string {
  const value = config[key]?.trim();
  if (!value) {
    throw new Error(`出口工具 '${KIND}' 缺少必需配置项 '${key}'`);
  }
  return value;
}

/** payload 提取正文：字符串原样；对象取 content 字段（string | object）。
 *  其余形状（数字/布尔/null、对象缺 content、content 非 string/object）抛错 */
function extractContent(result: unknown): string | object {
  if (typeof result === "string") return result;
  if (result !== null && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (content === undefined) {
      throw new Error("Confluence 投递失败：payload 缺少 'content' 字段");
    }
    if (typeof content === "string") return content;
    if (content !== null && typeof content === "object") return content;
  }
  throw new Error(
    "Confluence 投递失败：payload 必须是字符串或含 'content' 字段（string | object）的对象",
  );
}

/** 正文转 storage XHTML（严格 XML）：对象先 JSON.stringify(_, null, 2)；
 *  & < > 转义，行内换行转 <br/>，整体包 <p>...</p> */
function toStorageXhtml(content: string | object): string {
  const text =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<p>${escaped.replace(/\r?\n/g, "<br/>")}</p>`;
}

function defaultCreateClient(config: Record<string, string>): ConfluenceClient {
  return new ConfluenceClient({
    baseUrl: config.base_url,
    username: config.username,
    password: config.password,
    gatewayUsername: config.gateway_username?.trim() || undefined,
    gatewayPassword: config.gateway_password?.trim() || undefined,
  });
}

/** Confluence 出口工具（kind = 'confluence'，name = 'Confluence 操作'）。
 *  deliver 语义：get-or-create——按 spaceKey+标题查页，存在则整体覆盖更新
 *  （version 取查页返回值 +1），不存在则创建。
 *  createClient 可注入（测试用），缺省 new ConfluenceClient */
export function createConfluenceExitTool(options?: {
  createClient?: (config: Record<string, string>) => ConfluenceClient;
}): ExitTool {
  return {
    kind: KIND,
    name: "Confluence 操作",
    implemented: true,
    configSchema,
    resultDoc: `# Confluence 操作：sdk.return 期望形状

业务返回以下两种形状之一，作为页面正文（转 storage XHTML 后整体覆盖写入）：

- **字符串**：原样作为正文
- **对象**：须含 \`content\` 字段（\`string | object\`；对象转 json 文本）

目标页面由配置项 \`space_key\` + \`page_title\` 决定：已存在则整体覆盖更新，不存在则创建。

## 示例

\`\`\`json
"# 审查结论\\n\\n工单 PRJ-123：通过"
\`\`\`

\`\`\`json
{ "content": { "verdict": "pass", "score": 92 } }
\`\`\`
`,
    destinationOf(config) {
      const baseUrl = requireField(config, "base_url");
      const spaceKey = requireField(config, "space_key");
      const pageTitle = requireField(config, "page_title");
      let host: string;
      try {
        host = new URL(baseUrl).host;
      } catch {
        throw new Error(
          `出口工具 '${KIND}' 配置非法：base_url 不是合法地址（${baseUrl}）`,
        );
      }
      // 站点 + 页面标识：创建型无页面 id，用 host + spaceKey + title 做投递键
      return [host, spaceKey, pageTitle].map(sanitizeSegment).join("__");
    },
    bind(config) {
      for (const field of configSchema) {
        if (field.required) requireField(config, field.key);
      }
      const spaceKey = config.space_key.trim();
      const pageTitle = config.page_title.trim();
      const client = (options?.createClient ?? defaultCreateClient)(config);
      return {
        async deliver(result) {
          const xhtml = toStorageXhtml(extractContent(result));
          const existing = await client.findPage(spaceKey, pageTitle);
          if (existing) {
            await client.updatePage(
              existing.id,
              existing.version,
              spaceKey,
              pageTitle,
              xhtml,
            );
          } else {
            await client.createPage(spaceKey, pageTitle, xhtml);
          }
        },
      };
    },
  };
}
