import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { CONTRACT_VERSION, newEventId } from "@asteriskzuo/agent-contracts";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { logger } from "@asteriskzuo/agent-logger";
import { configString, getByPath, scanMatchRows } from "./match-scan.js";
import type {
  EntryAdapter,
  EntryAdapterCreateOptions,
  EntryAdapterSpec,
  EntryDeps,
} from "./types.js";

/** 请求体上限（1MB）：防爆内存；超限按 400 处理 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 端点 path 合法字符集（与 spec §7.2 一致） */
const HOOK_PATH_PATTERN = /^\/hooks\/([a-z0-9-]+)$/;

/** webhook 适配器自描述（控制台展示 + entry_config 表单渲染 + eventDoc 对接文档） */
export const WEBHOOK_ADAPTER_SPEC: EntryAdapterSpec = {
  id: "webhook",
  kind: "webhook",
  name: "自定义 Webhook",
  defaultEnabled: true,
  configSchema: [
    {
      key: "path",
      label: "URL 路径段",
      required: true,
      placeholder:
        "如 jira-listener；合法字符 [a-z0-9-]，投递地址 = POST /hooks/{path}",
    },
    {
      key: "session_id_key",
      label: "session_id 字段路径",
      required: true,
      placeholder:
        "payload 内点分路径，如 issue.key；取不到/非非空字符串 → 400",
    },
    {
      key: "event_id_key",
      label: "event_id 字段路径",
      placeholder: "可选，点分路径；缺省平台生成（此时幂等由推送方自负）",
    },
    {
      key: "token_key",
      label: "验签 token 的 secrets 键名",
      placeholder:
        "填 secrets 键名（非 token 值本身）；设置后请求须带 x-webhook-token 头等值",
    },
  ],
  eventDoc: `# 自定义 Webhook 入口

## 契约说明

- 投递地址：\`POST /hooks/{path}\`，\`{path}\` 来自本业务 match 行（source='webhook'）的 \`entry_config.path\`
- body：必须是 JSON object，**payload 形状由推送方自定义**，平台原样透传进信封 \`payload\`
- \`session_id\`：从 body 按 \`session_id_key\` 点分路径提取（如 \`issue.key\`）；取不到或不是非空字符串 → 400
- \`event_id\`：可选，按 \`event_id_key\` 提取；缺省平台生成（\`evt_\` 前缀 ULID）。自带 event_id 时重推同 id 被队列幂等丢弃（仍回 200），实现「至少一次」去重
- 验签：配置 \`token_key\` 后，请求须带 header \`x-webhook-token\`，与该业务 secrets 桶中 \`token_key\` 对应值等值比对，不符 → 401
- 响应：\`200 { "event_id": "..." }\` / \`400\`（body 或字段非法，message 含原因）/ \`401\`（验签失败）/ \`404\`（未知 path）

## 产出信封

\`{ contract_version: "v1", source: "webhook", event_id, event_type: <match 行配置>, timestamp, session_id, correlation_id: = event_id, hop_count: 0, payload: <body 原样> }\`

## 示例

\`\`\`bash
curl -X POST http://<host>:6200/hooks/jira-listener \\
  -H 'Content-Type: application/json' \\
  -H 'x-webhook-token: <secrets 中配置的 token 值>' \\
  -d '{"issue": {"key": "PRJ-123"}, "action": "updated"}'
# → 200 {"event_id":"evt_01J..."}
\`\`\`

上例对应 entry_config：\`{ "path": "jira-listener", "session_id_key": "issue.key", "token_key": "webhook_token" }\`
`,
};

/** 写 JSON 响应（统一 Content-Type） */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 等值比对（等长走 timingSafeEqual 防时序侧信道；不等长直接 false） */
function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** webhook 入口适配器：独立 HTTP 服务（入口流量与管理 API 分离），承载任意多个端点。
 *  每请求现扫注册表内存视图按 path 路由——业务增删/改 entry_config 即时生效，无需重启 */
export class WebhookEntryAdapter implements EntryAdapter {
  readonly source = "webhook" as const;

  private readonly configuredPort: number;
  private server: Server | null = null;
  private deps: EntryDeps | null = null;
  /** listen 完成/失败信号（绑端口是异步的，start() 契约是 void，测试与观测经 ready() 等待） */
  private readyPromise: Promise<void> | null = null;

  constructor(opts?: EntryAdapterCreateOptions) {
    this.configuredPort = opts?.webhook_port ?? 6200;
  }

  /** 装配根调用：建 HTTP 服务并开始监听（异步；绑定失败记 error 日志，不拖垮装配）。
   *  重复调用幂等（已启动直接返回） */
  start(deps: EntryDeps): void {
    if (this.server !== null) return;
    this.deps = deps;
    const log = logger.for({ module: "entry-adapter-webhook" });
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        log.error("webhook 请求处理异常", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) sendJson(res, 500, { error: "内部错误" });
      });
    });
    this.server = server;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      server.once("error", (err) => {
        log.error("webhook 端口监听失败", {
          port: this.configuredPort,
          error: err.message,
        });
        reject(err);
      });
      server.listen(this.configuredPort, () => {
        log.info("webhook 入口已监听", { port: this.port() });
        resolve();
      });
    });
    // 装配根不等 ready：吞掉未观测拒绝（绑定失败已记日志）
    this.readyPromise.catch(() => {});
  }

  /** 监听就绪（或绑定失败 reject）；测试据此拿到真实端口后再发请求 */
  ready(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  /** 实际监听端口（listen 完成后可用；配置 0 = 随机时经它取真实端口） */
  port(): number {
    const address = this.server?.address();
    if (address !== null && typeof address === "object") {
      return (address as AddressInfo).port;
    }
    return this.configuredPort;
  }

  /** 关 server（断开存活连接）；幂等 */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      // close 回调在监听失败/已关闭场景同样会被调（带 error 参数），这里只看完成信号
      server.close(() => resolve());
      // 关掉 keep-alive 存活连接，否则 close 等到连接空闲超时
      server.closeAllConnections();
    });
  }

  /** 请求处理链：path 路由 → 验签 → body 校验 → 提取 session_id/event_id → 包装信封 → 落队 */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const log = logger.for({ module: "entry-adapter-webhook" });
    const deps = this.deps;
    if (deps === null) {
      sendJson(res, 500, { error: "适配器未启动" });
      return;
    }

    // ① path 路由：只收 POST /hooks/{path}
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const match = HOOK_PATH_PATTERN.exec(pathname);
    if (req.method !== "POST" || match === null) {
      sendJson(res, 404, { error: "未知端点" });
      return;
    }
    const path = match[1] as string;
    // 现查注册表内存视图：按 entry_config.path 找 match 行（业务增删即时生效）
    const row = scanMatchRows(deps.registry, "webhook").find(
      (r) => configString(r.entry_config, "path") === path,
    );
    if (row === undefined) {
      sendJson(res, 404, { error: `未知 webhook path: ${path}` });
      return;
    }
    const entryConfig = row.entry_config;

    // ② 验签：token_key 配置时，从该业务 secrets 桶取值比对 x-webhook-token
    const tokenKey = configString(entryConfig, "token_key");
    if (tokenKey !== undefined) {
      const expected = deps.env.getFor(row.business_id).secrets[tokenKey];
      const provided = req.headers["x-webhook-token"];
      if (
        expected === undefined ||
        typeof provided !== "string" ||
        !tokenEquals(provided, expected)
      ) {
        sendJson(res, 401, { error: "验签失败" });
        return;
      }
    }

    // ③ body 必须 JSON object
    const body = await this.readBody(req);
    if (body === null) {
      sendJson(res, 400, { error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "请求体不是合法 JSON" });
      return;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      sendJson(res, 400, { error: "请求体必须是 JSON object" });
      return;
    }

    // ④ 提取 session_id（必填，点分路径）
    const sessionIdKey = configString(entryConfig, "session_id_key");
    if (sessionIdKey === undefined) {
      sendJson(res, 400, { error: "该端点未配置 session_id_key" });
      return;
    }
    const sessionId = getByPath(payload, sessionIdKey);
    if (typeof sessionId !== "string" || sessionId === "") {
      sendJson(res, 400, {
        error: `按 session_id_key "${sessionIdKey}" 取不到非空字符串`,
      });
      return;
    }

    // ⑤ 提取 event_id（可选；缺省/取不到 → 平台生成；取到非非空字符串 → 400）
    const eventIdKey = configString(entryConfig, "event_id_key");
    let eventId: string;
    if (eventIdKey === undefined) {
      eventId = newEventId();
    } else {
      const raw = getByPath(payload, eventIdKey);
      if (raw === undefined) {
        eventId = newEventId();
      } else if (typeof raw === "string" && raw !== "") {
        eventId = raw;
      } else {
        sendJson(res, 400, {
          error: `按 event_id_key "${eventIdKey}" 取到的值不是非空字符串`,
        });
        return;
      }
    }

    // ⑥ 包装信封落队（payload = body 原样；event_id 兼任幂等键，重推被队列丢弃仍回 200）
    const envelope: EventEnvelope = {
      contract_version: CONTRACT_VERSION,
      source: "webhook",
      event_id: eventId,
      event_type: row.event_type,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      correlation_id: eventId,
      hop_count: 0,
      payload,
    };
    deps.queue.enqueue(envelope);
    log.info("webhook 事件已落队", {
      event_id: eventId,
      business_id: row.business_id,
      path,
    });
    sendJson(res, 200, { event_id: eventId });
  }

  /** 读请求体（上限 MAX_BODY_BYTES；超限返回 null 按 400 处理） */
  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      req.on("data", (chunk: Buffer) => {
        if (overflow) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          overflow = true;
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (overflow) return;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  }
}

/** 创建 webhook 入口适配器（opts.webhook_port 缺省 6200，0 = 随机端口） */
export function createWebhookEntryAdapter(
  opts?: EntryAdapterCreateOptions,
): WebhookEntryAdapter {
  return new WebhookEntryAdapter(opts);
}
