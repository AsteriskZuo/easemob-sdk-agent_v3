import { logger } from "@asteriskzuo/agent-logger";
import type { JiraClientConfig } from "@asteriskzuo/agent-jira-client";
import type { BusinessMatch } from "@asteriskzuo/agent-registry";
import { resolveConfigPlaceholders } from "@asteriskzuo/agent-runtime";
import { scanMatchRows } from "./match-scan.js";
import { createJiraPoller, parseJiraEntryConfig } from "./jira-poller.js";
import type { JiraPoller, JiraSearchClient } from "./jira-poller.js";
import type { EntryAdapter, EntryAdapterSpec, EntryDeps } from "./types.js";

/** 注册表对账 tick 间隔（毫秒）：业务创建/更新/删除的轮询器增删延迟上限 */
const RECONCILE_TICK_MS = 10_000;

/** 轮询器键（`{business_id}::{event_type}`）：与 JiraPoller.key 同规则 */
function pollerKey(row: BusinessMatch): string {
  return `${row.business_id}::${row.event_type}`;
}

/** 行配置签名：对账时据此判断「同一行配置是否变化」（变化 = 重建轮询器） */
function configSignature(row: BusinessMatch): string {
  return JSON.stringify(row.entry_config ?? null);
}

/** jira-polling 适配器自描述 */
export const JIRA_POLLING_ADAPTER_SPEC: EntryAdapterSpec = {
  id: "jira-polling",
  kind: "jira",
  name: "Jira 定时轮询",
  defaultEnabled: false,
  configSchema: [
    {
      key: "jira_url",
      label: "Jira 站点根地址",
      required: true,
      placeholder: "如 https://jira.example.com",
    },
    {
      key: "username",
      label: "用户名",
      required: true,
      placeholder: "建议填 {{jira_username}} 占位，真值存环境配置",
    },
    {
      key: "password",
      label: "密码",
      required: true,
      placeholder: "建议填 {{jira_password}} 占位，真值存环境配置",
    },
    {
      key: "redirect_username",
      label: "网关 Basic 账号（可选）",
      placeholder: "可填 {{key}} 占位，真值存环境配置",
    },
    {
      key: "redirect_password",
      label: "网关 Basic 密码（可选）",
      placeholder: "可填 {{key}} 占位，真值存环境配置",
    },
    {
      key: "project",
      label: "项目 key",
      required: true,
      placeholder: 'JQL project = "X" 的 X',
    },
    {
      key: "assignees",
      label: "负责人过滤",
      placeholder: "逗号分隔；缺省或 * = 不过滤",
    },
    {
      key: "days_back",
      label: "回溯天数",
      placeholder: "JQL updated >= -Nd，默认 7",
    },
    {
      key: "interval_seconds",
      label: "轮询间隔（秒）",
      placeholder: "默认 60，下限 30",
    },
  ],
  eventDoc: `# Jira 定时轮询入口

## 定位与约束

- 内部测试与无外网 webhook 场景的 jira 工单拉取入口；**默认关闭**（\`AGENT_ENTRY_JIRA_POLLING_ENABLED=true\` 开启）
- 认证为 easemob jira **表单登录**形态（/login.jsp 提交 os_username/os_password，非 REST 基本认证/API Token）；凭据在 entry_config 的 \`username\`/\`password\` 字段填 \`{{key}}\` 占位，真值存环境配置
- 经网关反代时可配 \`redirect_username\`/\`redirect_password\`（网关 Basic 认证，可选），同样支持占位
- 占位符写法：整值占位 \`"password": "{{jira_password}}"\` 或内嵌占位 \`"jira_url": "https://{{jira_host}}"\`；轮询时按 业务 secrets → 业务 vars → 全局 secrets → 全局 vars 顺序取第一个命中解析
- 每条 source='jira' 的 match 行一个独立轮询器，按 \`interval_seconds\`（默认 60，下限 30）周期执行 JQL 搜索：\`project = "<project>" AND assignee in (<assignees>) AND updated >= -<days_back>d ORDER BY updated DESC\`

## 事件类型

Jira 原生事件类型有 \`jira:issue_created\` / \`jira:issue_updated\` / \`jira:issue_deleted\` / \`comment_created\` 等；本适配器是轮询形态，**不区分原生事件类型**，统一产出为 match 行配置的 \`event_type\`（建议 \`jira.issue.updated\`）。

## 产出信封

- \`source\` = "jira"；\`session_id\` = 工单 key；\`event_id\` = \`jira:{issueKey}:{updated}\`（同 updated 重推被队列幂等丢弃，updated 变化 = 新事件，天然增量）
- \`payload\`（轻量字段；详情由业务自行 sdk.run 拉取，平台不做预取）：

\`\`\`json
{
  "issue_key": "PRJ-123",
  "summary": "工单摘要",
  "status": "In Progress",
  "priority": "Major",
  "issue_type": "Bug",
  "assignee": "zhangsan",
  "reporter": "lisi",
  "updated": "2026-10-08T10:00:00.000+0800"
}
\`\`\`
`,
};

/** 内部轮询器槽位：poller + 定时器 + 配置签名（对账依据） */
interface PollerSlot {
  poller: JiraPoller;
  timer: NodeJS.Timeout;
  signature: string;
}

/** JiraPollingEntryAdapter 构造参数（测试注入用；装配根走 ENTRY_ADAPTERS 工厂不经此） */
export interface JiraPollingAdapterOptions {
  /** jira 客户端工厂：测试注入立即返回的假客户端，避免 syncTick 内 fire-and-forget
   *  的 run 走真实 JiraClient 网络请求（会拖过套件 teardown）；缺省 = 共享包 JiraClient */
  clientFactory?: (config: JiraClientConfig) => JiraSearchClient;
}

/** jira-polling 入口适配器：每 tick 现查注册表 source='jira' 行集合，动态增删轮询器。
 *  每行一个独立轮询器（防重入在 JiraPoller 内）；行配置变化 = 重建该轮询器 */
export class JiraPollingEntryAdapter implements EntryAdapter {
  readonly source = "jira" as const;

  private deps: EntryDeps | null = null;
  private readonly pollers = new Map<string, PollerSlot>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly clientFactory?: (
    config: JiraClientConfig,
  ) => JiraSearchClient;

  constructor(options?: JiraPollingAdapterOptions) {
    this.clientFactory = options?.clientFactory;
  }

  /** 装配根调用：立即对账一次 + 启动周期对账（RECONCILE_TICK_MS）。重复调用幂等 */
  start(deps: EntryDeps): void {
    if (this.deps !== null) return;
    this.deps = deps;
    this.syncTick();
    this.reconcileTimer = setInterval(() => this.syncTick(), RECONCILE_TICK_MS);
    this.reconcileTimer.unref(); // 定时器不吊住进程（优雅停靠 stop()）
    logger
      .for({ module: "entry-adapter-jira" })
      .info("jira-polling 入口已启动", {
        pollers: this.pollers.size,
      });
  }

  /** 注册表对账：现扫 source='jira' 行集合，增删/重建轮询器。
   *  公开化供测试直接驱动（不经 10s 周期等待）；装配根无需调它 */
  syncTick(): void {
    const deps = this.deps;
    if (deps === null) return;
    const log = logger.for({ module: "entry-adapter-jira" });
    const rows = scanMatchRows(deps.registry, "jira");
    const desired = new Map<string, BusinessMatch>();
    for (const row of rows) desired.set(pollerKey(row), row);

    // 删：行已不存在 → 停定时器、移除轮询器
    for (const [key, slot] of this.pollers) {
      if (desired.has(key)) continue;
      clearInterval(slot.timer);
      this.pollers.delete(key);
      log.info("jira 轮询器已移除", { key });
    }

    // 增/改：新行建轮询器；签名变化 = 配置变化 → 重建（换定时周期/查询条件）
    for (const [key, row] of desired) {
      const signature = configSignature(row);
      const existing = this.pollers.get(key);
      if (existing !== undefined && existing.signature === signature) continue;
      if (existing !== undefined) {
        clearInterval(existing.timer);
        this.pollers.delete(key);
      }
      const poller = createJiraPoller({
        business_id: row.business_id,
        event_type: row.event_type,
        ...(row.entry_config !== undefined
          ? { entry_config: row.entry_config }
          : {}),
        deps: { queue: deps.queue, env: deps.env },
        ...(this.clientFactory !== undefined
          ? { clientFactory: this.clientFactory }
          : {}),
      });
      // 间隔取自行配置（缺省 60s、下限 30s 在 parse 内收敛）；配置非法行也给默认周期
      // （非法行 run 内记 warn 跳过，不影响其他行）。interval_seconds 等字段可占位，
      // 先解析占位再 parse；占位键缺失按非法行处理（run 内会再记 warn）
      let resolvedConfig = row.entry_config;
      try {
        resolvedConfig = resolveConfigPlaceholders(
          row.entry_config ?? {},
          deps.env,
          row.business_id,
        );
      } catch {
        // 占位缺失：本轮间隔取缺省，run 内会按配置非法记 warn 跳过
      }
      const parsed = parseJiraEntryConfig(resolvedConfig);
      const intervalSeconds = parsed.ok ? parsed.config.interval_seconds : 60;
      const timer = setInterval(() => {
        void poller.run();
      }, intervalSeconds * 1000);
      timer.unref();
      this.pollers.set(key, { poller, timer, signature });
      log.info("jira 轮询器已创建", { key, interval_seconds: intervalSeconds });
      // 新建即先跑一轮（不必等首个间隔）；失败/配置非法在 run 内自闭环
      void poller.run();
    }
  }

  /** 当前活跃轮询器键（排序）；观测/测试用 */
  pollerKeys(): string[] {
    return [...this.pollers.keys()].sort();
  }

  /** 停全部定时器；幂等 */
  stop(): Promise<void> {
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const slot of this.pollers.values()) {
      clearInterval(slot.timer);
    }
    this.pollers.clear();
    this.deps = null;
    return Promise.resolve();
  }
}

/** 创建 jira-polling 入口适配器 */
export function createJiraPollingEntryAdapter(): JiraPollingEntryAdapter {
  return new JiraPollingEntryAdapter();
}
