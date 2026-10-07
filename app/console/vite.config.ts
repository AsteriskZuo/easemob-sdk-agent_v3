import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发期：/api 转发到本地平台管理 API（console-api，默认 6100 端口）；
// 生产期由 server 同进程托管 dist（console-api static_dir），天然同源，无需 CORS
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:6100",
    },
  },
});
