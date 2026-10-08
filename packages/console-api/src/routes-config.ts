import type { ExitRegistry } from "@asterisk/agent-exit-tools";
import type { EffectiveConfigView, ExitToolMenuItem } from "./dto.js";
import { sendJson } from "./http.js";
import type { Route } from "./router.js";

/** 配置回显 + 出口工具菜单（全部只读，登录即可） */
export function configRoutes(deps: {
  config: EffectiveConfigView;
  exits: ExitRegistry;
}): Route[] {
  const { config, exits } = deps;
  return [
    {
      method: "GET",
      pattern: "/api/config",
      handler: (_req, res) => {
        // 生效中的平台配置（非敏感子集，装配层注入时已完成去敏感）；
        // 只读：改配置 = 改环境变量/{workspace}/config.json 后重启
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
        }));
        sendJson(res, 200, menu);
      },
    },
  ];
}
