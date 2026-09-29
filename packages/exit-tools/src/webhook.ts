import { postJson } from "./http.js";
import type { ConfigField, ExitTool } from "./types.js";

const KIND = "webhook";

const configSchema: ConfigField[] = [
  {
    key: "url",
    label: "目标地址",
    required: true,
    placeholder: "https://example.com/hooks/xxx",
  },
  { key: "token", label: "Bearer 令牌", secret: true },
];

function requireUrl(config: Record<string, string>): string {
  const url = config.url?.trim();
  if (!url) throw new Error(`出口工具 '${KIND}' 缺少必需配置项 'url'`);
  return url;
}

/** destination_id 规范化：去协议头，逐字符把 ':' 与 '/' 替换为 '_' */
function normalizeUrl(url: string): string {
  try {
    new URL(url);
  } catch {
    throw new Error(`${KIND} 配置非法：url 不是合法地址（${url}）`);
  }
  return url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/[:/]/g, "_");
}

/** 自定义 webhook 出口工具（kind = 'webhook'） */
export function createWebhookExitTool(): ExitTool {
  return {
    kind: KIND,
    name: "自定义 Webhook",
    implemented: true,
    configSchema,
    destinationOf(config) {
      return normalizeUrl(requireUrl(config));
    },
    bind(config) {
      const url = requireUrl(config);
      const token = config.token?.trim();
      return {
        deliver(result) {
          return postJson(
            url,
            result,
            token
              ? { headers: { Authorization: `Bearer ${token}` } }
              : undefined,
          );
        },
      };
    },
  };
}
