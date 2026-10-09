import { logger } from "@asteriskzuo/agent-logger";
import type { AccountService, Role, User } from "./accounts.js";
import type { CreateUserBody, SetDisabledBody } from "./dto.js";
import {
  requireBoolean,
  requireNonEmptyString,
  requirePlainObject,
  sendJson,
  sendNoContent,
} from "./http.js";
import type { Route } from "./router.js";

/** 用户管理路由（全部仅 admin；权限在服务层强制，member 访问 → 403） */
export function userRoutes(deps: { accounts: AccountService }): Route[] {
  const { accounts } = deps;
  const log = logger.for({ module: "console-api" });
  return [
    {
      method: "GET",
      pattern: "/api/users",
      handler: (req, res) => {
        sendJson(res, 200, accounts.listUsers(req.actor as User));
      },
    },
    {
      method: "POST",
      pattern: "/api/users",
      handler: (req, res) => {
        const actor = req.actor as User;
        const body = requirePlainObject(
          req.body,
          "body",
        ) as Partial<CreateUserBody>;
        const user = accounts.createUser(actor, {
          username: requireNonEmptyString(body.username, "username"),
          display_name: requireNonEmptyString(
            body.display_name,
            "display_name",
          ),
          password: requireNonEmptyString(body.password, "password"),
          role: requireNonEmptyString(body.role, "role") as Role,
        });
        log.info("API 创建用户", {
          operator_id: actor.user_id,
          user_id: user.user_id,
        });
        sendJson(res, 201, user);
      },
    },
    {
      method: "POST",
      pattern: "/api/users/:id/disabled",
      handler: (req, res) => {
        const actor = req.actor as User;
        const body = requirePlainObject(
          req.body,
          "body",
        ) as Partial<SetDisabledBody>;
        const disabled = requireBoolean(body.disabled, "disabled");
        accounts.setDisabled(actor, req.params.id, disabled);
        log.info("API 停用/启用用户", {
          operator_id: actor.user_id,
          user_id: req.params.id,
          disabled,
        });
        sendNoContent(res);
      },
    },
  ];
}
