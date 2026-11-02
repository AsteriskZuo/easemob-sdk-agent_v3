/** 业务 Pi 配置管理路由（脱敏读取 / 异步在线验证（提交+轮询）/ 确认保存 / 删除）。
 *  权限与业务 env 写一致：业务 creator 本人或 admin；其他登录用户不可读也不可发起。
 *  验证与确认是两个动作：全部模型真实探针通过才允许确认；确认经统一更新队列生效。
 *  验证是异步的（spec 2026-11-01 §10）：POST validate 202 立即返回凭据，
 *  前端轮询 GET validate/{validation_id} 拿逐条进度——串行探针分钟级，
 *  同步等待会被平台 HTTP 超时（默认 30s）掐断 */
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type { User } from "./accounts.js";
import { ApiError } from "./errors.js";
import { requireNonEmptyString, requirePlainObject, sendJson } from "./http.js";
import type { Route } from "./router.js";
import type { UpdateSubmission } from "./updates.js";
import type { PiValidationStatus } from "./dto.js";

/** 管理读面视图：config 为递归脱敏对象（绝不含明文敏感字段），未配置时省略 */
export interface BusinessPiConfigView {
  configured: boolean;
  model: string;
  config?: Record<string, unknown>;
}

/** 业务 Pi 配置服务窄接口（app/server 注入）；console-api 不认识探针与队列细节 */
export interface BusinessPiConfigService {
  getConfig(business_id: string): BusinessPiConfigView;
  /** 同步结构/掩码校验 → 创建验证任务（后台串行探针）→ 立即返回凭据与总数 */
  validate(
    business_id: string,
    operator_id: string,
    config: Record<string, unknown>,
  ): { validation_id: string; total: number };
  /** 查询验证进度/结果；未知/过期/重启 → not_found */
  getValidation(business_id: string, validation_id: string): PiValidationStatus;
  confirm(
    business_id: string,
    operator_id: string,
    validation_id: string,
  ): Promise<UpdateSubmission<unknown>>;
  remove(
    business_id: string,
    operator_id: string,
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
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessPiAccess(actor, businessId);
        const body = requirePlainObject(req.body, "body");
        const config = requirePlainObject(body.config, "config");
        // 结构/掩码校验失败 → ApiError invalid_input（400，只含字段路径）；
        // 通过 → 202 立即返回（后台串行探针，进度走 GET validate/{id}）
        const result = piConfig.validate(businessId, actor.user_id, config);
        sendJson(res, 202, result);
      },
    },
    {
      method: "GET",
      pattern: "/api/businesses/:id/pi-config/validate/:validation_id",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertBusinessPiAccess(actor, businessId);
        const status = piConfig.getValidation(
          businessId,
          req.params.validation_id,
        );
        sendJson(res, 200, status);
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
        // 删除不再需要替代模型：生效后业务回到未配置状态（model=''）
        const submission = await piConfig.remove(businessId, actor.user_id);
        respondAccepted(res, submission);
      },
    },
  ];
}
