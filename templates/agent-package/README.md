# my-package（包模板）

## 1. 这是什么

**包（package）模板**——平台资产三族之一「包」的工程骨架（业务代码单位：流程程序入口 + 胶水代码），拷贝即用。资产模型的完整定义见平台设计文档 `design/asset-model.md`。

- **子程序**：可执行入口，在 `agent-package.json` 的 `programs` 里登记；值 = 转译后的 JS 相对包根路径。平台物化时机械校验每条路径真实存在。
- **requires**：名字级依赖声明（不钉版本）——本包代码 `sdk.run` 引用的外部工具名、`sdk.agent` 引用的 skill 名。控制台在业务绑定配置期机械校验这些名字都被绑定覆盖，缺绑 = 配置期报错。
- **skill 不在包内**：skill 是独立资产（一个仓库或子路径 = 一个 skill 集合，每个含 SKILL.md 的直接子目录是一个 skill）。想单仓开发：同一仓库注册两次（根 = 包、`skills/` 子路径 = skill 集合）。工具同理——独立 git 仓库登记的工具资产。
- 模板内置与平台同构同版本的完整工具链（build/typecheck/lint/format/circular/test），作者只写 `src/` 业务代码，本地跑绿的检查就是平台要求的全套检查。

## 2. 快速开始

1. 拷贝本目录到你的仓库；
2. 改 `agent-package.json` 与 `package.json` 的 `name`；
3. 安装依赖：`npm install`（yarn/pnpm 亦可，模板不锁定包管理器）。`@asterisk/agent-sdk` 是普通 npm 依赖，默认引用 npm 正式版 `^0.1.0`；仅离线开发兜底时改为 `file:<平台仓>/packages/sdk`（平台仓 `scripts/verify-template.sh` 的模板验收脚本就是这样改写的）；
4. 写 `src/` 业务代码（新增子程序 = 在 `programs` 加条目；引用外部工具/skill = 在 `requires` 加名字）；
5. 六条检查全绿：`npm run build` / `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run circular`；
6. 推送 git → 控制台登记为包资产 → 创建业务时绑定（同时绑定 requires 声明的工具与 skill）。

## 3. 运行时说明

> 本节只列与本模板直接相关的运行时要点。**业务开发的完整知识**（SDK 全 API、config/secrets 规则、出入口事件/结果对照、run 生命周期、本地调试、FAQ）见 SDK 主文档 `packages/sdk/README.md`（随 `@asterisk/agent-sdk` 发布）——两处不一致时以 SDK README 为准。

- **sdk 是普通 npm 依赖**：`@asterisk/agent-sdk` 从 npm 安装进包内 node_modules，开发与运行时用同一份代码；平台不做任何注入/bundle。
- **一入一出契约四条**：
  1. stdin 一段 JSON 进（信封 + 平台注入上下文，含 config/secrets/endpoint）；
  2. stdout 一段 JSON 出（`sdk.return` / `sdk.fail`，只认第一次）；
  3. 失败语义机械（任何一步失败 = 整体失败，不重跑）；
  4. 日志走 `sdk.log`（stderr，平台采集、secrets 源头脱敏）。
- **skills 注入**：`sdk.agent({ skills: [...] })` 按名引用（可多个、可跨 skill 集合），名字必须在业务绑定的 skill 集合内——平台白名单校验后逐个 `--skill` 注入；没有运行时注册接口。
- **工具调用**：`sdk.run('jira-fetch', {...})` 按名调用本包或业务绑定工具资产的子程序，同一入一出契约（契约递归同构）。
- **业务不做投递**：结果由平台扇出（下游关注 + 出口绑定投递）。

## 4. 初始化脚本（agent.materialize.mjs，必带）

平台物化（git clone 资产仓库到缓存）的固定流程：clone → 清单形状校验 → `npm ci`（资产根含 package.json 时，要求同时含 package-lock.json）→ **执行 `node agent.materialize.mjs`**（cwd = 资产根，env 仅 PATH/HOME/NPM_CONFIG_REGISTRY，超时 10 分钟）→ 产物校验（`agent-package.json` 的 `programs` 每条路径必须真实存在，缺一即物化失败）。

- **必带**：package/tool 资产根缺这个文件 = 物化失败；skill 资产（纯文档）不需要。
- **职责**：完成本仓库的一切初始化——转译、其他语言产物的构建/安装、codegen、资源下载等。平台不传参、不理解过程，只验收产物。
- **默认实现**（本模板自带）：esbuild 转译 `src/**/*.{ts,js}` → `dist/`（ESM / node24 / sourcemap，逐文件不 bundle、保持目录结构），与 `npm run build`（tsc）同产物布局；简单项目原样可用。
- **何时自定义**：构建步骤超出「esbuild 转译 src/」（如需 codegen、拉取外部资源、构建非 JS 产物）时改写本脚本；注意脚本运行环境只有 node 24 + npm + git（python/rust/go 等谁用谁装，平台不提供）。
- **本地调试链路不变**：`npm run build`（tsc → dist/）供本地六条检查；平台物化走初始化脚本产出同一 dist/，两路同源同代码。

## 5. 包内程序 vs 共享工具

- **包内程序**（本仓库 `programs` 声明的）：同仓库路径可知，**可直接 import 进程内调用**（首选，零进程开销），也可 `sdk.run('名')` 走子进程隔离（需要隔离/限时时用）——包自由掌握。
- **共享工具**（控制台绑定的工具资产）：**只能 `sdk.run('名')` 按名调用**——跨仓库，物理路径由平台注入（stdin 信封 `programs` 映射），SDK 按名查表；业务代码永远不写路径。
- **名唯一性**：绑定时平台查重，重复拒绝；包清单 `requires` 声明的外部引用名必须在绑定中覆盖。

## 6. 目录说明

- `agent-package.json`：包清单——name/version + programs（子程序入口映射，值 = 物化后产物的相对路径）+ requires（名字级依赖声明），平台机械校验。
- `agent.materialize.mjs`：初始化脚本（必带，见 §4）——平台物化时执行，默认 esbuild 转译 src/ → dist/。
- `package.json`：工程定义——devDeps 与平台同构同版本，六条检查脚本。
- `tsconfig.json`：独立 TS 配置（不 extends 平台 base，拷贝后自成工程）。
- `jest.config.mjs`：jest 配置——跑 esbuild 转译后的 `dist-test/tests/**/*.test.js`。
- `eslint.config.js`：独立 eslint 配置——规则与平台同构，files 指向本包。
- `.prettierignore` / `.gitignore`：忽略 node_modules/dist/dist-test/coverage。
- `src/programs/main.ts`：流程程序骨架（单轮审查工单形态），注释承载约束四条。
- `tests/main.test.ts`：e2e 失败路径两则，验证一入一出契约。
