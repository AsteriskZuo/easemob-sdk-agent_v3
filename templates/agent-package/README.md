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
3. 安装依赖：平台未发布 npm 前，把 `package.json` 里的 `@easemob/agent-sdk` 依赖改为 `file:<平台仓>/packages/sdk`，然后 `npm install`（yarn/pnpm 亦可，模板不锁定包管理器）；
4. 写 `src/` 业务代码（新增子程序 = 在 `programs` 加条目；引用外部工具/skill = 在 `requires` 加名字）；
5. 六条检查全绿：`npm run build` / `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run circular`；
6. 推送 git → 控制台登记为包资产 → 创建业务时绑定（同时绑定 requires 声明的工具与 skill）。

## 3. 运行时说明

- **sdk 注入**：运行时平台把 `@easemob/agent-sdk`（esbuild bundle）注入解析路径，业务零安装；包内 node_modules 的 sdk 只服务开发期类型与测试。
- **一入一出契约四条**：
  1. stdin 一段 JSON 进（信封 + 平台注入上下文，含 config/secrets/endpoint）；
  2. stdout 一段 JSON 出（`sdk.return` / `sdk.fail`，只认第一次）；
  3. 失败语义机械（任何一步失败 = 整体失败，不重跑）；
  4. 日志走 `sdk.log`（stderr，平台采集、secrets 源头脱敏）。
- **skills 注入**：`sdk.agent({ skills: [...] })` 按名引用（可多个、可跨 skill 集合），名字必须在业务绑定的 skill 集合内——平台白名单校验后逐个 `--skill` 注入；没有运行时注册接口。
- **工具调用**：`sdk.run('jira-fetch', {...})` 按名调用本包或业务绑定工具资产的子程序，同一入一出契约（契约递归同构）。
- **业务不做投递**：结果由平台扇出（下游关注 + 出口绑定投递）。

## 4. 目录说明

- `agent-package.json`：包清单——name/version + programs（子程序入口映射）+ requires（名字级依赖声明），平台机械校验。
- `package.json`：工程定义——devDeps 与平台同构同版本，六条检查脚本。
- `tsconfig.json`：独立 TS 配置（不 extends 平台 base，拷贝后自成工程）。
- `jest.config.mjs`：jest 配置——跑 esbuild 转译后的 `dist-test/tests/**/*.test.js`。
- `eslint.config.js`：独立 eslint 配置——规则与平台同构，files 指向本包。
- `.prettierignore` / `.gitignore`：忽略 node_modules/dist/dist-test/coverage。
- `src/programs/main.ts`：流程程序骨架（单轮审查工单形态），注释承载约束四条。
- `tests/main.test.ts`：e2e 失败路径两则，验证一入一出契约。
