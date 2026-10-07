import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html 缺少 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      {/* AntdApp 提供 message/modal 上下文（避免 antd v5 静态函数警告） */}
      <AntdApp>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
);
