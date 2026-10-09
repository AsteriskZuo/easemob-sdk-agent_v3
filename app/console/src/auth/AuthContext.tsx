import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type {
  ChangePasswordBody,
  LoginResult,
  User,
} from "@asteriskzuo/agent-console-api";
import { apiFetch, setUnauthorizedHandler } from "../api/client";

/** 认证上下文：当前用户 + 加载态 + 登录/登出/改密码动作 */
export interface AuthState {
  /** 当前登录用户；null = 未登录（含 401 被清态后） */
  user: User | null;
  /** 启动期 me 加载中（守卫据此显示加载态，不闪现登录页） */
  loading: boolean;
  /** 登录（失败抛 ApiError，页面统一提示「用户名或密码错误」） */
  login(username: string, password: string): Promise<void>;
  /** 登出（服务端失败也清本地态） */
  logout(): Promise<void>;
  /** 本人改密码（成功后服务端使其它会话失效） */
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** 认证提供者：启动时 GET /api/auth/me 恢复会话；向 api client 注入 401 清态回调 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    apiFetch<User>("/api/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiFetch<LoginResult>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch<void>("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
    }
  }, []);

  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string) => {
      const body: ChangePasswordBody = {
        old_password: oldPassword,
        new_password: newPassword,
      };
      await apiFetch<void>("/api/auth/change-password", {
        method: "POST",
        body,
      });
    },
    [],
  );

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout, changePassword }),
    [user, loading, login, logout, changePassword],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 读取认证上下文（必须在 AuthProvider 内） */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth 必须在 AuthProvider 内使用");
  }
  return ctx;
}
