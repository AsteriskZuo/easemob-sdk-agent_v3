import { sdk } from "../../../sdk/dist/index.js";

// 成功：回显入口信封 + cwd（断言 spawn cwd = 注入的 workspace）
const { event, workspace } = sdk.input();
sdk.return({ event, cwd: process.cwd(), workspace });
