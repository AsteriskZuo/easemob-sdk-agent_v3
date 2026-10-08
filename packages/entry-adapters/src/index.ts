export type {
  EntryAdapter,
  EntryAdapterCreateOptions,
  EntryAdapterFactory,
  EntryAdapterSpec,
  EntryDeps,
} from "./types.js";
export { scanMatchRows, getByPath } from "./match-scan.js";
export {
  createWebhookEntryAdapter,
  WebhookEntryAdapter,
  WEBHOOK_ADAPTER_SPEC,
} from "./webhook.js";
export { createJiraSearchClient, buildJql } from "./jira-client.js";
export type {
  JiraIssueLite,
  JiraSearchClient,
  JiraSearchClientConfig,
  JiraSearchErrorCode,
  JiraSearchOptions,
  JiraSearchResult,
} from "./jira-client.js";
export { createJiraPoller, parseJiraEntryConfig } from "./jira-poller.js";
export type {
  JiraPollConfig,
  JiraPoller,
  JiraPollerDeps,
  JiraPollerOptions,
} from "./jira-poller.js";
export {
  createJiraPollingEntryAdapter,
  JiraPollingEntryAdapter,
  JIRA_POLLING_ADAPTER_SPEC,
} from "./jira-polling.js";

import type { EntryAdapterFactory } from "./types.js";
import { WEBHOOK_ADAPTER_SPEC, createWebhookEntryAdapter } from "./webhook.js";
import {
  JIRA_POLLING_ADAPTER_SPEC,
  createJiraPollingEntryAdapter,
} from "./jira-polling.js";

/** 内置入口适配器清单（装配根按开关过滤后创建启动；开关语义见 spec §7.4） */
export const ENTRY_ADAPTERS: EntryAdapterFactory[] = [
  { spec: WEBHOOK_ADAPTER_SPEC, create: createWebhookEntryAdapter },
  { spec: JIRA_POLLING_ADAPTER_SPEC, create: createJiraPollingEntryAdapter },
];
