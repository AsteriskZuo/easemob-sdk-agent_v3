import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssetRegistry } from "@easemob/agent-asset-registry";
import type { Database } from "@easemob/agent-database";
import type { ExitRegistry } from "@easemob/agent-exit-tools";
import { logger } from "@easemob/agent-logger";
import type { TaskQueue } from "@easemob/agent-queue";
import type { BusinessRegistry } from "@easemob/agent-registry";
import type { EnvProvider, LifecycleStore } from "@easemob/agent-runtime";
import { createAccountService } from "./accounts.js";
import type { User } from "./accounts.js";
import { ApiError, statusOf, toApiError } from "./errors.js";
import type { ApiErrorBody, EffectiveConfigView } from "./dto.js";
import { SESSION_COOKIE, parseCookies, readBody, sendJson } from "./http.js";
import type { HttpRequest } from "./http.js";
import { compileRoutes, matchRoute } from "./router.js";
import type { Route } from "./router.js";
import { serveStatic } from "./static.js";
import { assetRoutes } from "./routes-assets.js";
import { authRoutes } from "./routes-auth.js";
import { businessRoutes } from "./routes-businesses.js";
import { configRoutes } from "./routes-config.js";
import { envRoutes } from "./routes-env.js";
import { monitoringRoutes } from "./routes-monitoring.js";
import { userRoutes } from "./routes-users.js";

/** console-api 对外唯一工厂。deps 全部来自装配层（app/server bootstrap） */
export interface ConsoleApiDeps {
  /** 平台唯一数据口（users/console_sessions 表建在同一个 platform.db） */
  db: Database;
  /** 业务注册表（业务 CRUD + 匹配行 + 出口绑定） */
  registry: BusinessRegistry;
  /** 资产注册表（登记/列表/详情/下架） */
  assets: AssetRegistry;
  /** 两桶环境配置（通用层/业务层读写 + 私有资产凭据解析） */
  env: EnvProvider;
  /** 出口工具菜单（GET /api/exit-tools） */
  exits: ExitRegistry;
  /** 入口队列（监控只读） */
  entryQueue: TaskQueue;
  /** 出口队列（监控只读） */
  exitQueue: TaskQueue;
  /** 运行记录读口（/api/businesses/:id/runs、/api/runs/:id） */
  lifecycle: LifecycleStore;
  /** GET /api/config 回显源（ServerConfig 的非敏感子集，装配层负责映射） */
  config: EffectiveConfigView;
}

export interface ConsoleApiOptions {
  /** 监听端口（0 = 随机，测试用） */
  port: number;
  /** 首启 admin 注入（users 表为空时生效；缺省不建号，记 error 日志不阻断启动） */
  bootstrap_admin?: { username: string; password: string };
  /** 控制台静态资源目录（vite build 产物的绝对路径）；
   *  设置后：非 /api 请求按文件托管（GET/HEAD），未命中回退 index.html（SPA 路由）；
   *  不设置 = 纯 API 服务（开发期形态） */
  static_dir?: string;
}

export interface ConsoleApi {
  /** 建表 → ensureBootstrapAdmin → 起 HTTP 监听；返回实际端口（port=0 时有用） */
  start(): Promise<number>;
  /** 关监听（幂等）；不 close db（db 归装配层管） */
  stop(): Promise<void>;
}

/** 创建管理 API 服务（未启动；start 起监听）。本包不读 process.env */
export function createConsoleApi(
  deps: ConsoleApiDeps,
  options: ConsoleApiOptions,
): ConsoleApi {
  const accounts = createAccountService(deps.db);
  const log = logger.for({ module: "console-api" });

  const routes: Route[] = [
    ...authRoutes({ accounts }),
    ...userRoutes({ accounts }),
    ...businessRoutes({ registry: deps.registry }),
    ...assetRoutes({ assets: deps.assets, env: deps.env }),
    ...envRoutes({ env: deps.env, registry: deps.registry }),
    ...configRoutes({ config: deps.config, exits: deps.exits }),
    ...monitoringRoutes({
      entryQueue: deps.entryQueue,
      exitQueue: deps.exitQueue,
      lifecycle: deps.lifecycle,
    }),
  ];
  const compiled = compileRoutes(routes);

  function respondError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    const apiError = toApiError(err);
    if (apiError.code === "internal" && !(err instanceof ApiError)) {
      // 未捕获异常：细节只进日志，响应统一「内部错误」
      log.error("请求处理未捕获异常", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const body: ApiErrorBody = {
      error: { code: apiError.code, message: apiError.message },
    };
    sendJson(res, statusOf(apiError.code), body);
  }

  async function handle(
    rawReq: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const method = rawReq.method ?? "GET";
      const url = new URL(rawReq.url ?? "/", "http://localhost");
      const matched = matchRoute(compiled, method, url.pathname);
      if (matched === undefined) {
        rawReq.resume(); // drain 请求体，避免 keep-alive 悬挂
        // 静态托管分支（/api 前缀永远优先，已在 serveStatic 内判定）
        if (
          options.static_dir !== undefined &&
          serveStatic(res, options.static_dir, url.pathname, method)
        ) {
          return;
        }
        throw new ApiError(
          "not_found",
          `路由不存在: ${method} ${url.pathname}`,
        );
      }
      const cookies = parseCookies(rawReq.headers.cookie);
      let actor: User | undefined;
      if (matched.route.public !== true) {
        // 认证拦截：除公开路由（POST /api/auth/login）外全部先过会话解析
        const token = cookies[SESSION_COOKIE];
        actor = token === undefined ? undefined : accounts.resolve(token);
        if (actor === undefined) {
          rawReq.resume();
          throw new ApiError("unauthenticated", "未登录或会话已失效");
        }
      }
      const body = await readBody(rawReq);
      const request: HttpRequest = {
        method,
        path: url.pathname,
        query: url.searchParams,
        params: matched.params,
        body,
        cookies,
        raw: rawReq,
        ...(actor !== undefined ? { actor } : {}),
      };
      await matched.route.handler(request, res);
    } catch (err) {
      respondError(res, err);
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  let listening = false;
  let stopPromise: Promise<void> | null = null;

  return {
    start(): Promise<number> {
      // 建表已在 createAccountService 构造内完成（migrate）；此处首启 admin → 起监听
      const bootstrapResult = accounts.ensureBootstrapAdmin(
        options.bootstrap_admin,
      );
      if (bootstrapResult === "missing") {
        // 不阻断启动（平台核心职责是跑业务循环，控制台可后续补建）
        log.error("无用户且未注入首启 admin，控制台无法登录");
      }
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, () => {
          listening = true;
          const address = server.address() as AddressInfo;
          log.info("管理 API 已启动", { port: address.port });
          resolve(address.port);
        });
      });
    },

    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopPromise = new Promise<void>((resolve) => {
        if (!listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // 立刻断开空闲 keep-alive 连接，不等其自然超时
        server.closeIdleConnections();
        listening = false;
      });
      return stopPromise;
    },
  };
}
