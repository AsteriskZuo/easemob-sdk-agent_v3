import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import type { ApiErrorBody } from "./dto.js";
import { sendJson } from "./http.js";

/** 静态资源 MIME 小表（缺省 application/octet-stream） */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** vite 产物文件名形如 index-B7k2mP9x.js（basename 含 '-' hash 段）→ 内容寻址可长缓存 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;

/** 静态分支 404：与 API 同一错误体格式 */
function sendStaticNotFound(res: ServerResponse, message: string): void {
  const body: ApiErrorBody = { error: { code: "not_found", message } };
  sendJson(res, 404, body);
}

/** 尝试以静态文件响应非 /api 请求（控制台 SPA 托管，仅 GET/HEAD）。
 *  返回 true = 请求已被本分支终结（命中文件 / SPA 回退 index.html / 404 错误体）；
 *  返回 false = 不属于静态分支（/api 前缀或非 GET/HEAD），调用方走既有路由 404。
 *  规则：
 *  - /api 前缀永远优先（本分支不接管）；
 *  - URL 解码后 path.resolve，结果必须落在 static_dir 内，否则 404（路径穿越防护）；
 *  - 未命中（含目录请求）回退 index.html（SPA 路由）；index.html 不存在 → 404 错误体；
 *  - 缓存：index.html 一律 no-cache；带 hash 段的产物 immutable；其余 no-cache 从简 */
export function serveStatic(
  res: ServerResponse,
  staticDir: string,
  pathname: string,
  method: string,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;

  const root = resolve(staticDir);
  const indexPath = join(root, "index.html");

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendStaticNotFound(res, "路径非法");
    return true;
  }
  if (decoded.includes("\0")) {
    sendStaticNotFound(res, "路径非法");
    return true;
  }
  // 以根为基准解析（'.' + 绝对路径 = 相对根拼接）；逃逸根目录即路径穿越 → 404
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) {
    sendStaticNotFound(res, "静态资源不存在");
    return true;
  }

  let file: string | undefined;
  if (existsSync(target) && statSync(target).isFile()) {
    file = target;
  } else if (existsSync(indexPath) && statSync(indexPath).isFile()) {
    // SPA 回退：未命中任何文件（含目录请求）一律回 index.html
    file = indexPath;
  }
  if (file === undefined) {
    sendStaticNotFound(res, "静态资源不存在");
    return true;
  }

  const content = readFileSync(file);
  const contentType =
    MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const cacheControl =
    file !== indexPath && HASHED_NAME.test(basename(file))
      ? "max-age=31536000, immutable"
      : "no-cache";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(content.length),
    "Cache-Control": cacheControl,
  });
  // HEAD：只回响应头不回体
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(content);
  }
  return true;
}
