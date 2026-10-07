// 基于根 jest.compiled.config.mjs 的编译态约定（跑 dist-test 产物），两点差异：
// 1. testEnvironment = jsdom（antd 组件真实渲染需要 DOM）；
// 2. setupFiles 指向编译产物里的 setup.js（jsdom 补丁：matchMedia/ResizeObserver）。
// 配合 package.json test 脚本的 esbuild --bundle：antd 是 CJS 包，node ESM 直接
// named import 不稳，bundle 后 antd 内联进测试产物以规避解析问题
// （这是与 node 包 test 脚本的唯一差异）。
export default {
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/dist-test/tests/**/*.test.js"],
  setupFiles: ["<rootDir>/dist-test/tests/setup.js"],
  clearMocks: true,
  watchman: false,
  // antd 全量在 jsdom 下渲染较慢（cssinjs + 大 DOM，单个大表单交互可达数十秒）
  testTimeout: 120000,
};
