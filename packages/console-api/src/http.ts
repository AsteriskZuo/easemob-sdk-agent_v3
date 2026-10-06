import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.js";
import type { User } from "./accounts.js";

/** JSON 请求体上限：1MB（超限 413） */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** 会话 cookie 名 */
export const SESSION_COOKIE = "agent_console_token";

/** 会话 cookie 有效期：7 天（与 accounts 会话 TTL 一致，不滑动续期） */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** 归一化请求对象：handler 只面对它；params 由路由层填充、actor 由认证层填充 */
export interface HttpRequest {
  /** HTTP 方法（大写） */
  method: string;
  /** 路径（不含 query） */
  path: string;
  /** query 参数 */
  query: URLSearchParams;
  /** 路径参数（:param 单段匹配结果，已 decodeURIComponent） */
  params: Record<string, string>;
  /** JSON 请求体（已解析；无 body 时 undefined） */
  body: unknown;
  /** cookie 键值（值已 decodeURIComponent） */
  cookies: Record<string, string>;
  /** 认证拦截通过后的操作者；公开路由为 undefined */
  actor?: User;
  /** 原始请求（兜底用，handler 一般不需要） */
  raw: IncomingMessage;
}

/** 解析 Cookie 头为键值对（格式异常的段忽略） */
export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === "") continue;
    try {
      cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[key] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

/** 读取并解析 JSON 请求体：空 body → undefined；超 1MB → 413；非法 JSON → 400。
 *  超限后继续把剩余数据读完丢弃（ drain 连接，避免 keep-alive 悬挂） */
export function readBody(
  req: IncomingMessage,
  limit: number = BODY_LIMIT_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        return; // 继续读但丢弃（drain）
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(new ApiError("payload_too_large", "请求体超过 1MB 上限"));
        return;
      }
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError("invalid_input", "请求体不是合法 JSON"));
      }
    });
    req.on("error", () => {
      reject(new ApiError("internal", "内部错误"));
    });
  });
}

/** 成功 JSON 响应（统一 Content-Type；额外响应头如 Set-Cookie 经 headers 传入） */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** 204 无体响应（额外响应头如 Set-Cookie 经 headers 传入） */
export function sendNoContent(
  res: ServerResponse,
  headers: Record<string, string> = {},
): void {
  res.writeHead(204, headers);
  res.end();
}

/** 会话 cookie（HttpOnly + SameSite=Lax；不加 Secure——HTTPS 终结属部署层） */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/** 清除会话 cookie（登出用） */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

/** 入参校验小工具：非空字符串 */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError("invalid_input", `${field} 必须是非空字符串`);
  }
  return value;
}

/** 入参校验小工具：扁平 object */
export function requirePlainObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError("invalid_input", `${field} 必须是 JSON object`);
  }
  return value as Record<string, unknown>;
}

/** 入参校验小工具：布尔 */
export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError("invalid_input", `${field} 必须是布尔值`);
  }
  return value;
}

/** 入参校验小工具：字符串数组 */
export function requireStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new ApiError("invalid_input", `${field} 必须是字符串数组`);
  }
  return [...value];
}

/** 入参校验小工具：Record<string, string>（出口绑定 config 等） */
export function requireStringRecord(
  value: unknown,
  field: string,
): Record<string, string> {
  const obj = requirePlainObject(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (typeof item !== "string") {
      throw new ApiError("invalid_input", `${field}.${key} 必须是字符串`);
    }
    result[key] = item;
  }
  return result;
}
