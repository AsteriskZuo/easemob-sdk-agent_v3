import { createMailExitTool } from "./mail.js";
import { createPlaceholderExitTool } from "./placeholders.js";
import type { ExitRegistry, ExitTool } from "./types.js";
import { createWebhookExitTool } from "./webhook.js";
import { createWecomWebhookExitTool } from "./wecom-webhook.js";

/** 创建注册表（登记全部七个内置工具：三个实现 + 四个占位） */
export function createExitRegistry(): ExitRegistry {
  const tools: ExitTool[] = [
    createWecomWebhookExitTool(),
    createMailExitTool(),
    createWebhookExitTool(),
    createPlaceholderExitTool("wecom-aibot", "企业微信智能机器人"),
    createPlaceholderExitTool("github", "GitHub 操作"),
    createPlaceholderExitTool("jira", "Jira 操作"),
    createPlaceholderExitTool("confluence", "Confluence 操作"),
  ];
  const byKind = new Map(tools.map((tool) => [tool.kind, tool]));
  return {
    get(kind) {
      const tool = byKind.get(kind);
      if (!tool) throw new Error(`未注册的出口工具：'${kind}'`);
      return tool;
    },
    list() {
      return [...tools];
    },
  };
}
