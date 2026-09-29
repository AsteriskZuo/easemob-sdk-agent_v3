import type { ConfigField, ExitTool } from "./types.js";

const KIND = "wecom-webhook";

/** 企微 markdown 消息体上限 4096 字节，截断阈值留余量 */
const MAX_CONTENT_BYTES = 4000;

const TRUNCATED_SUFFIX = "\n…(已截断)";

const configSchema: ConfigField[] = [
  {
    key: "url",
    label: "Webhook 地址",
    required: true,
    placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>",
  },
];

function requireUrl(config: Record<string, string>): string {
  const url = config.url?.trim();
  if (!url) throw new Error(`出口工具 '${KIND}' 缺少必需配置项 'url'`);
  return url;
}

/** 从 webhook url 的 query 提取 key 段；url 非法或无 key 抛错 */
function parseKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${KIND} 配置非法：url 不是合法地址（${url}）`);
  }
  const key = parsed.searchParams.get("key");
  if (!key) throw new Error(`${KIND} 配置非法：url 缺少 key 参数（${url}）`);
  return key;
}

/** 投递文本：字符串原样；其他类型走 json 围栏 */
function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  return "```json\n" + JSON.stringify(result, null, 2) + "\n```";
}

/** 按 UTF-8 字节截断，不切断多字节字符 */
function truncateToBytes(text: string, maxBytes: number): string {
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  // 截断点落在多字节字符中间时 toString 会补 U+FFFD，剥掉
  while (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return cut;
}

function buildContent(result: unknown): string {
  const text = resultToText(result);
  if (Buffer.byteLength(text, "utf8") <= MAX_CONTENT_BYTES) return text;
  return truncateToBytes(text, MAX_CONTENT_BYTES) + TRUNCATED_SUFFIX;
}

/** 企微群机器人 webhook 出口工具（kind = 'wecom-webhook'） */
export function createWecomWebhookExitTool(): ExitTool {
  return {
    kind: KIND,
    name: "企业微信群机器人",
    implemented: true,
    configSchema,
    destinationOf(config) {
      return parseKey(requireUrl(config));
    },
    bind(config) {
      const url = requireUrl(config);
      return {
        async deliver(result) {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              msgtype: "markdown",
              markdown: { content: buildContent(result) },
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            const snippet = await res.text().catch(() => "");
            throw new Error(
              `${KIND} 投递失败：HTTP ${res.status} ${snippet.slice(0, 200)}`,
            );
          }
          const data = (await res.json()) as {
            errcode?: number;
            errmsg?: string;
          };
          if (data.errcode !== 0) {
            throw new Error(
              `${KIND} 投递失败：errcode=${data.errcode} errmsg=${data.errmsg ?? ""}`,
            );
          }
        },
      };
    },
  };
}
