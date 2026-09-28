# T0 工程骨架 spec

> 实现任务规格。本文是本任务的唯一执行依据，**执行者只需阅读本文**；任务边界与依赖关系见总实现计划（docs/plans/，待 spec 审过后编写）。
> 背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/`（骨架文档 §4 技术选型）。

## 1. 目标

建立 monorepo 工程骨架：包管理、TypeScript、测试、lint、格式化、循环依赖检查、构建，全部可一键运行。本任务**只搭骨架，不写任何平台业务代码**。

## 2. 技术选型（已定，不可偏离）

| 项 | 选择 | 说明 |
|----|------|------|
| Node | >= 24（`engines` 声明） | 开发机已 v24.13.0 |
| 包管理 | yarn **4.14.1**（berry） | `packageManager: "yarn@4.14.1"`；release 固化到 `.yarn/releases/`，`.yarnrc.yml` 用 `nodeLinker: node-modules`（参考 v2）。**安装技巧**：先 `yarn set version 3.6.1` 再 `yarn set version 4.14.1`——从 classic 1.x 直接 `set version 4.x` 通常不会自动下载 |
| TypeScript | ^5.x（禁止 6.x） | ESM：`"type": "module"`，module/moduleResolution = NodeNext |
| 测试 | jest 29.x + esbuild | **只保留编译态**：esbuild 编译 src+tests 到 `dist-test/`，jest 跑编译产物；不开 ts-jest |
| 循环依赖 | dpdm ^4 | |
| 格式化 | prettier ^3 | 配置用默认值，只提供 `.prettierignore` |
| lint | eslint ^10 + typescript-eslint ^8（flat config） | 参考 v2 `eslint.config.js` |
| 包名 | `@easemob/agent-*` scope | npm 规则 scope 只能一层 |

## 3. 目录结构（本任务产出）

```text
├── package.json              # 根：private、workspaces、聚合脚本
├── .yarnrc.yml               # yarnPath + nodeLinker
├── .yarn/releases/yarn-4.14.1.cjs
├── .gitignore
├── .prettierignore
├── .editorconfig
├── eslint.config.js          # flat config，作用于 packages/app/sdk
├── tsconfig.base.json        # 共享编译选项
├── jest.compiled.config.mjs  # 共享 jest 配置（跑 dist-test 产物）
├── packages/
│   └── contracts/            # 模板包：验证工具链的最小骨架，实现归 T1
│       ├── package.json      # @easemob/agent-contracts，含包级脚本模板
│       ├── tsconfig.json     # extends ../../tsconfig.base.json
│       ├── src/index.ts      # 空导出占位
│       └── tests/smoke.test.ts
├── app/                      # 空目录占位（server 归 T10，console 归 T12）
├── sdk/                      # 空目录占位（业务 SDK 归 T8）
└── businesses/               # 运行时数据目录占位，gitignore
```

## 4. 工程约定（后续所有任务必须遵守，本文是唯一定义处）

1. **workspaces 范围**：`packages/*`、`app/*`、`sdk`（sdk 本身是单包目录）。
2. **包内结构**：每包 `src/ + tests/`，入口 `src/index.ts`，`exports` 指向 `./dist/index.js`（types 指向 `./dist/index.d.ts`）。**包间引用走构建产物**（yarn workspaces 软链 + exports 解析），不允许跨包引用 `src`。
3. **ESM 规则**：源码中相对导入一律带 `.js` 后缀（NodeNext 要求）。
4. **devDependencies 集中根目录**（typescript/jest/esbuild/eslint/prettier/dpdm/@types）；包内只声明自己的运行时 `dependencies`。
5. **包级脚本模板**（每包一致）：
   - `build`：`tsc -p tsconfig.json`（产物到 `dist/`）
   - `test`：esbuild 编译 `src`+`tests` 到 `dist-test/`（--format=esm --platform=node --target=node24 --sourcemap，保持目录结构）→ `NODE_OPTIONS='--experimental-vm-modules' jest --config <根>/jest.compiled.config.mjs --rootDir .`
   - `typecheck`：`tsc --noEmit`
6. **根聚合脚本**：`build` / `test` / `typecheck` 用 `yarn workspaces foreach`（build 需拓扑序 `-p`）；`lint` = eslint 全仓；`format` / `format:check` = prettier；`circular` = dpdm 检查全部包的 `src/**/*.ts`。
7. **测试前依赖构建**：jest 跑的是编译产物、包间引用解析到 dist，因此根 `test` 脚本必须先 `build` 再逐包 `test`。
8. **.gitignore** 至少含：`node_modules`、`dist`、`dist-test`、`coverage`、`logs/`、`businesses/`、`.easemob-agent/`、`.DS_Store`、`.yarn/*` 中除 releases 外的缓存（参考 v2 的 yarn gitignore 惯例）。

## 5. 不做清单

- 不写任何平台业务代码（contracts 包只放空壳 + 一个 smoke 测试验证工具链）。
- 不做 CI 平台配置（GitHub Actions 等）、不做 Dockerfile、不做 .nvmrc。
- `app/console` 不创建实质内容（T12 再建）。
- 不引入 zod 等校验库、不引入 ts-jest、不配置 PnP。

## 6. 测试与验收

**测试清单**

- `packages/contracts/tests/smoke.test.ts`：一个 trivial 断言（验证 esbuild→jest 编译态链路通）。

**验收标准**（全部在根目录执行通过）

1. `yarn install` 成功，生成 yarn.lock；
2. `yarn build` 全部包编译出 dist；
3. `yarn test` 编译态跑通 smoke 测试；
4. `yarn typecheck`、`yarn lint`、`yarn format:check`、`yarn circular` 全部通过；
5. 构建产物可被 import：根目录执行 `node --input-type=module -e "await import('@easemob/agent-contracts')"` 成功（验证 workspaces 软链 + exports 链路）。
