import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type {
  LifecycleStore,
  LlmCallStore,
  RunMetricsStore,
} from "@asteriskzuo/agent-runtime";
import type { TaskQueue, TaskStatus } from "@asteriskzuo/agent-queue";
import { parseDateParam } from "./date-param.js";
import type {
  QueueCounts,
  QueuesStatus,
  RunDetailResponse,
  RunLogResponse,
} from "./dto.js";
import { ApiError } from "./errors.js";
import { sendJson } from "./http.js";
import type { HttpRequest } from "./http.js";
import type { Route } from "./router.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "processing",
  "done",
  "dead",
];

/** run_id 形状（Crockford base32 ULID，与 workflow-runner RUN_ID_PATTERN 同源）；
 *  日志路由路径安全第一道闸：不合形状一律 400，绝不进文件系统 */
const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

/** 日志读取默认字节数：256 KB（排障看尾部） */
const DEFAULT_LOG_BYTES = 262144;

/** 日志读取字节数上限：1 MB（防大文件打爆页面） */
const MAX_LOG_BYTES = 1048576;

/** 单队列计数：queue 无 count 口，v1 全量拉取逐状态聚合（行量大时的优化归后续） */
function countQueue(queue: TaskQueue): QueueCounts {
  return {
    pending: queue.query({ status: "pending" }).length,
    processing: queue.query({ status: "processing" }).length,
    done: queue.query({ status: "done" }).length,
    dead: queue.query({ status: "dead" }).length,
  };
}

function queueOf(
  req: HttpRequest,
  entryQueue: TaskQueue,
  exitQueue: TaskQueue,
): TaskQueue {
  const name = req.query.get("queue");
  if (name === "entry") return entryQueue;
  if (name === "exit") return exitQueue;
  throw new ApiError("invalid_input", "queue 参数必填且取值为 entry 或 exit");
}

/** 解析日志读取字节数：缺省 DEFAULT_LOG_BYTES；正整数、上限 MAX_LOG_BYTES，非法 → 400 */
function parseLogBytes(req: HttpRequest): number {
  const raw = req.query.get("bytes");
  if (raw === null) return DEFAULT_LOG_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError("invalid_input", `bytes 必须是正整数: ${raw}`);
  }
  if (parsed > MAX_LOG_BYTES) {
    throw new ApiError(
      "invalid_input",
      `bytes 上限 ${MAX_LOG_BYTES}: ${raw}`,
    );
  }
  return parsed;
}

/** 在 {logsRoot} 下做两层目录扫描（第一层 = source、第二层 = session_id），
 *  找文件名恰为 {fileName} 的日志文件。只下钻目录、只匹配精确文件名，
 *  不解析 channel_id、不拼接任何用户输入进路径 */
function findLogFile(logsRoot: string, fileName: string): string | undefined {
  let sources;
  try {
    sources = readdirSync(logsRoot, { withFileTypes: true });
  } catch {
    return undefined; // 目录不存在/不可读 = 无日志
  }
  for (const source of sources) {
    if (!source.isDirectory()) continue;
    const sourceDir = join(logsRoot, source.name);
    let sessions;
    try {
      sessions = readdirSync(sourceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(sourceDir, session.name);
      let files;
      try {
        files = readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.isFile() && file.name === fileName) {
          return join(sessionDir, file.name);
        }
      }
    }
  }
  return undefined;
}

/** 监控路由（全部只读，登录即可）。
 *  llmCalls / runMetrics 缺装 = 降级：detail 对应字段恒 []（与 stats 路由同纪律）；
 *  workspaceRoot 缺装 = 降级：log 路由照常注册但一律 404（日志接口未装配） */
export function monitoringRoutes(deps: {
  entryQueue: TaskQueue;
  exitQueue: TaskQueue;
  lifecycle: LifecycleStore;
  llmCalls?: LlmCallStore;
  runMetrics?: RunMetricsStore;
  /** 平台 workspace 根（runner 日志落盘同根），日志定位的唯一事实源 */
  workspaceRoot?: string;
}): Route[] {
  const { entryQueue, exitQueue, lifecycle, llmCalls, runMetrics, workspaceRoot } =
    deps;
  return [
    {
      method: "GET",
      pattern: "/api/monitor/queues",
      handler: (_req, res) => {
        const status: QueuesStatus = {
          entry: countQueue(entryQueue),
          exit: countQueue(exitQueue),
        };
        sendJson(res, 200, status);
      },
    },
    {
      method: "GET",
      pattern: "/api/monitor/tasks",
      handler: (req, res) => {
        const queue = queueOf(req, entryQueue, exitQueue);
        const status = req.query.get("status");
        if (
          status !== null &&
          !(TASK_STATUSES as readonly string[]).includes(status)
        ) {
          throw new ApiError(
            "invalid_input",
            `status 非法: ${status}（允许: ${TASK_STATUSES.join("/")}）`,
          );
        }
        const eventId = req.query.get("event_id");
        const correlationId = req.query.get("correlation_id");
        const tasks = queue.query({
          ...(status !== null ? { status: status as TaskStatus } : {}),
          ...(eventId !== null ? { event_id: eventId } : {}),
          ...(correlationId !== null ? { correlation_id: correlationId } : {}),
        });
        sendJson(res, 200, tasks);
      },
    },
    {
      method: "GET",
      pattern: "/api/businesses/:id/runs",
      handler: (req, res) => {
        // date=YYYY-MM-DD：按本地日历日过滤（走 listByBusinessOnDate，忽略 limit，
        // 读口自身 500 行上限）；不提供时行为与现状完全一致（limit 路径不动）
        const rawDate = req.query.get("date");
        if (rawDate !== null) {
          const date = parseDateParam(rawDate, "date");
          sendJson(res, 200, lifecycle.listByBusinessOnDate(req.params.id, date));
          return;
        }
        let limit = 50;
        const raw = req.query.get("limit");
        if (raw !== null) {
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new ApiError("invalid_input", `limit 必须是正整数: ${raw}`);
          }
          limit = Math.min(parsed, 500);
        }
        sendJson(res, 200, lifecycle.listByBusiness(req.params.id, limit));
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:id",
      handler: (req, res) => {
        const record = lifecycle.get(req.params.id);
        if (record === undefined) {
          throw new ApiError("not_found", `运行记录不存在: ${req.params.id}`);
        }
        sendJson(res, 200, record);
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:id/detail",
      handler: (req, res) => {
        const record = lifecycle.get(req.params.id);
        if (record === undefined) {
          throw new ApiError("not_found", `运行记录不存在: ${req.params.id}`);
        }
        const body: RunDetailResponse = {
          record,
          llm_calls: llmCalls?.listByRun(record.lifecycle_id) ?? [],
          metrics: runMetrics?.listByRun(record.lifecycle_id) ?? [],
        };
        sendJson(res, 200, body);
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:id/log",
      handler: (req, res) => {
        if (workspaceRoot === undefined) {
          throw new ApiError(
            "not_found",
            "日志接口未装配（workspace_root 未注入）",
          );
        }
        const runId = req.params.id;
        // 路径安全第一道闸：形状不合一律 400，run_id 绝不进文件系统路径
        if (!RUN_ID_PATTERN.test(runId)) {
          throw new ApiError("invalid_input", `run_id 形状非法: ${runId}`);
        }
        const limit = parseLogBytes(req);
        const record = lifecycle.get(runId);
        if (record === undefined) {
          throw new ApiError("not_found", `运行记录不存在: ${runId}`);
        }
        const logsRoot = join(
          workspaceRoot,
          "businesses",
          record.business_id,
          "logs",
        );
        const logPath = findLogFile(logsRoot, `${runId}.log`);
        if (logPath === undefined) {
          throw new ApiError("not_found", "日志不存在或已轮转");
        }
        const size = statSync(logPath).size;
        let content: string;
        let truncated = false;
        if (size <= limit) {
          content = readFileSync(logPath, "utf8");
        } else {
          const fd = openSync(logPath, "r");
          try {
            const buf = Buffer.alloc(limit);
            readSync(fd, buf, 0, limit, size - limit);
            content = buf.toString("utf8");
          } finally {
            closeSync(fd);
          }
          truncated = true;
        }
        const body: RunLogResponse = {
          run_id: runId,
          path: relative(workspaceRoot, logPath).split(sep).join("/"),
          content,
          truncated,
          size,
        };
        sendJson(res, 200, body);
      },
    },
  ];
}
