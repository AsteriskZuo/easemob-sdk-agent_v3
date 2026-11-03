# my-package（包模板）

## 1. 这是什么

**包（package）模板**——平台资产三族之一「包」的工程骨架（业务代码单位：契约 + 程序 + 库代码），拷贝即用。资产模型的完整定义见平台设计文档 `design/asset-model.md`。

- **契约（contract.json）**：包根的机读契约文件——声明输入（入口检查）与输出（出口校验）的字段形状，是**唯一事实源**：平台物化校验它、控制台展示它、check 程序运行时解释它。schema 要点：顶层 `version: 1` 必填；`input` / `output` 两节必须显式给出（无约束 / 无产出写 `null`，不允许缺失）；字段 = `path`（点分路径）+ `type`（`string` / `number` / `boolean` / `object` / `array` / `T[]`）+ `required`（校验器只查必填项的存在与类型，可选项仅供展示）+ `desc`。
- **程序（apps/）**：可执行入口，在 `agent-package.json` 的 `programs` 里登记；值 = 转译后的 JS 相对包根路径，平台物化时机械校验每条路径真实存在。模板自带三个程序：`main`（主流程）、`check-input`（入口检查）、`check-output`（出口校验）——`check-input` / `check-output` 是**平台三段编排的保留程序名**，一次 run 依次执行 check-input → main → check-output；包内工具程序（如 jira-fetch）同表登记，名字自取。
- **库代码（packages/）**：不可直接执行的实现模块（类型、helper、业务逻辑）；apps/ 里的程序保持薄壳（读输入 → 调实现 → 汇报结果）。
- **requires**：名字级依赖声明（不钉版本）——本包代码 `sdk.run` 引用的外部工具名、`sdk.agent` 引用的 skill 名。控制台在业务绑定配置期机械校验这些名字都被绑定覆盖，缺绑 = 配置期报错。
- **skill / 工具是独立资产，不进包产物**：skill 集合（每个含 SKILL.md 的子目录 = 一个 skill）与工具（可复用子程序）都独立登记；想单仓开发就在本仓库的 `skills/`、`tools/` 占位目录里写，登记时按 subpath 拆成独立资产（详见两个目录内的 README）。不需要时删掉即可。
- **monorepo 纪律**：`apps/` 下各程序**互不依赖**（eslint 强制），共享代码只能下沉到 `packages/`；开发模式 = 本地 `npm install` 后六条检查跑源码与产物，生产模式 = 平台物化（clone → `npm ci` → `agent.materialize.mjs` 转译 → 产物校验）后由平台按 `programs` 拉起——两路产物同布局，运行依赖资产根 node_modules（开发/生产一致，也为业务包脱离平台的独立测试验证留好了路）。
- 模板内置与平台同构同版本的完整工具链（build/typecheck/lint/format/circular/test），作者只写 `contract.json`、`apps/` 与 `packages/` 业务代码，本地跑绿的检查就是平台要求的全套检查。

## 2. 快速开始

1. 拷贝本目录到你的仓库；
2. 改 `agent-package.json` 与 `package.json` 的 `name`；
3. 安装依赖：`npm install`（yarn/pnpm 亦可，模板不锁定包管理器）。`@asteriskzuo/agent-sdk` 是普通 npm 依赖，默认引用 npm 正式版 `^0.4.0`；仅离线开发兜底时改为 `file:<平台仓>/packages/sdk`（平台仓 `scripts/verify-template.sh` 的模板验收脚本就是这样改写的）。**用未发版的本地 SDK 调试业务包**的三种方式（软链/tgz/file:）与还原方法见 `local-sdk-verification.md`；
4. 写 `contract.json`（声明输入/输出契约）与 `apps/`、`packages/` 业务代码（新增子程序 = 在 `programs` 加条目；引用外部工具/skill = 在 `requires` 加名字）；
5. 六条检查全绿：`npm run build` / `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run circular`；
6. 推送 git → 控制台登记为包资产 → 创建业务时绑定（同时绑定 requires 声明的工具与 skill）。

## 3. 运行时说明

> 本节只列与本模板直接相关的运行时要点。**业务开发的完整知识**（SDK 全 API、contract.json schema、config/secrets 规则、出入口事件/结果对照、run 生命周期、本地调试、FAQ）见 SDK 主文档 `packages/sdk/README.md`（随 `@asteriskzuo/agent-sdk` 发布）——两处不一致时以 SDK README 为准。

- **sdk 是普通 npm 依赖**：`@asteriskzuo/agent-sdk` 从 npm 安装进包内 node_modules，开发与运行时用同一份代码；平台不做任何注入/bundle。
- **三段编排与纯校验纪律**：一次 run = check-input → main → check-output（同一 run 工作区与日志）。check 程序解释 contract.json——required 项查存在 + 类型，可选项不查；**只判过/不过、不做转换**（解析归 main）；平台对 check 阶段最小注入（无 secrets/endpoint/programs/dataDir）、60 秒固定超时；check-output 失败 = run 失败且产出不扇出。`"input": null` → 平台跳过入口检查；`"output": null` → 产出必须为空（stdout 结果行 output 键缺失或为 null）。校验需求超出「存在 + 类型」（跨字段一致性、值域、条件必填）时，自写 check 程序替换模板薄壳——平台契约（程序存在、过/不过语义）不变。
- **一入一出契约四条**：
  1. stdin 一段 JSON 进（信封 + 平台注入上下文，含 config/secrets/endpoint）；
  2. stdout 一段 JSON 出（`sdk.return` / `sdk.fail`，只认第一次）；
  3. 失败语义机械（任何一步失败 = 整体失败，不重跑）；
  4. 日志走 `sdk.log`（stderr，平台采集、secrets 源头脱敏）。
- **skills 注入**：`sdk.agent({ skills: [...] })` 按名引用（可多个、可跨 skill 集合），名字必须在业务绑定的 skill 集合内——平台白名单校验后把各 skill 的 SKILL.md 经 `--append-system-prompt` 全量内联进系统提示词；没有运行时注册接口。
- **模型选择与枚举（0.3.0 新增）**：`sdk.agent` 可选 `model` 参数按次指定模型（provider/id，缺省 = 业务默认模型 = 配置里第一个 provider 的第一个模型）；`sdk.models()` 枚举本业务生效配置里的全部 provider/模型（不含密钥）——链式兜底（多模型重试）的主入口，重试策略全归业务代码。每次 `sdk.agent` 调用计 1 次配额（`sdk.models()` 不计），走链的业务记得把 `max_agent_calls` 调到 ≥ 链长。完整示例见 SDK 主文档 §2.6。
- **契约 API（0.4.0 新增）**：`loadContract(fileUrl)` 读并形状校验 contract.json（坏契约抛错）；`checkFields(fields, data)` 按声明检查数据，返回问题列表（空 = 通过）——模板的 check-input / check-output 就是调它们的薄壳，业务零修改。`RunInput` 增 `output`：check-output 程序读主程序产出。
- **工具调用**：`sdk.run('jira-fetch', {...})` 按名调用本包或业务绑定工具资产的子程序，同一入一出契约（契约递归同构）。
- **业务不做投递**：结果由平台扇出（下游关注 + 出口绑定投递）。

## 4. 初始化脚本（agent.materialize.mjs，必带）

平台物化（git clone 资产仓库到缓存）的固定流程：clone → 清单形状校验 → `npm ci`（资产根含 package.json 时，要求同时含 package-lock.json）→ **执行 `node agent.materialize.mjs`**（cwd = 资产根，env 仅 PATH/HOME/NPM_CONFIG_REGISTRY，超时 10 分钟）→ 产物校验（`agent-package.json` 的 `programs` 每条路径必须真实存在，缺一即物化失败）。

- **必带**：package/tool 资产根缺这个文件 = 物化失败；skill 资产（纯文档）不需要。
- **职责**：完成本仓库的一切初始化——转译、其他语言产物的构建/安装、codegen、资源下载等。平台不传参、不理解过程，只验收产物。
- **默认实现**（本模板自带）：esbuild 转译 `apps/` 与 `packages/` 下的 `*.{ts,js}` → `dist/`（ESM / node24 / sourcemap，逐文件不 bundle、保持目录结构，运行时依赖资产根 node_modules——物化流程已先跑 `npm ci`），与 `npm run build`（tsc）同产物布局；简单项目原样可用。
- **何时自定义**：构建步骤超出「esbuild 转译 apps/ 与 packages/」（如需 codegen、拉取外部资源、构建非 JS 产物）时改写本脚本；注意脚本运行环境只有 node 24 + npm + git（python/rust/go 等谁用谁装，平台不提供）。
- **本地调试链路不变**：`npm run build`（tsc → dist/）供本地六条检查；平台物化走初始化脚本产出同一 dist/，两路同源同代码。

## 5. 包内程序 vs 共享工具

- **包内程序**（本仓库 `programs` 声明的）：同仓库路径可知，**可直接 import 进程内调用**（首选，零进程开销），也可 `sdk.run('名')` 走子进程隔离（需要隔离/限时时用）——包自由掌握。
- **共享工具**（控制台绑定的工具资产）：**只能 `sdk.run('名')` 按名调用**——跨仓库，物理路径由平台注入（stdin 信封 `programs` 映射），SDK 按名查表；业务代码永远不写路径。
- **名唯一性**：绑定时平台查重，重复拒绝；包清单 `requires` 声明的外部引用名必须在绑定中覆盖。

## 6. 目录说明

- `contract.json`：契约（唯一事实源）——输入检查 + 输出校验的字段声明（schema 要点见 §1）；物化闸校验存在 + 形状、控制台展示、check 程序运行时解释。
- `agent-package.json`：包清单——name/version + programs（子程序入口映射，值 = 物化后产物的相对路径；`check-input` / `check-output` 为平台三段编排保留名）+ requires（名字级依赖声明），平台机械校验。
- `agent.materialize.mjs`：初始化脚本（必带，见 §4）——平台物化时执行，默认 esbuild 转译 apps/ 与 packages/ → dist/。
- `package.json`：工程定义——devDeps 与平台同构同版本，六条检查脚本。
- `tsconfig.json`：独立 TS 配置（不 extends 平台 base，拷贝后自成工程）。
- `jest.config.mjs`：jest 配置——跑 esbuild 转译后的 `dist-test/tests/**/*.test.js`。
- `eslint.config.js`：独立 eslint 配置——规则与平台同构，files 指向本包。
- `.prettierignore` / `.gitignore`：忽略 node_modules/dist/dist-test/coverage。
- `apps/main/index.ts`：主流程薄壳（单轮审查形态）——取数/大模型/组装产出（注释承载约束四条）。
- `apps/check-input/index.ts` / `apps/check-output/index.ts`：入口检查 / 出口校验程序——调 SDK 通用校验器解释 contract.json 的薄壳，业务零修改；需要更强校验时自写替换（逃生门）。
- `packages/`：库代码目录（内含 README 说明使用纪律；模板暂无库代码）。
- `skills/`：**可选**——skill 集合占位（内含 README 与示例 `your-skill/`）；单仓多资产时按 subpath 登记为独立 skill 资产，不需要可删。
- `tools/`：**可选**——共享工具占位（内含 README 说明规则）；每个工具一个子目录、独立登记，不需要可删。
- `tests/`：e2e 测试——check-input / check-output 的契约行为（合法 / 缺失 / 类型错）与 main 的失败路径。
