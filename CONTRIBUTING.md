# 贡献指南

## 开发环境

- Node.js ≥ 24、Yarn 4.14.1（corepack 启用）、git；
- 克隆后 `yarn install && yarn build`；
- 运行平台另需 pi CLI（见 README「快速开始」）。

## 提交前必跑（根目录六连）

```bash
yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular
```

全绿才允许提交。`yarn circular`（dpdm）对 exit-tools 的 node_modules skip warning 是既有噪音，exit code 0 即通过。

## 开发流程

1. **spec 先行**：任何模块级改动先在 `docs/specs/` 写任务规格（自包含：目标/背景含上游真实签名/不做清单/包结构/详规/测试清单/验收/决策点），评审通过再实现。规格体例参照既有 spec；
2. **单任务单提交**：一个任务完成且六连全绿后一次提交，提交即恢复检查点；计划与进度状态随 docs 提交同步更新；
3. **进度追踪**：`docs/plans/2026-09-28-platform-implementation-progress.md` 记录任务级事实（状态/验收证据/commit/裁决），不记流水账。

## 硬性工程规则

- **依赖方向单向**：`contracts ← database ← queue/registry/channel；… ← scheduler/exit-tools ← runtime ← console-api ← app/server`；包不得依赖 app。dpdm 强制检查；
- **依赖管理四类归宿**（细则见 `docs/designs/2026-09-14-skill-platform-spec-v3/design/dependency-rules.md`）：环境变量只能经 `@easemob/agent-env` 读；日志经 `@easemob/agent-logger` 全局外观；上下文注入要克制；纯函数归 contracts；
- **重大变更先确认**（AGENTS.md 核心原则 9）：触碰包间契约/公开接口/数据结构/目录/技术路线，先提出并获确认再动手；
- **零第三方运行时依赖**：平台包（packages/*）原则上只用 node 内置模块；app/console 是浏览器应用，依赖政策单独放宽（React/antd 等）；
- **active 设计文档同步**：改动若使 `docs/designs/` 中的设计过时，同批更新设计文档；一个内容只在一个地方说清楚，其他地方引用。

## 代码约定

- TypeScript ^5.9，ESM + NodeNext（console 为 bundler 解析例外）；
- 注释用中文；接口与公开函数的每个成员写中文注释（说明「是什么/何时用/边界」），不写复述代码的废话注释；
- 格式化全部交给 prettier，不手调格式；
- 新包命名 `@easemob/agent-*`，结构与脚本对齐既有包（参考 `packages/queue/`）。

## 测试约定

- jest 29 + esbuild：先编译 `src`/`tests` 到 `dist-test` 再跑 jest（各包 test 脚本即模板）；console 用 jsdom + testing-library（esbuild `--bundle`）；
- 测试需要 git fixture 时：`git -c user.email=test@test -c user.name=test commit ...`；
- 测试不依赖网络与真实凭据；资产/git 相关用例用本地临时仓库；
- 密钥、token、密码 hash 永不进日志与测试断言。

## 文档约定

- `docs/` 目录分工见 `docs/README.md`：drafts（探索）→ research（调研）→ decisions（决策）→ designs（设计）→ specs（规格）→ plans（计划）；
- spec/plan/进度文档一律中文；
- 新文档放对目录，不新建顶层文档目录。
