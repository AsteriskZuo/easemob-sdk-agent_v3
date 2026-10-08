import { logger } from "@asterisk/agent-logger";
import type { EnvProvider } from "@asterisk/agent-runtime";
import type { BusinessRegistry } from "@asterisk/agent-registry";
import type { User } from "./accounts.js";
import { ApiError } from "./errors.js";
import type { EnvListView, EnvRemoveBody, EnvSetBody } from "./dto.js";
import {
  requireNonEmptyString,
  requirePlainObject,
  sendJson,
  sendNoContent,
} from "./http.js";
import type { Route } from "./router.js";

type Bucket = "vars" | "secrets";

function parseBucket(value: unknown): Bucket {
  if (value !== "vars" && value !== "secrets") {
    throw new ApiError("invalid_input", "bucket 必须是 vars 或 secrets");
  }
  return value;
}

function parseSetBody(body: unknown): {
  bucket: Bucket;
  key: string;
  value: string;
} {
  const obj = requirePlainObject(body, "body") as Partial<EnvSetBody>;
  const bucket = parseBucket(obj.bucket);
  const key = requireNonEmptyString(obj.key, "key");
  if (typeof obj.value !== "string") {
    throw new ApiError("invalid_input", "value 必须是字符串");
  }
  return { bucket, key, value: obj.value };
}

function parseRemoveBody(body: unknown): { bucket: Bucket; key: string } {
  const obj = requirePlainObject(body, "body") as Partial<EnvRemoveBody>;
  return {
    bucket: parseBucket(obj.bucket),
    key: requireNonEmptyString(obj.key, "key"),
  };
}

function toView(list: {
  vars: Record<string, string>;
  secret_keys: string[];
}): EnvListView {
  return { vars: list.vars, secret_keys: list.secret_keys };
}

/** 环境配置路由（两桶 × 通用层/业务层）：
 *  读 = 登录用户；通用层写 = 仅 admin；业务层写 = creator 本人或 admin */
export function envRoutes(deps: {
  env: EnvProvider;
  registry: BusinessRegistry;
}): Route[] {
  const { env, registry } = deps;
  const log = logger.for({ module: "console-api" });

  function assertGlobalWritable(actor: User): void {
    if (actor.role !== "admin") {
      throw new ApiError("forbidden", "通用层环境配置仅 admin 可写");
    }
  }

  /** 业务层写权限：业务存在（404）+ creator 本人或 admin（403） */
  function assertBusinessWritable(actor: User, businessId: string): void {
    const profile = registry.getProfile(businessId);
    if (profile === undefined) {
      throw new ApiError("not_found", `业务不存在: ${businessId}`);
    }
    if (actor.role !== "admin" && profile.creator_id !== actor.user_id) {
      throw new ApiError("forbidden", "仅业务创建者或 admin 可写");
    }
  }

  return [
    {
      method: "GET",
      pattern: "/api/env/global",
      handler: (_req, res) => {
        sendJson(res, 200, toView(env.list(null)));
      },
    },
    {
      method: "PUT",
      pattern: "/api/env/global",
      handler: (req, res) => {
        const actor = req.actor as User;
        assertGlobalWritable(actor);
        const { bucket, key, value } = parseSetBody(req.body);
        env.set(null, bucket, key, value);
        log.info("API 写通用环境配置", {
          operator_id: actor.user_id,
          bucket,
          key,
        });
        sendNoContent(res);
      },
    },
    {
      method: "DELETE",
      pattern: "/api/env/global",
      handler: (req, res) => {
        const actor = req.actor as User;
        assertGlobalWritable(actor);
        const { bucket, key } = parseRemoveBody(req.body);
        env.remove(null, bucket, key);
        log.info("API 删通用环境配置", {
          operator_id: actor.user_id,
          bucket,
          key,
        });
        sendNoContent(res);
      },
    },
    {
      method: "GET",
      pattern: "/api/env/businesses/:id",
      handler: (req, res) => {
        const businessId = req.params.id;
        if (registry.getProfile(businessId) === undefined) {
          throw new ApiError("not_found", `业务不存在: ${businessId}`);
        }
        sendJson(res, 200, toView(env.list(businessId)));
      },
    },
    {
      method: "PUT",
      pattern: "/api/env/businesses/:id",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessWritable(actor, businessId);
        const { bucket, key, value } = parseSetBody(req.body);
        env.set(businessId, bucket, key, value);
        log.info("API 写业务环境配置", {
          operator_id: actor.user_id,
          business_id: businessId,
          bucket,
          key,
        });
        sendNoContent(res);
      },
    },
    {
      method: "DELETE",
      pattern: "/api/env/businesses/:id",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessWritable(actor, businessId);
        const { bucket, key } = parseRemoveBody(req.body);
        env.remove(businessId, bucket, key);
        log.info("API 删业务环境配置", {
          operator_id: actor.user_id,
          business_id: businessId,
          bucket,
          key,
        });
        sendNoContent(res);
      },
    },
  ];
}
