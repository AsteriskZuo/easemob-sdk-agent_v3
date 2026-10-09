import { CONTRACT_VERSION } from "@asteriskzuo/agent-contracts";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { JiraClient } from "@asteriskzuo/agent-jira-client";
import type {
  JiraClientConfig,
  JiraIssueLite,
  JiraResult,
  JiraSearchOptions,
} from "@asteriskzuo/agent-jira-client";
import { logger } from "@asteriskzuo/agent-logger";
import type { TaskQueue } from "@asteriskzuo/agent-queue";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import { configString } from "./match-scan.js";

/** 轮询器依赖的 jira 搜索客户端最小面（测试注入 fake；缺省 = @asteriskzuo/agent-jira-client 的 JiraClient） */
export interface JiraSearchClient {
  /** JQL 搜索（轻量字段集）；error 由轮询器记日志跳过本轮 */
  searchIssues(
    options: JiraSearchOptions,
  ): Promise<JiraResult<JiraIssueLite[]>>;
}

/** 轮询间隔缺省（秒）与下限（秒）：低于下限按下限执行 */
export const JIRA_POLL_INTERVAL_DEFAULT_SECONDS = 60;
export const JIRA_POLL_INTERVAL_MIN_SECONDS = 30;

/** jira-polling match 行 entry_config 的解析结果（必填齐全后） */
export interface JiraPollConfig {
  /** jira 站点根地址 */
  jira_url: string;
  /** jira 用户名的 secrets 键名（凭据存业务 secrets 桶，此处只存键名引用） */
  username_key: string;
  /** jira 密码的 secrets 键名 */
  password_key: string;
  /** 项目 key（JQL `project = "X"`） */
  project: string;
  /** 负责人过滤列表；undefined = 不过滤（缺省或 `*`） */
  assignees?: string[];
  /** JQL `updated >= -Nd`；默认 7 */
  days_back: number;
  /** 轮询间隔秒（已套用默认 60 / 下限 30） */
  interval_seconds: number;
}

function configNumber(
  config: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = config?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // 容忍字符串数字（控制台裸 JSON 手填场景）
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 解析 jira-polling match 行 entry_config：必填缺失/非法 → problems 非空。
 *  不抛错——行配置是用户数据，调用方按 problems 记日志跳过本轮 */
export function parseJiraEntryConfig(
  entryConfig: Record<string, unknown> | undefined,
): { ok: true; config: JiraPollConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const jiraUrl = configString(entryConfig, "jira_url");
  const usernameKey = configString(entryConfig, "username_key");
  const passwordKey = configString(entryConfig, "password_key");
  const project = configString(entryConfig, "project");
  if (jiraUrl === undefined) problems.push("缺 jira_url");
  if (usernameKey === undefined) problems.push("缺 username_key");
  if (passwordKey === undefined) problems.push("缺 password_key");
  if (project === undefined) problems.push("缺 project");

  // assignees：缺省或 '*' = 不过滤；否则逗号分隔解析
  const assigneesRaw = configString(entryConfig, "assignees");
  const assignees =
    assigneesRaw === undefined || assigneesRaw.trim() === "*"
      ? undefined
      : assigneesRaw
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "");

  const daysBack = configNumber(entryConfig, "days_back") ?? 7;
  const intervalRaw =
    configNumber(entryConfig, "interval_seconds") ??
    JIRA_POLL_INTERVAL_DEFAULT_SECONDS;
  const intervalSeconds = Math.max(JIRA_POLL_INTERVAL_MIN_SECONDS, intervalRaw);

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      jira_url: jiraUrl as string,
      username_key: usernameKey as string,
      password_key: passwordKey as string,
      project: project as string,
      ...(assignees !== undefined && assignees.length > 0 ? { assignees } : {}),
      days_back: daysBack,
      interval_seconds: intervalSeconds,
    },
  };
}

/** 单匹配行轮询器的依赖 */
export interface JiraPollerDeps {
  /** 入口队列（产出事件的唯一出口） */
  queue: TaskQueue;
  /** 两桶环境配置（username_key/password_key 键名引用在此取真值） */
  env: EnvProvider;
}

/** 单匹配行轮询器创建参数 */
export interface JiraPollerOptions {
  /** 归属业务 id（secrets 桶取用 + 日志上下文的锚） */
  business_id: string;
  /** 产出事件的 event_type（= match 行的 event_type） */
  event_type: string;
  /** 该 match 行的 entry_config（未配置 = undefined） */
  entry_config?: Record<string, unknown>;
  /** 注入依赖 */
  deps: JiraPollerDeps;
  /** jira 客户端工厂（测试注入假客户端；缺省 = 共享包 JiraClient） */
  clientFactory?: (config: JiraClientConfig) => JiraSearchClient;
}

/** 单匹配行轮询器：防重入（上一轮未完跳过本轮）；配置/凭据缺失记 warn 跳过，不抛错 */
export interface JiraPoller {
  /** 轮询器键（`{business_id}::{event_type}`，适配器对账用） */
  readonly key: string;
  /** 是否正在执行一轮（观测/测试用） */
  readonly running: boolean;
  /** 执行一轮轮询；进行中再调 = 跳过本轮（防重入）。返回 promise 供测试等待完成 */
  run(): Promise<void>;
}

/** 创建单匹配行轮询器 */
export function createJiraPoller(options: JiraPollerOptions): JiraPoller {
  const log = logger.for({ module: "entry-adapter-jira" });
  const clientFactory =
    options.clientFactory ??
    ((config: JiraClientConfig) => new JiraClient(config));
  const key = `${options.business_id}::${options.event_type}`;
  let running = false;

  return {
    key,
    get running() {
      return running;
    },

    async run(): Promise<void> {
      // 防重入：上一轮未完跳过本轮
      if (running) return;
      running = true;
      try {
        const parsed = parseJiraEntryConfig(options.entry_config);
        if (!parsed.ok) {
          log.warn("jira 轮询行配置非法，跳过本轮", {
            business_id: options.business_id,
            event_type: options.event_type,
            problems: parsed.problems,
          });
          return;
        }
        const config = parsed.config;

        // 凭据：entry_config 存 secrets 键名引用，真值从业务 secrets 桶取
        const secrets = options.deps.env.getFor(options.business_id).secrets;
        const username = secrets[config.username_key];
        const password = secrets[config.password_key];
        if (username === undefined || password === undefined) {
          log.warn("jira 轮询凭据缺失，跳过本轮", {
            business_id: options.business_id,
            username_key: config.username_key,
            password_key: config.password_key,
          });
          return;
        }

        const client = clientFactory({
          baseUrl: config.jira_url,
          username,
          password,
        });
        const result = await client.searchIssues({
          project: config.project,
          ...(config.assignees !== undefined
            ? { assignees: config.assignees }
            : {}),
          daysBack: config.days_back,
        });
        if (result.status === "error") {
          log.error("jira 轮询失败", {
            business_id: options.business_id,
            event_type: options.event_type,
            code: result.code,
            error: result.message,
          });
          return;
        }

        for (const issue of result.data) {
          // event_id = jira:{issueKey}:{updated}：同 updated 重推被队列幂等丢弃，
          // updated 变化 = 新事件，天然增量
          const eventId = `jira:${issue.key}:${issue.updated}`;
          const envelope: EventEnvelope = {
            contract_version: CONTRACT_VERSION,
            source: "jira",
            event_id: eventId,
            event_type: options.event_type,
            timestamp: new Date().toISOString(),
            session_id: issue.key,
            correlation_id: eventId,
            hop_count: 0,
            payload: {
              issue_key: issue.key,
              summary: issue.summary,
              status: issue.status,
              priority: issue.priority,
              issue_type: issue.issue_type,
              assignee: issue.assignee,
              reporter: issue.reporter,
              updated: issue.updated,
            },
          };
          options.deps.queue.enqueue(envelope);
        }
        log.info("jira 轮询完成", {
          business_id: options.business_id,
          event_type: options.event_type,
          issues: result.data.length,
        });
      } finally {
        running = false;
      }
    },
  };
}
