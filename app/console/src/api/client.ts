import type { ApiErrorBody } from "@easemob/agent-console-api";

/** API 错误：错误体解析产物（code/status 保留，UI 据 code 分流提示） */
export class ApiError extends Error {
  constructor(
    /** 错误码（invalid_input/unauthenticated/forbidden/not_found/conflict/...） */
    public readonly code: string,
    message: string,
    /** HTTP 状态码 */
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 401 兜底回调（AuthContext 注入：清用户态，路由守卫自然弹回登录页） */
let onUnauthorized: (() => void) | null = null;

/** 注入 401 回调；传 null 解除（AuthContext 卸载时） */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export interface ApiFetchOptions {
  /** HTTP 方法（缺省 GET） */
  method?: string;
  /** 请求体（对象自动 JSON 序列化 + content-type；DELETE 带 body 同此路径） */
  body?: unknown;
}

/** 同源 fetch 封装：JSON 编解码 + 统一错误体解析 + 401 回调。
 *  同源部署/代理下 cookie（agent_console_token）默认携带，无需显式凭证参数 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body,
  });
  if (res.status === 401) {
    // 先通知（清用户态）再抛出，调用方无需各自处理 401
    onUnauthorized?.();
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const errorBody = data as ApiErrorBody | null;
    if (
      errorBody !== null &&
      typeof errorBody === "object" &&
      typeof errorBody.error?.code === "string"
    ) {
      throw new ApiError(
        errorBody.error.code,
        errorBody.error.message,
        res.status,
      );
    }
    // 非标准错误体（如网关 500 HTML）→ 统一 internal
    throw new ApiError(
      "internal",
      `请求失败（HTTP ${res.status}）`,
      res.status,
    );
  }
  return data as T;
}
