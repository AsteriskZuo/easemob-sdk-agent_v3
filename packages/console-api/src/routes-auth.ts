import { ApiError } from "./errors.js";
import type { AccountService, User } from "./accounts.js";
import type { ChangePasswordBody, LoginBody, LoginResult } from "./dto.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  requireNonEmptyString,
  requirePlainObject,
  sendJson,
  sendNoContent,
  sessionCookie,
} from "./http.js";
import type { Route } from "./router.js";

/** 认证路由：登录（唯一公开路由）/登出/me/改密码 */
export function authRoutes(deps: { accounts: AccountService }): Route[] {
  const { accounts } = deps;
  return [
    {
      method: "POST",
      pattern: "/api/auth/login",
      public: true,
      handler: (req, res) => {
        const body =
          req.body === undefined ? {} : requirePlainObject(req.body, "body");
        const loginBody = body as Partial<LoginBody>;
        const username = requireNonEmptyString(loginBody.username, "username");
        const password = requireNonEmptyString(loginBody.password, "password");
        const session = accounts.login(username, password);
        if (session === null) {
          // 统一口径，不区分用户不存在/密码错/已停用（防枚举）
          throw new ApiError("unauthenticated", "用户名或密码错误");
        }
        const user = accounts.resolve(session.token) as User;
        const result: LoginResult = { user, expires_at: session.expires_at };
        sendJson(res, 201, result, {
          "Set-Cookie": sessionCookie(session.token),
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/logout",
      handler: (req, res) => {
        const token = req.cookies[SESSION_COOKIE];
        if (token !== undefined) {
          accounts.logout(token);
        }
        sendNoContent(res, { "Set-Cookie": clearSessionCookie() });
      },
    },
    {
      method: "GET",
      pattern: "/api/auth/me",
      handler: (req, res) => {
        sendJson(res, 200, req.actor as User);
      },
    },
    {
      method: "POST",
      pattern: "/api/auth/change-password",
      handler: (req, res) => {
        const body =
          req.body === undefined ? {} : requirePlainObject(req.body, "body");
        const changeBody = body as Partial<ChangePasswordBody>;
        const oldPassword = requireNonEmptyString(
          changeBody.old_password,
          "old_password",
        );
        const newPassword = requireNonEmptyString(
          changeBody.new_password,
          "new_password",
        );
        accounts.changePassword(req.actor as User, oldPassword, newPassword);
        sendNoContent(res);
      },
    },
  ];
}
