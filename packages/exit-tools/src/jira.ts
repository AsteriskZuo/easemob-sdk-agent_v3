import { JiraClient } from "@asterisk/agent-jira-client";
import type { JiraResult } from "@asterisk/agent-jira-client";
import type { ConfigField, ExitTool } from "./types.js";

const KIND = "jira";
/** 出口客户端单请求超时（出口调用是短链路，比共享包缺省 30s 更紧） */
const TIMEOUT_MS = 15_000;

/** deliver 依赖的 jira 客户端最小面（测试注入 fake；缺省 = @asterisk/agent-jira-client 的 JiraClient） */
export interface JiraWriteClient {
  /** 加评论；error 由 deliver 转 throw */
  addComment(issueKey: string, body: string): Promise<JiraResult<unknown>>;
  /** 建工单；error 由 deliver 转 throw */
  createIssue(
    fields: Record<string, unknown>,
  ): Promise<JiraResult<{ key: string }>>;
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

/** 缺省 client 工厂：把绑定配置（snake_case 键）映射为共享包 JiraClientConfig */
function defaultCreateClient(config: Record<string, string>): JiraWriteClient {
  return new JiraClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    redirectUsername: config.redirect_username,
    redirectPassword: config.redirect_password,
    timeoutMs: TIMEOUT_MS,
  });
}

/** 双态 error → 出口失败语义（deliver 本就是 try/catch 失败语义） */
function throwOnError(result: JiraResult<unknown>): void {
  if (result.status === "error") {
    throw new Error(`${result.code}: ${result.message}`);
  }
}

/** Jira 操作出口工具（kind = 'jira'）。
 *  createClient 可注入（测试用），缺省直接 new JiraClient（共享包） */
export function createJiraExitTool(
  options: {
    createClient?: (config: Record<string, string>) => JiraWriteClient;
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
            throwOnError(await client.addComment(issueKey, text));
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
            throwOnError(
              await client.createIssue({
                project: { key: project },
                summary,
                ...(description ? { description } : {}),
                ...extra,
              }),
            );
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
