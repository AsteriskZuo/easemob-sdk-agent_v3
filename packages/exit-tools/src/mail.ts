import nodemailer from "nodemailer";
import type { ConfigField, ExitTool } from "./types.js";

const KIND = "mail";

const DEFAULT_SUBJECT = "Easemob Agent 通知";

/** 邮件传输器最小接口：缺省用 nodemailer 实现，测试注入假 transport */
type MailTransport = { sendMail(options: unknown): Promise<unknown> };

const configSchema: ConfigField[] = [
  {
    key: "host",
    label: "SMTP 主机",
    required: true,
    placeholder: "smtp.example.com",
  },
  { key: "port", label: "SMTP 端口", required: true, placeholder: "465" },
  { key: "user", label: "SMTP 账号", required: true },
  { key: "pass", label: "SMTP 密码/授权码", required: true, secret: true },
  { key: "from", label: "发件地址", required: true },
  { key: "to", label: "收件地址", required: true },
  { key: "subject", label: "主题", placeholder: DEFAULT_SUBJECT },
];

/** 缺省 transport 工厂：config 为 bind 归一化后的配置（含 secure 标记） */
function defaultCreateTransport(config: Record<string, string>): MailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: config.secure === "true",
    auth: { user: config.user, pass: config.pass },
  }) as unknown as MailTransport;
}

/** 邮件通知出口工具（kind = 'mail'）。
 *  createTransport 可注入（测试用），缺省用 nodemailer */
export function createMailExitTool(
  createTransport: (
    config: Record<string, string>,
  ) => MailTransport = defaultCreateTransport,
): ExitTool {
  return {
    kind: KIND,
    name: "邮件通知",
    implemented: true,
    configSchema,
    destinationOf(config) {
      const to = config.to?.trim();
      if (!to) throw new Error(`出口工具 '${KIND}' 缺少必需配置项 'to'`);
      return to;
    },
    bind(config) {
      for (const field of configSchema) {
        if (field.required && !config[field.key]?.trim()) {
          throw new Error(`出口工具 '${KIND}' 缺少必需配置项 '${field.key}'`);
        }
      }
      const port = Number(config.port);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(
          `出口工具 '${KIND}' 配置非法：port='${config.port}' 不是合法数字`,
        );
      }
      // 归一化：465 端口走 TLS（secure）；标记并入 config 交给 transport 工厂
      const transport = createTransport({
        ...config,
        secure: String(config.port === "465"),
      });
      const from = config.from;
      const to = config.to;
      const subject = config.subject?.trim() || DEFAULT_SUBJECT;
      return {
        async deliver(result) {
          const text =
            typeof result === "string"
              ? result
              : "```json\n" + JSON.stringify(result, null, 2) + "\n```";
          await transport.sendMail({ from, to, subject, text });
        },
      };
    },
  };
}
