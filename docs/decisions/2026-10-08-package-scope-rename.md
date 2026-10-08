# 决策：包名前缀改名 @easemob → @asterisk 并发布 sdk 到 npmjs

- **日期**：2026-10-08
- **状态**：已定
- **背景**：业务包需要引用 `@asterisk/agent-sdk`。评估过不发布 npm 的替代方案（git 依赖不支持 monorepo 子包；`file:` 引用不可移植；平台注入 sdk 属未实现的过渡设计），均不成立或代价更高。结论：sdk 作为普通 npm 依赖发布。

## 结论

1. **全部包改名**：`@asterisk/agent-*` → `@asterisk/agent-*`（15 个 packages + 模板 + 文档 + yarn.lock），sdk 新名 `@asterisk/agent-sdk`。
2. **sdk 发布到 npmjs**：`@asterisk/agent-sdk`，`--access public`。发布动作由仓库所有者执行（npm 登录态不在项目内）。
3. **改名自由**：`@asterisk` 是个人可控 scope，将来有需要可整体改回 `@easemob`，不受第三方占用约束。
4. **废弃「运行时注入 sdk」设计**：sdk 发布后是普通 npm 依赖，经 `npm ci` 进入业务资产缓存的 node_modules，node 常规解析。设计文档中「上传转译时 esbuild bundle 注入 run 环境」「运行时注入解析路径」等过渡表述在 T21 中回写清除。

## 理由

- 业务包可独立运行、可有三方依赖是既定原则；sdk 只有成为普通 npm 依赖，业务的依赖管理才与其他三方包完全同构，无特殊机制。
- 平台零注入 = 平台更机械：不需要 bundle 别名、NODE_PATH（ESM 不支持）或 loader 钩子。
- 先发布后改名代价大（已发布的包名撤不回），改名必须在首次发布前完成。
