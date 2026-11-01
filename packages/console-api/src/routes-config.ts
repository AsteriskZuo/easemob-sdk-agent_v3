import type { ExitRegistry } from "@asteriskzuo/agent-exit-tools";
import type { User } from "./accounts.js";
import type { EffectiveConfigView, ExitToolMenuItem } from "./dto.js";
import { ApiError } from "./errors.js";
import { sendJson } from "./http.js";
import type { Route } from "./router.js";
import type { UpdateSubmitter } from "./updates.js";

/** 配置回显 + 出口工具菜单 + 资产缓存清理（前两个只读登录即可；缓存清理仅 admin）。
 *  缓存清理经统一更新队列（全业务屏障：清空物化缓存期间不能有任何业务在跑） */
export function configRoutes(deps: {
  config: EffectiveConfigView;
  exits: ExitRegistry;
  updates: UpdateSubmitter;
}): Route[] {
  const { config, exits, updates } = deps;
  return [
    {
      method: "GET",
      pattern: "/api/config",
      handler: (_req, res) => {
        // 生效中的平台配置（非敏感子集，装配层注入时已完成去敏感）；
        // 只读：启动配置 = 改环境变量/{workspace}/platform/config.json 后重启
        sendJson(res, 200, config);
      },
    },
    {
      method: "GET",
      pattern: "/api/exit-tools",
      handler: (_req, res) => {
        const menu: ExitToolMenuItem[] = exits.list().map((tool) => ({
          kind: tool.kind,
          name: tool.name,
          implemented: tool.implemented,
          configSchema: tool.configSchema,
          resultDoc: tool.resultDoc,
        }));
        sendJson(res, 200, menu);
      },
    },
    {
      method: "POST",
      pattern: "/api/cache/clear",
      handler: async (req, res) => {
        const actor = req.actor as User;
        if (actor.role !== "admin") {
          throw new ApiError("forbidden", "仅 admin 可清理资产缓存");
        }
        // 清空 {workspace}/platform/cache/assets/（登记行不动；清理后下次 run 触发重新物化构建，
        // 可能耗时分钟级——console 侧已在确认弹窗写明后果）
        const submission = await updates.submit<{ cleared: boolean }>({
          kind: "asset.cache.clear",
          payload: {},
          business_ids: "all",
          requested_by: actor.user_id,
        });
        if (submission.outcome === "applied") {
          sendJson(res, 200, submission.result);
        } else {
          sendJson(res, 202, { accepted: true });
        }
      },
    },
  ];
}
