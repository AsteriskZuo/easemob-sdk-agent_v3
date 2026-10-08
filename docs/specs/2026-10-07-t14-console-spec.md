# T14 控制台 SPA（app/console）任务规格

> 日期：2026-10-07
> 状态：待评审
> 任务：T14（依赖 T13；本任务是平台实现的最后一个前端任务，之后剩 T18 webhook 入口）
> 本规格自包含：执行者只读本规格与总计划（`docs/plans/2026-09-28-platform-implementation-plan.md`），不读原始设计文档。

---

## 1. 目标

实现浏览器控制台 SPA `app/console`（`@asterisk/agent-console`）：平台全部控制开关的可视化入口。六个 MVP 页面一次做全——登录、监控仪表盘、业务管理、资产管理、通用配置、用户管理。设计依据：`design/console-design.md`（§2 易用性三原则、§4 业务资料模块、§12 UI 骨架）。

同步的小幅后端扩展：console-api 增加静态资源托管选项（生产部署 = server 同进程托管 console 构建产物）。

console 与平台的关系：**console 是唯一的配置生产入口，但本身没有任何业务逻辑**——所有读写经 T13 管理 API（`/api/*`），页面不碰任何模块内部存储。开发期 Vite dev proxy 转发 `/api` 到 `localhost:6100`；生产期由 server 同进程托管静态文件，天然同源。

## 2. 背景（上游真实签名，已与源码核对）

### 2.1 管理 API（T13 已实现，console 的唯一数据口）

HTTP 约定：JSON in/out；cookie `agent_console_token`（HttpOnly，登录时 Set-Cookie）；同源部署/代理下 fetch 默认携带；错误体统一 `{ "error": { "code": "...", "message": "..." } }`（code ∈ invalid_input 400 / unauthenticated 401 / forbidden 403 / not_found 404 / conflict 409 / payload_too_large 413 / internal 500）。除 `POST /api/auth/login` 外全部需要登录态。

路由全集（详见 `docs/specs/2026-10-05-t13-console-api-spec.md` §5.3–§5.9）：

| 分组 | 路由 |
|------|------|
| auth | `POST /api/auth/login`（201 `{user, expires_at}`）、`POST /api/auth/logout`（204）、`GET /api/auth/me`、`POST /api/auth/change-password`（204） |
| users（admin） | `GET /api/users`、`POST /api/users`（201）、`POST /api/users/:id/disabled`（204） |
| businesses | `GET /api/businesses`（`BusinessProfile[]`）、`POST /api/businesses`（201）、`GET /api/businesses/:id`（`BusinessDetail`）、`PATCH /api/businesses/:id`（204）、`DELETE /api/businesses/:id`（204）、`POST /api/businesses/:id/matches`（201）、`DELETE /api/businesses/:id/matches`（204，body 传 source/event_type） |
| assets | `GET /api/assets?kind=&scope=mine\|shared\|all`、`POST /api/assets`（201）、`GET /api/assets/:id`（`AssetObject`，触发物化）、`DELETE /api/assets/:id`（204，仅属主） |
| env | `GET/PUT/DELETE /api/env/global`、`GET/PUT/DELETE /api/env/businesses/:id`（PUT body `{bucket, key, value}`；DELETE body `{bucket, key}`；GET 返回 `{vars, secret_keys}`） |
| config | `GET /api/config`（`EffectiveConfigView` 只读）、`GET /api/exit-tools`（`ExitToolMenuItem[]`） |
| monitor | `GET /api/monitor/queues`（`QueuesStatus`）、`GET /api/monitor/tasks?queue=&status=&event_id=&correlation_id=`（`Task[]`）、`GET /api/businesses/:id/runs?limit=`（`LifecycleRecord[]`）、`GET /api/runs/:id` |

### 2.2 DTO 类型（type-only 复用，console 不重复定义）

`@asterisk/agent-console-api` 包根导出全部 DTO 纯类型：`User / Role / BusinessProfile / BusinessMatch / ExitBinding / BusinessDetail / CreateBusinessBody / PatchBusinessBody / MatchBody / AssetMeta / AssetManifest / AssetObject / AssetKind / RegisterAssetBody / EnvListView / EnvSetBody / EnvRemoveBody / LoginBody / CreateUserBody / ChangePasswordBody / EffectiveConfigView / ExitToolMenuItem / ConfigField / QueueCounts / QueuesStatus / Task / LifecycleRecord / LifecycleStatus / ApiErrorBody`。console 以 `import type { ... } from "@asterisk/agent-console-api"` 复用（type-only，构建期擦除，零运行时成本）。

关键类型语义（详注见 T13 spec §2）：
- `BusinessProfile`：业务资料完整读面（prompt/model/agent_kind/package_asset_id/entry_program/tool_asset_ids/skill_asset_ids/timeout_minutes/max_agent_calls/on_failure）；
- `BusinessDetail = { profile, matches: BusinessMatch[], exit_bindings: ExitBinding[] }`；
- `ExitBinding.config` 只存非机密项；机密项（ConfigField.secret=true）存业务层安全桶；
- `ExitToolMenuItem.configSchema: ConfigField[]`（`{key, label, required?, secret?, placeholder?}`）——console 据此渲染出口配置表单；
- `AssetManifest` 判别联合：package（含 `programs: Record<string,string>` + `requires`）/ tool（`programs`）/ skill（`skills: string[]`）。

### 2.3 出口机密配置键规则（与 T12 exit-driver 对齐，硬约束）

出口绑定的 secret 配置项写入业务层安全桶时，键名**必须**为：

```
exit.{kind}.{field.key}
```

例：企微群 webhook 的 `token` 项 → 安全桶键 `exit.wecom-webhook.token`。这是 T12 ExitDriver 机密回填的既有约定，console 是唯一生产入口，写错键 = 运行时投递必败。回填方向：console 编辑已有出口绑定时，secret 项从安全桶键名列表回显「已配置」（掩码），重新填写才覆盖。

### 2.4 工程约定（T0 骨架）

- yarn 4.14.1 workspaces（`app/*` 已在 glob 内，新 app 自动纳入）；node ≥24；TS ^5.9；prettier；eslint 10 + typescript-eslint（根 `eslint.config.js`）；dpdm 循环检查；jest 29 + esbuild（先编译到 `dist-test` 再跑 jest，见 `jest.compiled.config.mjs` 与各包 package.json test 脚本）。
- 根脚本 `yarn workspaces foreach -Apt run build|test|typecheck` 自动覆盖新 app（`-t` 拓扑序）；`lint` = 根 `eslint .`；`circular` = `dpdm ... "packages/*/src/**/*.ts" "app/*/src/**/*.ts"`。
- eslint 现状：`files: ["packages/**/*.ts", "app/**/*.ts"]`——**不覆盖 `.tsx`**，本任务需扩展（§5.6）。
- dpdm 现状：glob 只含 `.ts`——本任务需补 `.tsx`（§5.6）。

## 3. 不做清单

- **统计搜索页**（console-design §12 标注「后续增加」）、日志检索、结果二维表/图形化——不做；
- **任务干预按钮**（终止/重试）：API 侧明确不做（T13 spec §3），UI 不出现；
- **UI 拖拽编排 / 流程图渲染**：永久不做（console-design §1 根本分野）；
- **定时触发配置的专门 UI**：定时入口的 entry_config schema 归 T18/后续入口任务，本期入口模块只提供 source=manual/internal 等通用匹配行编辑（entry_config 以 JSON 文本域兜底）；
- **暗色主题、国际化、移动端适配**：内部工具不做；
- **E2E 测试框架**（playwright 等）：不做，组件级 jest 测试 + 手工验证。

## 4. 包结构

```
app/console/
├── package.json            # @asterisk/agent-console（private）
├── tsconfig.json           # 独立配置：jsx react-jsx、lib DOM、bundler 解析（不继承 node 包模板）
├── vite.config.ts          # @vitejs/plugin-react + server.proxy /api → http://localhost:6100
├── jest.config.mjs         # 基于 jest.compiled.config.mjs，testEnvironment jsdom + setupFiles
├── index.html              # <div id="root">，中文 title「智能体平台控制台」
├── src/
│   ├── main.tsx            # 挂载 + antd ConfigProvider（zhCN）
│   ├── App.tsx             # 路由表 + 登录守卫 + 主布局（左侧导航）
│   ├── api/client.ts       # fetch 封装：错误体解析、401 → 跳登录（注入回调）
│   ├── auth/AuthContext.tsx# me 加载、login/logout/changePassword 动作、角色判定
│   ├── components/
│   │   ├── AppLayout.tsx   # 左侧导航六页 + 用户菜单（改密码/登出）
│   │   ├── EnvEditor.tsx   # 两桶 key-value 编辑器（vars 表格增删改；secrets 只写：键名列表+新增+删除）——global/business 两页面复用
│   │   └── MatchEditor.tsx # 匹配行编辑器（source 下拉 + event_type + entry_config JSON 文本域）
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── DashboardPage.tsx      # 监控仪表盘
│   │   ├── BusinessesPage.tsx     # 业务列表（注册表视图）
│   │   ├── BusinessEditPage.tsx   # 业务创建/编辑同体（§5.3 资料模块）
│   │   ├── AssetsPage.tsx         # 资产三族管理
│   │   ├── SettingsPage.tsx       # 生效配置只读 + 通用层两桶
│   │   └── UsersPage.tsx          # admin 用户管理
│   └── vite-env.d.ts
└── tests/
    ├── setup.ts                  # jsdom 补丁：matchMedia / ResizeObserver（antd 组件必需）
    ├── api-client.test.ts
    ├── auth-guard.test.tsx
    ├── login-page.test.tsx
    ├── business-form.test.tsx    # 核心：表单 → API body 映射 + secret 分流
    ├── assets-page.test.tsx
    └── pages-smoke.test.tsx      # dashboard/settings/users 渲染冒烟
```

`package.json` 要点：

- **dependencies**：`react` `^18.3.1`、`react-dom` `^18.3.1`、`react-router-dom` `^6.30.0`、`antd` `^5.21.0`、`@asterisk/agent-console-api` `0.1.0`（type-only 用途，正常声明保证 workspaces 拓扑序）；
- **devDependencies**：`vite` `^5.4.0`、`@vitejs/plugin-react` `^4.3.0`、`typescript`、`@types/react` `^18.3.0`、`@types/react-dom` `^18.3.0`、`jest`、`jest-environment-jsdom`、`@testing-library/react` `^16.0.0`、`@testing-library/dom` `^10.4.0`、`@testing-library/user-event` `^14.5.0`、`esbuild`；
- **scripts**：
  - `build`：`vite build`（产物 `dist/`，被根 build 拓扑接管）；
  - `test`：`rm -rf dist-test && esbuild $(find tests -name '*.ts' -o -name '*.tsx') --bundle --outdir=dist-test/tests --outbase=tests --format=esm --platform=node --target=node24 --jsx=automatic --sourcemap --log-level=error && NODE_OPTIONS='--experimental-vm-modules' jest --config jest.config.mjs --rootDir .`
    - **--bundle 是必需的**：antd 是 CJS 包，node ESM 直接 named import 不稳；bundle 后 antd 内联进测试产物，规避解析问题（这是与 node 包 test 脚本的唯一差异，注释说明）；
  - `typecheck`：`tsc --noEmit`；
  - `dev`：`vite`（本地开发）。

## 5. 详规

### 5.1 全局骨架（App / 布局 / 认证）

- `api/client.ts`：`apiFetch<T>(path, init?)`——同源 fetch、JSON 编解码、错误体解析为 `ApiError {code, message, status}` 抛出；**401 时调用注入的 onUnauthorized 回调**（AuthContext 注入：清用户态，路由守卫自然弹回登录页）；DELETE 带 body 用 `JSON.stringify` + content-type。
- `auth/AuthContext.tsx`：启动时 `GET /api/auth/me`；提供 `{ user, loading, login, logout, changePassword }`；`user === null && !loading` 时路由守卫渲染 `<Navigate to="/login">`。
- 路由表：`/login` 公开；其余全部在守卫内。六页导航按 console-design §12 频率序：监控仪表盘（`/`）、业务管理（`/businesses`）、资产管理（`/assets`）、通用配置（`/settings`）、用户管理（`/users`，**仅 admin 显示**）；业务编辑 `/businesses/new` 与 `/businesses/:id` 不进导航。
- 布局：antd `Layout` 左侧 `Menu` + 右侧内容区；右上角用户菜单（显示 display_name + role 徽标；下拉：修改密码 modal、退出登录）。
- 易用性（console-design §2，验收相关）：每个表单模块旁 `Tooltip` 叹号提示「是什么/何时用/配错的后果」，文案写死在组件里（不跳外部文档）；空状态页（无业务）显示「创建第一个业务」引导按钮。

### 5.2 页面：登录 / 用户管理 / 通用配置 / 监控仪表盘

**LoginPage**：居中卡片，用户名+密码；成功 → `navigate("/")`；失败统一提示「用户名或密码错误」（不区分原因）；已登录访问 `/login` 重定向 `/`。

**UsersPage（admin）**：用户表格（display_name/username/role/disabled/created_at）+ 建号 modal（username/display_name/password/role 下拉）+ 停用/启用按钮（确认框；表格行置灰展示停用态）。member 访问该路由直接重定向 `/`（前端藏入口 + 路由兜底；真权限在 API）。

**SettingsPage**：
- 「生效配置」卡片：`GET /api/config` 只读描述列表（全部字段原样展示）+ 叹号提示「改配置 = 改环境变量/config.json 后重启」；
- 「通用层 key-value」：`EnvEditor` 组件（scope=global）；**member 只读**（编辑按钮隐藏），admin 可写。

**DashboardPage**：
- 顶部两卡片：入口/出口队列计数（`GET /api/monitor/queues`，5 秒轮询；展示 pending/processing/done/dead 四数）；
- 「任务查询」区：队列选择（entry/exit 必选）+ status/event_id/correlation_id 过滤表单 → `Task[]` 表格（task_id/status/event_type/source/enqueued_at/finished_at；行展开显示 event JSON）；
- 「业务运行记录」区：业务下拉（`GET /api/businesses`）→ `GET /api/businesses/:id/runs` 表格（run_id/status/created_at/finished_at；status 用颜色徽标：running 蓝/success 绿/failed 红/timeout 橙）。

### 5.3 页面：业务管理（核心页）

**BusinessesPage**：`BusinessProfile[]` 表格（名称/id/agent/model/包绑定状态/创建者）；操作列：编辑、删除（确认框）；顶部「创建业务」按钮。

**BusinessEditPage**（创建/编辑同体，`/businesses/new` 与 `/businesses/:id` 共用）：按 console-design §4 资料模块组织成表单区块，每块带叹号提示：

| 区块 | 控件与数据源 | 提交映射 |
|------|-------------|---------|
| 业务名称 | Input | `business_name` |
| 包绑定（必填提示） | 下拉：`GET /api/assets?kind=package&scope=mine`；选中后 `GET /api/assets/:id` 取 manifest，`entry_program` 下拉 = `programs` 键列表 | `package_asset_id` / `entry_program` |
| 工具绑定 | 多选：`GET /api/assets?kind=tool&scope=all`（member 可见全集=mine+shared） | `tool_asset_ids` |
| skill 绑定 | 多选：`GET /api/assets?kind=skill&scope=all` | `skill_asset_ids` |
| agent / 大模型 | Select 固定项 `pi` / `qwen3.8max`（注册表驱动，MVP 单值） | `agent_kind` / `model` |
| 提示词总纲 | Textarea（rows≥6） | `prompt` |
| 入口（匹配行） | `MatchEditor` 列表：source 下拉（contracts 七值）、event_type Input、entry_config JSON Textarea（空 = 不传；非法 JSON 表单内报错）；增删行。提示文案：「关注上游业务产出 = source 选 internal + event_type 填 `业务id.产出类型`」 | 创建时首个匹配行进 `CreateBusinessBody`；编辑态增删行 = `POST/DELETE /api/businesses/:id/matches` |
| 出口（可选） | `GET /api/exit-tools` 菜单勾选；勾选后按 `configSchema` 动态渲染表单项（required 标红星）；`implemented=false` 的工具置灰不可选 | 见下方「出口配置分流」 |
| 失败传播 | Switch（默认关） | `on_failure` |
| 超时/配额覆盖 | InputNumber 可清空（空 = 用全局默认） | `timeout_minutes` / `max_agent_calls`（清除 = null） |
| 业务 key-value | `EnvEditor`（scope=business） | `PUT/DELETE /api/env/businesses/:id` |

**出口配置分流（本页最要害的逻辑，§2.3 的落地）**：某工具 `kind` 的表单提交时——
1. `secret=true` 的项：`PUT /api/env/businesses/:id`，key = `exit.{kind}.{field.key}`，value = 表单值；**不进 ExitBinding.config**；
2. `secret!=true` 的项：进该 `ExitBinding.config`；
3. 编辑态回填：ExitBinding.config 原样回填非机密项；secret 项按安全桶键名列表显示「已配置」占位（值不回显），留空 = 不改动，填新值 = 覆盖。

**提交流程**：
- 创建：表单校验（business_name 非空、首个匹配行 source/event_type 非空）→ `POST /api/businesses` → 拿 business_id → 依次写出口 secret 项 / 业务 env 变更 → 跳编辑页；
- 编辑：进入时 `GET /api/businesses/:id` + `GET /api/env/businesses/:id` 回填；保存 = `PATCH`（资料字段）+ 匹配行增删 diff + env diff + 出口 secret 覆盖；
- env/secret 的「diff」v1 从简：**编辑页的环境配置区独立保存按钮**（EnvEditor 自管理 PUT/DELETE，不并入主表单提交），主保存按钮只管 registry 侧字段——避免一次提交混合多资源的部分失败语义。

### 5.4 页面：资产管理

- kind Tab（包/工具/skill）+ scope 筛选（我的/共享的/全部——member 的「全部」= 可见全集）；
- 登记表单（Drawer）：kind（当前 Tab）、url、ref、subpath、shared（仅 tool/skill 可勾，package 隐藏）、is_private + credential_key（is_private 时必填，叹号提示「凭据值需先在通用配置安全桶登记同名 key」）；
- 列表：asset_id（截断+复制）、名称（manifest.name 无则 —）、owner_id、shared/is_private 徽标、created_at；行操作：详情（`GET /api/assets/:id`，Modal 展示 manifest 美化 JSON + meta；提示「首次查看可能触发 git 克隆，较慢」）、下架（**仅 `owner_id === 当前用户` 显示**；确认框文案提示「下架不校验在役引用，绑定该资产的业务运行时将报错」）；
- admin 提示：admin 不持有资产——登记表单对 admin 隐藏（API 也 403）。

### 5.5 后端扩展：console-api 静态托管（小增补）

`ConsoleApiOptions` 增加可选项（T13 spec §5.10 的扩展，签名增补如下，其余不变）：

```ts
export interface ConsoleApiOptions {
  port: number;
  bootstrap_admin?: { username: string; password: string };
  /** 控制台静态资源目录（vite build 产物的绝对路径）；
   *  设置后：非 /api 请求按文件托管（GET/HEAD），未命中回退 index.html（SPA 路由）；
   *  不设置 = 纯 API 服务（开发期形态） */
  static_dir?: string;
}
```

实现要求（console-api 的 `server.ts` / 新增 `static.ts`）：
- MIME 小表硬编码（html/js/css/json/svg/png/ico/woff/woff2/txt/map，缺省 application/octet-stream）；
- 路径安全：URL 解码后 `path.resolve`，结果必须在 static_dir 内，否则 404；目录请求回退 index.html；
- 静态 404（含 index.html 不存在）返回统一错误体；`/api` 前缀永远优先于静态分支；
- 缓存：index.html `Cache-Control: no-cache`，带 hash 的静态资源 `max-age=31536000, immutable`（按文件名含 `-` hash 段启发式判定，或统一 no-cache 从简——实现者择一并注释）。

app/server 侧：`ServerConfig` 增加 `console_static_dir?: string`（`AGENT_CONSOLE_STATIC_DIR`，string 键、可缺省、trim 空 = 未设置）；bootstrap 原样传入 `createConsoleApi` options；启动日志静态托管开启时补 `static_dir`。

测试（并入 console-api 现有套件或新增 `static.test.ts`）：index.html 命中/SPA 回退/路径穿越 404/MIME 正确/`/api` 不受影响/未设置 static_dir 时非 api 404。

### 5.6 工程配置改动（根级）

1. 根 `eslint.config.js`：
   - `files` 加 `app/**/*.tsx`；
   - 新增配置块仅对 `app/console/src/**/*.{ts,tsx}`：`languageOptions.globals` = browser（需根 devDeps 加 `globals` 包）+ react-hooks 规则（根 devDeps 加 `eslint-plugin-react-hooks`，启用 `react-hooks/rules-of-hooks` + `react-hooks/exhaustive-deps` warn）；
2. 根 package.json：`circular` 脚本 glob 补 `"app/*/src/**/*.tsx"`；devDependencies 加 `globals`、`eslint-plugin-react-hooks`；
3. `.prettierignore` / `.gitignore`：确认 `app/console/dist` 与 `dist-test` 被覆盖（`**/dist` 类规则已有则不动）；
4. 根六连命令不变，自动接管新 app。

## 6. 测试清单

jsdom + @testing-library；API 一律 mock（`apiFetch` 层注入或 globalThis.fetch stub）；antd 组件真实渲染（setup.ts 补 matchMedia/ResizeObserver）。

- **api-client.test.ts**：成功 JSON 解析；错误体 → ApiError（code/status 保留）；非错误体 500 → internal；401 触发注入回调；DELETE 带 body 序列化。
- **auth-guard.test.tsx**：me 200 → 渲染子路由；me 401 → 跳 /login；loading 中显示加载态（不闪现登录页）。
- **login-page.test.tsx**：提交调用 login 且成功跳转；失败展示统一错误文案；已登录重定向。
- **business-form.test.tsx**（核心）：① 创建提交映射——表单值 → `CreateBusinessBody`（首个匹配行/agent/model/资产绑定/超时覆盖）；② **出口 secret 分流**——secret 项进 env PUT（key=`exit.{kind}.{field.key}`）且不出现在 ExitBinding.config，非 secret 项反之；③ 编辑回填——BusinessDetail + env 键名 → 表单初值（secret 显示「已配置」占位）；④ entry_config 非法 JSON 表单内报错不提交；⑤ 清除超时覆盖提交 null。
- **assets-page.test.tsx**：登记表单提交映射（package 隐藏 shared；is_private 必填 credential_key）；下架按钮仅属主可见；admin 不见登记入口。
- **pages-smoke.test.tsx**：Dashboard（队列卡片渲染 mock 计数）、Settings（config 只读展示 + member 隐藏编辑）、Users（admin 表格渲染、停用确认）。
- console-api 静态托管用例见 §5.5。

## 7. 验收标准

1. 根目录 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 全绿（含 app/console 全部脚本被 foreach 接管）；
2. §6 测试清单全覆盖且通过；console-api/app-server 既有测试不回归；
3. 手工冒烟（执行者完成、主 agent 复验）：`yarn workspace @asterisk/agent-console build` 产物存在；起 server（设 `AGENT_CONSOLE_STATIC_DIR`）→ 浏览器/curl 访问 `/` 返回 index.html、`/api/auth/me` 401；vite dev + proxy 下登录页可渲染；
4. console-design §2 易用性逐条过：核心路径（登录 → 创建业务 → 看到列表）无文档可完成；表单模块带叹号提示；无业务空状态有引导。

## 8. 决策点（本规格已定案，执行中不重新讨论；有异议找 owner）

1. **组件库 = antd v5**：内部工具效率优先，表单/表格/弹窗零造轮；cssinjs 方案使测试无需处理 CSS 导入。不引状态库（fetch + useState/useContext 够用）。
2. **六页一次做全**：T13 API 已覆盖全部所需接口，半截 console 没有使用价值；统计搜索页按设计「后续增加」不做。
3. **部署形态现在定案**：生产 = server 同进程托管静态文件（console-api `static_dir` 选项，`AGENT_CONSOLE_STATIC_DIR` 可选 env），开发 = vite dev proxy；不引 CORS。
4. **React 18 + Vite 5 + antd 5**：稳定组合，不追 React 19/Vite 新大版本（antd 兼容面最广）。
5. **测试不用 vitest**：保持全仓单测试框架（jest）；antd 的 CJS 解析问题用 esbuild `--bundle` 内联解决。
6. **出口 secret 键规则 `exit.{kind}.{field.key}` 是硬契约**（T12 既有约定），console 表单分流逻辑必须严格实现，business-form 测试逐条覆盖。
7. **编辑页 env 独立保存**：主表单只管 registry 字段，避免混合提交的部分失败语义；UI 上分区块表达。
8. **入口/关注统一为匹配行编辑**：source=internal 即「关注」，不单独做关注 UI（机制同构，提示文案说清）。
