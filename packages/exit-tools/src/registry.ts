import { createConfluenceExitTool } from "./confluence.js";
import { createGithubExitTool } from "./github.js";
import { createJiraExitTool } from "./jira.js";
import { createMailExitTool } from "./mail.js";
import type { ExitRegistry, ExitTool } from "./types.js";
import { createWebhookExitTool } from "./webhook.js";
import { createWecomAibotExitTool } from "./wecom-aibot.js";
import { createWecomWebhookExitTool } from "./wecom-webhook.js";

/** 创建注册表（登记全部七个内置工具） */
export function createExitRegistry(): ExitRegistry {
  const tools: ExitTool[] = [
    createWecomWebhookExitTool(),
    createMailExitTool(),
    createWebhookExitTool(),
    createWecomAibotExitTool(),
    createGithubExitTool(),
    createJiraExitTool(),
    createConfluenceExitTool(),
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
