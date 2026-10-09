# T21 spec：平台侧可落地批次（物化构建 + 入口适配器 + 出入口自描述 + 内部入口 + sdk 文档）

- **日期**：2026-10-08
- **状态**：待审
- **决策依据**：`docs/decisions/2026-10-08-package-scope-rename.md`、`docs/decisions/2026-10-08-asset-materialization-build.md`
- **依赖**：T12（装配/EntryAdapter 接口）、T16（asset-registry）、T20（包名已改 @asteriskzuo/\*）
- **吸收**：T18（webhook 入口适配器，原计划单列，并入本任务 §7.2）

## 1. 背景（为什么做这个批次）

v2 单轮审查工单迁移验证暴露出平台「业务可落地」链路的一批缺口，本批次一次性补齐：

1. **物化构建链路缺失**：模板清单 `programs` 指向 `dist/programs/*.js`，但 `.gitignore` 忽略 `dist/`，git clone 物化出的资产没有可执行产物，任何业务包都跑不起来；「上传转译 + sdk 注入」只在文档里，代码无实现。
2. **入口适配器为零**：EntryAdapter 接口已定义（T12），但没有任何内置实现——业务无事件可收。
3. **业务级持久状态无处放**：sdk 只有 per-run 隔离 workspace，跨 run 状态（如审查去重记录）无落点。
4. **「无需通知」无表达**：业务判定 skip 时，出口链仍会无脑投递。
5. **出入口对接靠猜**：控制台选定入口/出口后，业务开发者不知道事件长什么样、该返回什么形状。
6. **上游业务入口无法表达**：业务依赖上游业务结果（流水线）的机制已在调度层实现（deriveEvent 扇出 + BusinessMatch 通用匹配），但控制台建模缺失。

## 2. 范围总览与批次拆分

| 批次   | 内容                                                                                                                                         | 涉及包/app                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| T21a   | 物化构建链路（§4）+ 信封 dataDir（§5）+ 出口 null 跳过（§6）+ 自检/npm 配置（§10 部分）+ 模板加初始化脚本修订                              | asset-registry、workflow-runner、sdk、scheduler、server、templates |
| T21b   | EntryAdapter 自描述扩展（§7.1）+ webhook 入口适配器（§7.2）+ jira-polling 入口适配器（§7.3）+ 适配器开关（§7.4）                               | server（新增 packages/entry-adapters，见 §7.0）              |
| T21c   | console-api：出入口自描述暴露 + 缓存清理 API（§8.1）；console：编辑页 schema 展示 + 内部入口引导 + 缓存清理按钮（§8.2）                          | console-api、console                                        |
| T21d   | sdk README 完整文档（§9）+ 设计文档回写（§11）                                                                                                 | sdk、docs                                                   |

依赖：T21a → T21b → T21c；T21d 最后（文档内容以前三者落地形态为准）。

## 3. 术语与既有契约快照（自包含，执行者无需翻设计文档）

**事件信封 EventEnvelope**（`packages/contracts/src/envelope.ts`，已存在不改）：

```ts
{
  contract_version: "v1"; // 恒为 "v1"
  source: "wecom" | "jira" | "github" | "webhook" | "cron" | "internal" | "manual";
  event_id: string; // 全局唯一锚点，兼作入口幂等键（队列层 event_id 唯一约束去重）
  event_type: string; // 类别标签，业务关注匹配的键
  timestamp: string; // ISO 8601 带时区
  session_id: string; // 源生会话标识（工单 key 等），平台视为不透明字符串
  correlation_id: string; // 派生链首个任务的 event_id
  hop_count: number; // 派生转发计数，防循环
  payload: unknown; // 事件数据载体；派生事件的 payload = 业务产出
  producer_business_id?: string; // 仅 internal 派生事件填写
}
```

**stdin 信封 StdinEnvelope**（`packages/workflow-runner/src/contract.ts`，本批次扩 §5）：`{ contract_version, input, workspace?, config?, secrets?, endpoint?, programs? }`。

**EntryAdapter 接口**（`app/server/src/entry-adapter.ts`，已存在）：`{ readonly source: EventSource; start(deps: EntryDeps): void; stop(): Promise<void> }`；`EntryDeps = { queue: TaskQueue; registry: BusinessRegistry; env: EnvProvider }`。各适配器自管理监听资源，装配根只管注入与 start/stop。

**结果扇出（已存在，不改语义）**：业务执行完结 → `deriveEvent` 派生 internal 事件（`event_type = {business_id}.completed|failed`，payload = output 原样）→ 同投入口队列（下游业务）与出口队列（出口投递）。

**ExitTool 接口**（`packages/exit-tools/src/types.ts`）：`{ kind, name, implemented, configSchema: ConfigField[], destinationOf(config), bind(config) → Exit }`；`ConfigField = { key, label, required?, secret?, placeholder? }`（secret 项不落库，投递前从业务 secrets 桶按 `exit.{kind}.{field.key}` 回填）。

## 4. 物化构建链路（T21a，asset-registry）

### 4.1 两个脚本（核心概念）

- **平台物化脚本**：asset-registry 提供独立可执行入口（`src/materialize-cli.ts`，随包编译为 `dist/materialize-cli.js`），固定流程 `clone → npm ci → 业务初始化脚本 → 产物校验`。`AssetRegistry.materialize()` 内部走同一实现；同时**可脱离平台独立 CLI 执行**（`node packages/asset-registry/dist/materialize-cli.js --url <url> --commit <commit> [--subpath <p>] --target <dir>`；凭据经环境变量）——绑定失败时管理员手动跑同一条命令即可复现完整输出，不用翻日志猜。
- **业务初始化脚本**：`agent.materialize.mjs`（资产根，subpath 之后）。**package/tool 资产必带**，缺失 = 物化失败（错误消息明确提示缺这个文件）；skill 资产（纯文档）不需要。

为什么必带：仓库内容不限语言（TS/Python/Rust 均可混入，入口仍须 node），初始化方式各不相同（转译、装环境、git 操作、调项目自己的脚本），平台不可能枚举。模板自带该脚本的默认实现，新仓库拷贝模板即零负担。

### 4.2 物化流程（固定规范流程）

现状 `materialize()`：clone → validateAsset → 去 .git → 写 marker → 原子 rename。改造后（kind ∈ {package, tool}；skill 资产维持原流程不构建）：

```text
clone → validateAsset（清单形状校验）
  → npm ci（§4.3，资产根含 package.json 时）
  → 执行业务初始化脚本 agent.materialize.mjs（§4.4）
  → 产物校验（清单 programs 每个路径必须真实存在，缺一即失败并列出缺失清单）
  → 去 .git → 写 .materialized-ok → 原子 rename
```

任何一步失败：清理临时目录、不落 marker、抛错（消息含阶段名与 stderr 尾部最后 30 行）。

### 4.3 npm ci

- 同步执行（`execFileSync`，绑定校验本就同步阻塞，既有取舍延续），cwd = 资产根（含 subpath），timeout 10 分钟。
- 资产根含 `package.json` 时必须同时含 `package-lock.json`，缺失 → 失败并明确提示「v1 只支持 npm + package-lock.json」。
- env = `{ PATH, HOME, NPM_CONFIG_REGISTRY? }`（registry 见 §10）；不继承平台进程其他环境变量。
- 平台不直接执行业务仓的 npm scripts（构建动作一律经 agent.materialize.mjs 表达）；依赖包自身的 postinstall 属固有代价，文档认账。

### 4.4 业务初始化脚本契约（agent.materialize.mjs）

- 执行：`node agent.materialize.mjs`，cwd = 资产根，env 同 §4.3，timeout 10 分钟，exit≠0 = 物化失败（stderr 尾部透传）。
- 职责：完成本仓库的一切初始化——TS 转译、其他语言产物的构建/安装、codegen、资源下载、git 操作等，平台不传参、不理解过程，**只验收产物**：脚本跑完后清单 programs 声明的每个产物文件必须存在。
- **语言边界（准确口径）**：仓库内容不限语言，但**所有 program 入口必须是 node 可执行的 JS**（runner 与 sdk.run 均以 `node <program>` 拉起）。其他语言的接入方式 = 薄 JS wrapper + child_process 调用（wrapper 接信封、spawn 目标语言、回传结果），目标语言的产物/环境由初始化脚本准备。
- **环境边界**：平台宿主只保证 node 24 + npm + git + pi（自检）；python/rust/go 等其他语言环境平台不提供、不检查——谁用谁装，缺失会在 bind 期被初始化脚本明确暴露（如 `python3: command not found` 进 400 错误）。
- 模板自带默认实现（esbuild 转译 `src/` → `dist/`，与模板 `npm run build` 同产物），简单项目原样可用。

### 4.5 清单 programs 维持产物路径（不变）

`agent-package.json` 的 programs 值 = **物化后产物的相对路径**（如 `dist/programs/main.js`，与模板现状一致，零改动）。物化时先校验清单形状（相对路径、不含 `..`、扩展名 `.js`），初始化脚本执行后再校验产物存在性。`AssetRegistry.get()` 返回的 manifest 原样（无路径改写）。

### 4.6 缓存与并发

- 构建产物进缓存（产物目录与 node_modules 随资产缓存目录同生共死，`remove()` 连带清理）。
- v1 不加并发锁：并发物化同一资产接受竞态（临时目录 + 原子 rename 兜底，最坏情况是重复构建）。
- 已知脆弱性写入文档：缓存清理后重建依赖 npm registry 状态（依赖 unpublish 则老版本重建失败）；缓解 = 锁文件钉死 + 保守清理。

### 4.7 模板修订（T21a 附带）

- `templates/agent-package/` 新增 `agent.materialize.mjs`：默认实现 = esbuild 转译 `src/**/*.{ts,js}` → `dist/`（`--format=esm --platform=node --target=node24 --sourcemap`，保持目录结构，不做 bundle——native 模块/动态 require/`__dirname` 资源因此正常）。
- 模板 README：sdk 依赖从 `file:` 改为 npm 正式版（`@asteriskzuo/agent-sdk: ^0.1.0`，已发布前提）；「sdk 注入」表述删除，改为「sdk 是普通 npm 依赖」；补「初始化脚本」一节（必带、职责、何时需要自定义）。
- 模板独立运行链路不变：`npm run build`（tsc → dist/）供本地调试；平台物化走初始化脚本产出同一 dist/，两路同源同代码。
- `scripts/verify-template.sh` 的 `file:` 改写逻辑保留（离线验收用），README 说明其用途。

## 5. 信封 dataDir：业务级持久目录（T21a）

问题：业务跨 run 状态（如审查去重记录 review-records.json）无落点；per-run workspace 是隔离临时目录。

- **StdinEnvelope 加字段** `dataDir?: string`——业务级持久目录绝对路径，**仅平台→流程程序注入**；`sdk.run` 不向子程序传（叶子无状态语义，与 programs/secrets 同规则；子程序确需持久由流程程序自己把路径经 input 传入）。
- **路径派生**（runner 内部，与 workspace/logPath 同方式，RunRequest 不加字段）：`{workspace}/data/{source}/{session_id}/{business_id}/`，run 启动时 `mkdirSync(recursive)`；三段都过 `assertSafeSegment`。
- **并发保证**：入口通道键 = `{source, session_id, business_id}` 三元组，同 dataDir 的 run 天然被通道串行化——业务在 dataDir 读写状态文件（如 review-records.json）无需自锁。
- **sdk 加 API**：`sdk.dataDir(): string`——信封缺失抛错（与 input() 的 workspace 校验同风格）。
- 数据分类归属：`data/` = 业务级持久数据（区别于 runs/ 临时、logs/ 可删、cache/ 可重建）。业务自行管理该目录内容的容量与清理，平台不做 TTL。

## 6. 出口 null 跳过（T21a，scheduler）

语义：**`sdk.return(null)` = 本业务明确无产出，出口不投递**；入口下游照常收到派生事件（payload=null，下游自行判断）。

实现：`packages/scheduler/src/exit-loop.ts` 摄取处（查 exitBindings 之前）判 `task.event.payload === null` → `queue.complete(task_id)` + info 日志「空结果跳过投递」（带 event_id/task_id/producer_business_id），不再查绑定、不挂通道。

## 7. 入口适配器（T21b）

### 7.0 落位：新包 `packages/entry-adapters`（@asteriskzuo/agent-entry-adapters）

入口适配器实现从 server 装配层下沉为独立包（与 exit-tools 对偶）：适配器 = 纯逻辑 + 注入依赖（queue/registry/env），server 只装配。包依赖：contracts、queue（type-only）、registry（type-only）、runtime（EnvProvider type-only）、exit-tools（ConfigField 类型复用）。工程约定同 T0（build/test/typecheck/lint/format/circular 六脚本）。

### 7.1 EntryAdapter 自描述扩展

适配器除运行实例外追加**描述元数据**（控制台展示与 API 暴露用）：

```ts
/** 入口适配器描述：控制台「看了就懂」的数据源 */
export interface EntryAdapterSpec {
  id: string; // 适配器唯一标识（如 'webhook' | 'jira-polling'），开关键按它派生（§7.4）
  kind: EventSource; // = 适配器产出事件的 source（'webhook' | 'jira' | ...）；多个适配器可共享同一 source（如 jira-polling 与将来的 jira-webhook 都是 'jira'）
  name: string; // 展示名（如「自定义 Webhook」「Jira 定时轮询」）
  defaultEnabled: boolean; // 缺省开关（jira-polling = false，其余 true）
  configSchema: ConfigField[]; // entry_config 的字段声明（复用 exit-tools 的 ConfigField）
  eventDoc: string; // markdown：事件类型清单 + payload 形状 + 示例 JSON
}

/** 适配器工厂：描述 + 运行实例创建 */
export interface EntryAdapterFactory {
  spec: EntryAdapterSpec;
  create(): EntryAdapter; // EntryAdapter 为 T12 既有接口
}
```

`entry-adapters` 包导出 `ENTRY_ADAPTERS: EntryAdapterFactory[]`（内置清单：webhook、jira-polling）。

### 7.2 webhook 入口适配器（吸收 T18）

- **独立 HTTP 服务**（入口流量与管理 API 分离，既定决策）：端口 `AGENT_WEBHOOK_PORT`（默认 6200，见 §10）。
- **多端点模型**：一个 webhook 适配器 = 一个 HTTP 服务，承载**任意多个端点**。每条 `source='webhook'` 的 match 行声明自己的 `entry_config.path`（如 `jira-listener`、`github-events`），投递地址 = `POST /hooks/{path}`。一个业务可挂多条 webhook 行（多个端点），多个业务各自的端点互不干扰；path 全平台唯一——业务创建/更新时校验查重（console-api 绑定校验加一条：webhook 行 path 与其他业务的 webhook 行不重复）。请求按 path 现查注册表内存视图路由（业务增删即时生效，无需重启）。
- **entry_config schema**（configSchema 据此声明，控制台据此渲染）：

  | 键               | 必填 | 说明                                                                                       |
  | ---------------- | ---- | ------------------------------------------------------------------------------------------ |
  | `path`           | 是   | URL 路径段（如 `jira-listener`）；合法字符 `[a-z0-9-]`                                     |
  | `session_id_key` | 是   | payload 中取 session_id 的字段路径（点分，如 `issue.key`）；取不到/非非空字符串 → 400     |
  | `event_id_key`   | 否   | payload 中取 event_id 的字段路径；缺省平台生成（此时幂等由推送方自负）                     |
  | `token_key`      | 否   | 验签 token 的 secrets 键名；设置后请求须带 header `x-webhook-token` 等值，不符 → 401       |

- **处理链**：path 路由（§7.2 多端点模型）→ 验签（token_key 配置时，从该业务 secrets 桶取值比对）→ body 必须 JSON object → 提取 session_id/event_id → 包装信封（source='webhook'，event_type = match 行的 event_type，payload = body 原样，hop_count=0，correlation_id = event_id）→ 落队。
- **响应**：落队成功 `200 { event_id }`；未知 path `404`；验签失败 `401`；body/字段非法 `400`（message 列出原因）。event_id 重复 → 队列幂等丢弃，仍回 200（携带原 event_id）。
- **eventDoc**：说明上述契约 + payload 形状由推送方自定义的约定 + curl 示例。

### 7.3 jira-polling 入口适配器

- **定位**：内部测试与无外网 webhook 场景的 jira 工单拉取入口；默认关闭（§7.4）。
- **entry_config schema**（match 行 `source='jira'`）：

  | 键                | 必填 | 说明                                                                     |
  | ----------------- | ---- | ------------------------------------------------------------------------ |
  | `jira_url`        | 是   | jira 站点根地址                                                          |
  | `username_key`    | 是   | jira 用户名的 secrets 键名（凭据存业务 secrets 桶，此处只存键名引用）     |
  | `password_key`    | 是   | jira 密码的 secrets 键名                                                 |
  | `project`         | 是   | 项目 key（JQL `project = "X"`）                                          |
  | `assignees`       | 否   | 负责人过滤，逗号分隔；缺省或 `*` = 不过滤                                |
  | `days_back`       | 否   | JQL `updated >= -Nd`，默认 7                                             |
  | `interval_seconds` | 否  | 轮询间隔秒，默认 60，下限 30                                             |

- **轮询器管理**：适配器 start 后每个 tick 现查 registry 内存视图的 `source='jira'` 行集合，动态增删轮询器（业务创建/更新/删除即时生效）；每行一个独立轮询器（防重入：上一轮未完跳过本轮）。
- **jira 客户端**：适配器内嵌轻量客户端，只含 searchIssues（表单登录 + cookie 罐 + 401 重登一次；实现时从 v2 搬运最小集：`/Users/asterisk/Codes/ai/easemob-sdk-agent_v2/src/jira/jira-client.ts` 的登录/search 路径，本 spec 不复制其代码）。与业务工具 jira-fetch 的完整客户端是两份代码，v1 接受（适配器只 search，范围小）。
- **事件产出**：search 结果每工单一个事件——`source='jira'`；`session_id = issueKey`；`event_id = jira:{issueKey}:{updated}`（同 updated 重推被队列幂等丢弃，updated 变化 = 新事件，天然增量）；`event_type` = match 行的 event_type（建议 `jira.issue.updated`）；`payload = { issue_key, summary, status, priority, issue_type, assignee, reporter, updated }`（轻量字段；详情由业务自行 sdk.run 拉取——平台不做业务预取）。
- **eventDoc**：列 jira 主要事件类型（`jira:issue_created` / `jira:issue_updated` / `jira:issue_deleted` / `comment_created`，说明本适配器统一产出为 match 行配置的 event_type）+ payload schema + 示例 JSON + 「认证为 easemob jira 表单登录形态」的环境约束说明。

### 7.4 适配器开关（server config）

- 新增配置键（env > config.json > 默认，与既有键同机制）：`AGENT_ENTRY_WEBHOOK_ENABLED`（默认 true）、`AGENT_ENTRY_JIRA_POLLING_ENABLED`（默认 false）。键名规则：`AGENT_ENTRY_{适配器 id 大写、'-' 转 '_'}_ENABLED`（id 见 §7.1，不是 source——多个适配器可共享 source，开关必须按 id 区分）。
- 语义：关闭 = 装配根不创建不启动该适配器（其必需配置缺失也不报错——关闭的适配器完全不看）；开启的适配器自检其必需配置，缺失拒启动。
- 装配根启动日志列出各适配器开关状态。

## 8. console-api 与 console（T21c）

### 8.1 console-api

1. **GET /api/config 扩展**：新增 `entry_adapters: EntryAdapterSpec[]`（含 configSchema/eventDoc/defaultEnabled/当前开关状态）；exit_tools 各项追加 `resultDoc`（见 §8.1.2）。
2. **ExitTool.resultDoc**：`packages/exit-tools/src/types.ts` 的 ExitTool 加 `resultDoc: string`（markdown：`sdk.return` 该返回什么形状 + 示例 JSON）。七个内置工具全部补齐（wecom-webhook：字符串或 `{ content: string|object, mentions?: string[] }` 等）。console-api 原样透传。
3. **缓存清理**：`POST /api/cache/clear`（仅 admin）→ 清空 `{workspace}/cache/assets/`（asset-registry 加 `clearCache()`：删 cacheRoot 下全部内容）。响应 `{ cleared: true }`。行为写入文档：清理后已创建业务下次 run 时触发重新物化+构建（懒重建），可能耗时分钟级。
4. **webhook path 查重**：业务写校验追加——`source='webhook'` 行的 `entry_config.path` 全平台唯一（跨业务）。实现用 `registry.list()`（BusinessProfile 含 matches 含 entry_config，已存在）全量扫描比对，**不需要 registry 加新方法**。

### 8.2 console

1. **业务编辑页·入口区**：MatchEditor 升级——选定 source 后，下方渲染该适配器的 eventDoc（markdown 展示：事件类型 + payload schema + 示例）；source 有 configSchema 的（webhook/jira-polling），entry_config 从裸 JSON 文本域升级为按 configSchema 生成的表单项（secret 引用项标注「填 secrets 键名」）。裸 JSON 输入保留为折叠的高级模式。
2. **内部入口引导**：source 选 `internal` 时提供「上游业务」下拉（现有业务列表）+ 结果类型（completed/failed）选择，自动生成 `event_type={business_id}.completed|failed`；提示文案说明「payload 为上游业务 sdk.return 的 output 原样」。手填模式仍可用。
3. **业务编辑页·出口区**：选定出口工具后下方渲染其 resultDoc。
4. **设置页**：加「清理资产缓存」按钮（confirm 弹窗说明后果：下次 run 重新物化构建、可能耗时数分钟），调 §8.1.3。
5. **业务创建校验放行**：纯 internal 匹配行（无外部适配器入口）的业务合法——实现时确认后端无「至少一个外部入口」限制，有则放行。

## 9. sdk README 完整文档（T21d，`packages/sdk/README.md`）

npm 发布后的开发者主文档，目标：人或其他 AI 只读此文档即可开发出合格业务包。章节：

1. 业务包在平台中的位置与运作原理（一入一出契约四条、双事件循环、结果扇出投递、run 隔离模型）
2. 全 API 逐个说明 + 示例（input/runInput/config/secret/dataDir/agent/session/run/log/return/fail）
3. config/secrets 自定义 key 规则（github/jira 账号等机密都走 secrets，key 名业务自定）
4. skill：编写/注册资产/绑定/共享/可见性
5. tool：同上 + sdk.run 调用 + 包内程序直接 import 的取舍
6. 入口事件 schema 对照（各内置适配器 eventDoc 的镜像）/ 出口 result schema 对照（各工具 resultDoc 镜像）/ 对接上游业务（internal 事件）
7. run 生命周期：workspace（per-run 临时）vs dataDir（业务级持久）、env 清空、超时与配额、agent 会话 channel/fresh
8. 本地开发与独立运行（模板、mock 信封、六连检查）
9. 版本兼容政策（contract_version 护栏）
10. FAQ + 完整参考实现（单轮审查工单端到端 walkthrough）

## 10. 自检与配置补充（T21a/T21b）

- 自检追加：npm 可用（`npm --version` 可执行）；npm registry 可达（HEAD，3s 超时；地址 = `AGENT_NPM_REGISTRY`，默认 `https://registry.npmjs.org/`）。缺失/不可达 → 拒启动并明确提示。
- 新配置键汇总（均 env > config.json > 默认）：`AGENT_WEBHOOK_PORT`（默认 6200）、`AGENT_NPM_REGISTRY`（默认官方）、`AGENT_ENTRY_WEBHOOK_ENABLED`（默认 true）、`AGENT_ENTRY_JIRA_POLLING_ENABLED`（默认 false）。

## 11. 设计文档回写清单（T21d）

- `design/asset-model.md`：物化流程（§4 全文：双脚本 + 初始化脚本必带 + 语言/环境边界口径）、「sdk 注入」表述删除改「普通 npm 依赖」、缓存清理入口。
- `design/business-workflow.md`：sdk API 清单补 dataDir；「sdk bundle 注入」表述清除。
- `design/console-design.md`：出入口自描述展示、内部入口引导、缓存清理按钮。
- `design/scheduler-loop-contracts.md`：出口 null 跳过语义。
- `design/glossary.md`：按需补「物化」「agent.materialize.mjs」「dataDir」词条。
- `docs/specs/2026-09-29-t15-package-template-spec.md`：初始化脚本必带的修订注记（spec 是历史记录，加修订说明不改正文）。

## 12. 测试清单（最低线）

**T21a**

- asset-registry：package 资产物化全链路（npm ci + 业务初始化脚本执行 + 产物校验，fixture 用零依赖本地 git 仓）；含 package.json 缺 package-lock.json 失败；package/tool 资产缺 agent.materialize.mjs 失败；脚本 exit≠0 失败（消息含 stderr 尾部）；产物缺失失败（消息含缺失清单）；skill 资产不要求脚本不构建；平台物化脚本可独立 CLI 执行（同 fixture 手动跑通）
- workflow-runner：信封含 dataDir 且目录已建（三维路径）；sdk.run 子程序信封不含 dataDir
- sdk：dataDir() 正常返回；缺失抛错
- scheduler：payload=null 的出口任务 complete 不投递（不调 driver）；payload 非 null 照常投递

**T21b**

- webhook：200 落队（信封字段逐项断言）/401/400/404；event_id 重推幂等；session_id_key 点分提取；token_key 验签（secrets 桶取值）；registry 变更即时生效（加行业务新 path 立即可投）
- jira-polling：事件产出形状（event_id/session_id/payload 轻量字段）；轮询器随 match 行增删；防重入；jira 客户端用本地 mock HTTP（表单登录 → search 两段）
- 开关：关闭的适配器不启动、配置缺失不报错；开启的缺配置拒启动

**T21c**

- console-api：/api/config 含 entry_adapters 与 resultDoc；缓存清理 admin 限定 + 目录清空；webhook path 查重 400
- console：入口区 eventDoc 渲染、configSchema 表单生成、internal 引导生成 event_type、出口区 resultDoc 渲染、设置页清理按钮

**T21d**：sdk README 覆盖 §9 十章节（文档走查，非自动化）

## 13. 验收

- 每批次：该包/app 六连全绿 + 本 spec 测试清单逐条过
- 整体：根六连全绿；T21 全部完成后，模板包经「file:// 本地 git 仓登记 → 创建业务绑定 → 物化构建成功」的集成路径可跑通（mock 入口事件）。前提：`@asteriskzuo/agent-sdk` 已发布 npm（模板 npm ci 需从 registry 解析）；未发布时用 `scripts/verify-template.sh` 的 `file:` 改写兜底。

## 14. 范围外

- 沙箱隔离（设计已定第二阶段）；出口重试参数调优；适配器插件化（业务自定义入口/出口代码托管）；异步物化任务化（v1 同步阻塞）
