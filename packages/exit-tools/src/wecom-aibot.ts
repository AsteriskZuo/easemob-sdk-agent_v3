import type { ConfigField, ExitTool } from "./types.js";

const KIND = "wecom-aibot";

/** 智能机器人 markdown 消息体上限 20480 UTF-8 字节（区别于 webhook 的 4096） */
const MAX_CONTENT_BYTES = 20480;

const TRUNCATED_SUFFIX = "\n…(已截断)";

const configSchema: ConfigField[] = [
  {
    key: "bot_id",
    label: "机器人 ID（BotID）",
    required: true,
    placeholder: "智能机器人 BotID，用于匹配连接属主",
  },
  {
    key: "chat_id",
    label: "会话 ID",
    required: true,
    placeholder: "群 chatid 或用户 userid，必须来自真实交互",
  },
  {
    key: "user_id",
    label: "用户 ID",
    required: true,
    placeholder: "触发该任务的用户 userid（群聊时记录触发者）",
  },
];

/** 发送外观：由装配根的 AibotConnector 实现，本包不感知 SDK 与长连接 */
export interface AibotSender {
  /** 向指定会话发送 markdown 消息；失败（含对端 errcode 拒绝）抛错 */
  send(chatId: string, markdownContent: string): Promise<void>;
}

function requireSegment(config: Record<string, string>, key: string): string {
  const value = config[key]?.trim();
  if (!value) throw new Error(`出口工具 '${KIND}' 缺少必需配置项 '${key}'`);
  return value;
}

/** 文件路径安全化：/ \ : 与控制字符替换为 _ */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[/\\:\x00-\x1f\x7f]/g, "_");
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

/** 企微智能机器人出口工具（kind = 'wecom-aibot'）。
 *  自己不建连：bind 时经 resolveSender(botId) 向装配根申请对应 botId 的
 *  连接属主的发送外观；解析器缺失即抛错（resolveSender 自身抛错则原样透出） */
export function createWecomAibotExitTool(options?: {
  resolveSender?: (botId: string) => AibotSender;
}): ExitTool {
  const resolveSender = options?.resolveSender;
  return {
    kind: KIND,
    name: "企业微信智能机器人",
    implemented: true,
    configSchema,
    destinationOf(config) {
      return [
        requireSegment(config, "bot_id"),
        requireSegment(config, "chat_id"),
        requireSegment(config, "user_id"),
      ]
        .map(sanitizeSegment)
        .join("__");
    },
    bind(config) {
      const botId = requireSegment(config, "bot_id");
      const chatId = requireSegment(config, "chat_id");
      requireSegment(config, "user_id"); // 参与 destinationOf 与必填校验，deliver 不直接使用
      if (!resolveSender) {
        throw new Error(
          `出口工具 '${KIND}' 需要装配根注入 AibotSender 解析器（resolveSender）`,
        );
      }
      const sender = resolveSender(botId);
      return {
        async deliver(result) {
          await sender.send(chatId, buildContent(result));
        },
      };
    },
  };
}
