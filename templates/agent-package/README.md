# my-package（程序包模板）

## 1. 这是什么

程序包模板——平台管理的**唯一资产单元**（子程序 + skill 的载体），拷贝即用。

- **子程序**：可执行入口，在 `agent-package.json` 的 `programs` 里登记；值 = 转译后的 JS 相对包根路径。平台登记时机械校验每条路径真实存在。
- **skill**：给大模型用的能力单元，在 `agent-package.json` 的 `skills` 里按目录登记；每条 = 包内 skill 目录，同样机械校验存在性。
- 模板内置与平台同构同版本的完整工具链（build/typecheck/lint/format/circular/test），作者只写 `src/` 业务代码与 `skills/` 能力单元，本地跑绿的检查就是平台要求的全套检查。

## 2. 快速开始

1. 拷贝本目录到你的仓库；
2. 改 `agent-package.json` 与 `package.json` 的 `name`；
3. 安装依赖：平台未发布 npm 前，把 `package.json` 里的 `@easemob/agent-sdk` 依赖改为 `file:<平台仓>/packages/sdk`，然后 `npm install`（yarn/pnpm 亦可，模板不锁定包管理器）；
4. 写 `src/` 业务代码与 `skills/` 能力单元（新增子程序 = 在 `programs` 加条目，新增 skill = 在 `skills` 加目录）；
5. 六条检查全绿：`npm run build` / `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run circular`；
6. 推送 git → 控制台登记绑定。

## 3. 运行时说明

- **sdk 注入**：运行时平台把 `@easemob/agent-sdk`（esbuild bundle）注入解析路径，业务零安装；包内 node_modules 的 sdk 只服务开发期类型与测试。
- **一入一出契约四条**：
  1. stdin 一段 JSON 进（信封 + 平台注入上下文，含 config/secrets/endpoint）；
  2. stdout 一段 JSON 出（`sdk.return` / `sdk.fail`，只认第一次）；
  3. 失败语义机械（任何一步失败 = 整体失败，不重跑）；
  4. 日志走 `sdk.log`（stderr，平台采集、secrets 源头脱敏）。
- **skills 注入**：`sdk.agent({ skills: [...] })` 按名引用（可多个、可跨绑定包），平台白名单校验后逐个 `--skill` 注入；没有运行时注册接口。
- **业务不做投递**：结果由平台扇出（下游关注 + 出口绑定投递）。

## 4. 目录说明

- `agent-package.json`：包清单——name/version + programs（子程序入口映射）+ skills（skill 目录列表），平台机械校验。
- `package.json`：工程定义——devDeps 与平台同构同版本，六条检查脚本。
- `tsconfig.json`：独立 TS 配置（不 extends 平台 base，拷贝后自成工程）。
- `jest.config.mjs`：jest 配置——跑 esbuild 转译后的 `dist-test/tests/**/*.test.js`。
- `eslint.config.js`：独立 eslint 配置——规则与平台同构，files 指向本包。
- `.prettierignore` / `.gitignore`：忽略 node_modules/dist/dist-test/coverage。
- `src/programs/main.ts`：流程程序骨架（单轮审查工单形态），注释承载约束四条。
- `skills/example/SKILL.md`：示例 skill——frontmatter + 正文的最低形态，替换为你自己的能力单元。
- `tests/main.test.ts`：e2e 失败路径两则，验证一入一出契约。
