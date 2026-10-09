import type { LifecycleStore } from "@asteriskzuo/agent-runtime";
import type { TaskQueue, TaskStatus } from "@asteriskzuo/agent-queue";
import { ApiError } from "./errors.js";
import type { QueueCounts, QueuesStatus } from "./dto.js";
import { sendJson } from "./http.js";
import type { HttpRequest } from "./http.js";
import type { Route } from "./router.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "processing",
  "done",
  "dead",
];

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

/** 监控路由（全部只读，登录即可） */
export function monitoringRoutes(deps: {
  entryQueue: TaskQueue;
  exitQueue: TaskQueue;
  lifecycle: LifecycleStore;
}): Route[] {
  const { entryQueue, exitQueue, lifecycle } = deps;
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
  ];
}
