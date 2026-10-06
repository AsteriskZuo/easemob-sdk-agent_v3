import type { ServerResponse } from "node:http";
import type { HttpRequest } from "./http.js";

/** 路由 handler：同步或异步；响应经 sendJson/sendNoContent 发出，抛错由 server 统一翻译 */
export type Handler = (
  req: HttpRequest,
  res: ServerResponse,
) => void | Promise<void>;

/** 路由声明：pattern 形如 '/api/businesses/:id'，:param 单段匹配 */
export interface Route {
  /** HTTP 方法（大写） */
  method: string;
  /** 路径模板（'/api/businesses/:id'） */
  pattern: string;
  /** 公开路由（免认证）；缺省 false = 需登录 */
  public?: boolean;
  handler: Handler;
}

/** 编译后的路由（pattern 已转正则） */
interface CompiledRoute {
  route: Route;
  regex: RegExp;
  paramNames: string[];
}

/** 路径模板编译成正则：':param' 单段匹配 [^/]+，其余段字面转义 */
function compile(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const parts = route.pattern.split("/").map((segment) => {
    if (segment.startsWith(":")) {
      paramNames.push(segment.slice(1));
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return {
    route,
    regex: new RegExp(`^${parts.join("/")}$`),
    paramNames,
  };
}

/** 编译路由表（启动时一次） */
export function compileRoutes(routes: Route[]): CompiledRoute[] {
  return routes.map(compile);
}

/** 匹配路由：按声明顺序首个命中者胜；返回路由与路径参数，无匹配返回 undefined */
export function matchRoute(
  compiled: CompiledRoute[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | undefined {
  for (const item of compiled) {
    if (item.route.method !== method) continue;
    const match = item.regex.exec(path);
    if (match === null) continue;
    const params: Record<string, string> = {};
    item.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });
    return { route: item.route, params };
  }
  return undefined;
}
