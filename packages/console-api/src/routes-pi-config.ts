/** 业务 Pi 配置管理路由（脱敏读取 / 在线验证 / 确认保存 / 删除）。
 *  权限与业务 env 写一致：业务 creator 本人或 admin；其他登录用户不可读也不可发起。
 *  验证与确认是两个动作：未通过真实探针验证不得保存；确认经统一更新队列生效 */
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type { User } from "./accounts.js";
import { ApiError } from "./errors.js";
import { requireNonEmptyString, requirePlainObject, sendJson } from "./http.js";
import type { Route } from "./router.js";
import type { UpdateSubmission } from "./updates.js";

/** 管理读面视图：config 为递归脱敏对象（绝不含明文敏感字段），未配置时省略 */
export interface BusinessPiConfigView {
  configured: boolean;
  model: string;
  config?: Record<string, unknown>;
}

export interface PiValidateResult {
  validation_id: string;
  duration_ms: number;
}

/** 业务 Pi 配置服务窄接口（app/server 注入）；console-api 不认识探针与队列细节 */
export interface BusinessPiConfigService {
  getConfig(business_id: string): BusinessPiConfigView;
  validate(
    business_id: string,
    operator_id: string,
    model: string,
    config: Record<string, unknown>,
  ): Promise<PiValidateResult>;
  confirm(
    business_id: string,
    operator_id: string,
    validation_id: string,
  ): Promise<UpdateSubmission<unknown>>;
  remove(
    business_id: string,
    operator_id: string,
    model: string,
  ): Promise<UpdateSubmission<unknown>>;
}

export function piConfigRoutes(deps: {
  registry: BusinessRegistry;
  piConfig: BusinessPiConfigService;
}): Route[] {
  const { registry, piConfig } = deps;

  /** 业务 Pi 配置读写权限：业务存在（404）+ creator 本人或 admin（403） */
  function assertBusinessPiAccess(actor: User, businessId: string): void {
    const profile = registry.getProfile(businessId);
    if (profile === undefined) {
      throw new ApiError("not_found", `业务不存在: ${businessId}`);
    }
    if (actor.role !== "admin" && profile.creator_id !== actor.user_id) {
      throw new ApiError("forbidden", "仅业务创建者或 admin 可操作 Pi 配置");
    }
  }

  /** confirm/remove 的统一响应：已应用 200；已接受 202，body 均为 { accepted: true } */
  function respondAccepted(
    res: Parameters<typeof sendJson>[0],
    submission: UpdateSubmission<unknown>,
  ): void {
    sendJson(res, submission.outcome === "applied" ? 200 : 202, {
      accepted: true,
    });
  }

  return [
    {
      method: "GET",
      pattern: "/api/businesses/:id/pi-config",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessPiAccess(actor, businessId);
        sendJson(res, 200, piConfig.getConfig(businessId));
      },
    },
    {
      method: "POST",
      pattern: "/api/businesses/:id/pi-config/validate",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessPiAccess(actor, businessId);
        const body = requirePlainObject(req.body, "body");
        const model = requireNonEmptyString(body.model, "model");
        const config = requirePlainObject(body.config, "config");
        // 验证失败 → ApiError invalid_input（400，可修正错误，已脱敏）
        const result = await piConfig.validate(
          businessId,
          actor.user_id,
          model,
          config,
        );
        sendJson(res, 200, result);
      },
    },
    {
      method: "POST",
      pattern: "/api/businesses/:id/pi-config/confirm",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessPiAccess(actor, businessId);
        const body = requirePlainObject(req.body, "body");
        const validationId = requireNonEmptyString(
          body.validation_id,
          "validation_id",
        );
        const submission = await piConfig.confirm(
          businessId,
          actor.user_id,
          validationId,
        );
        respondAccepted(res, submission);
      },
    },
    {
      method: "DELETE",
      pattern: "/api/businesses/:id/pi-config",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessPiAccess(actor, businessId);
        const body = requirePlainObject(req.body, "body");
        const model = requireNonEmptyString(body.model, "model");
        const submission = await piConfig.remove(
          businessId,
          actor.user_id,
          model,
        );
        respondAccepted(res, submission);
      },
    },
  ];
}
