import { Spin } from "antd";
import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth/AuthContext";
import AppLayout from "./components/AppLayout";
import AssetsPage from "./pages/AssetsPage";
import BusinessesPage from "./pages/BusinessesPage";
import BusinessEditPage from "./pages/BusinessEditPage";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import SettingsPage from "./pages/SettingsPage";
import UsersPage from "./pages/UsersPage";

/** 登录守卫：me 加载中显示加载态（不闪现登录页）；未登录弹回 /login */
function Guard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
        }}
      >
        <Spin size="large" tip="加载中…" />
      </div>
    );
  }
  if (user === null) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

/** 路由表：/login 公开；其余全部在守卫内。导航按使用频率序（监控 → 业务 → 资产 → 配置 → 用户） */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Guard>
            <AppLayout />
          </Guard>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="businesses" element={<BusinessesPage />} />
        <Route path="businesses/new" element={<BusinessEditPage />} />
        <Route path="businesses/:id" element={<BusinessEditPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
