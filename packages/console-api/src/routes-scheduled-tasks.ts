import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type { TaskScheduler } from "@asteriskzuo/agent-runtime";
import type { User } from "./accounts.js";
import { ApiError } from "./errors.js";
import { sendJson } from "./http.js";
import type { Route } from "./router.js";

/** 定时任务路由（spec 2026-11-13 D6）：清单 + 最近 run 状态只读（登录即可）；
 *  手动「立即执行」= 写操作纪律，与业务路由一致（creator 本人或 admin） */
export function scheduledTaskRoutes(deps: {
  registry: BusinessRegistry;
  taskScheduler: TaskScheduler;
}): Route[] {
  const { registry, taskScheduler } = deps;
  return [
    {
      method: "GET",
      pattern: "/api/businesses/:id/scheduled-tasks",
      handler: async (req, res) => {
        const businessId = req.params.id;
        if (registry.getProfile(businessId) === undefined) {
          throw new ApiError("not_found", `业务不存在: ${businessId}`);
        }
        const tasks = await taskScheduler.describeTasks(businessId);
        sendJson(res, 200, { tasks });
      },
    },
    {
      method: "POST",
      pattern: "/api/businesses/:id/scheduled-tasks/:name/run",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        const profile = registry.getProfile(businessId);
        if (profile === undefined) {
          throw new ApiError("not_found", `业务不存在: ${businessId}`);
        }
        if (actor.role !== "admin" && profile.creator_id !== actor.user_id) {
          throw new ApiError(
            "forbidden",
            "仅业务创建者或 admin 可手动执行定时任务",
          );
        }
        try {
          const { run_id } = await taskScheduler.runNow(
            businessId,
            req.params.name,
            "manual",
          );
          // 202：发起即返回，执行在后台（run 记录随后出现在任务监控）
          sendJson(res, 202, { run_id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith("scheduled_task_running")) {
            throw new ApiError("conflict", message);
          }
          if (message.startsWith("scheduled_task_not_found")) {
            throw new ApiError("not_found", message);
          }
          throw err;
        }
      },
    },
  ];
}
