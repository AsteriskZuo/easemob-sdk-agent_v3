/** API 错误码：统一错误体 { error: { code, message } } 的 code 取值域 */
export type ApiErrorCode =
  /** 入参缺失/类型错/校验不过（含下游 invalid_input） */
  | "invalid_input"
  /** 未登录/token 无效/过期/已停用 */
  | "unauthenticated"
  /** 已登录但无权（角色不符/非业务创建者/非资产属主） */
  | "forbidden"
  /** 资源不存在（业务/资产/用户/run/路由） */
  | "not_found"
  /** 唯一性冲突（username 重复等） */
  | "conflict"
  /** 请求体超上限（1MB） */
  | "payload_too_large"
  /** 未捕获异常（message 统一「内部错误」，不外泄细节） */
  | "internal";

/** 错误码 → HTTP 状态码 */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  internal: 500,
};

/** API 错误：handler 抛出，server 统一翻译成错误响应 */
export class ApiError extends Error {
  constructor(
    /** 错误码（决定 HTTP 状态与错误体 code） */
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 错误码对应的 HTTP 状态码 */
export function statusOf(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** 下游错误翻译：registry/asset-registry/env 等抛出的原生 Error 按 message 前缀归类；
 *  未识别的归 internal（message 统一「内部错误」，细节只进日志不进响应） */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.startsWith("invalid_input") ||
    message.startsWith("invalid_env_key")
  ) {
    return new ApiError("invalid_input", message);
  }
  if (message.startsWith("credential_required")) {
    return new ApiError("invalid_input", `凭据 key 未配置（${message}）`);
  }
  if (message.startsWith("asset_not_found")) {
    return new ApiError("not_found", message);
  }
  if (message.includes("业务不存在")) {
    return new ApiError("not_found", message);
  }
  return new ApiError("internal", "内部错误");
}
