# T9 exit-tools 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/scheduler-loop-contracts.md` §6、`design/channel-model.md` §2。
>
> **2026-10-03 更新**：四个占位工具（wecom-aibot / github / jira / confluence）已由后续任务补全为真实实现，本文同步更新为最终实现态。四个工具的实现依据见 `docs/researches/wecom-aibot-send/`、`docs/researches/github-exit/`、`docs/researches/jira-write-ops/`、`docs/researches/confluence-rest/`（均含 2026-10-03 真实验证记录）。

## 1. 目标

产出 `@easemob/agent-exit-tools` 包：**出口工具注册表 + 全部七个内置出口工具的真实实现**（企微群 webhook / 邮件 / 自定义 webhook / 企微智能机器人 / github / jira / confluence）。出口工具相互独立、互不依赖。出口事件循环（T8 已完成）经 `ExitDriver` 间接调用本包；控制台（T14）用注册表菜单渲染配置表单。

## 2. 背景知识（执行所需的最小上下文）

- **出口不过 LLM**：业务产出（派生事件的 payload）即投递内容，出口不做内容加工，只做格式化承载。
- **destination_id**：投递目标标识，出口 channel_id = `exit__<destination_id>` 的第二维——同目标串行保序、天然限流。它由工具的 `destinationOf` 从绑定配置提取，**只能来自非机密配置**（派发期拿不到机密项），且必须文件路径安全（不含 `/` `\` `:` 及控制字符，本实现统一将这些字符替换为 `_`）。
- **各工具的 destination_id 提取规则**（实际实现行为）：

  | 工具 kind | destination_id | 串行效果 |
  |-----------|----------------|---------|
  | `wecom-webhook` | webhook 地址的 key 段 | 同群串行 |
  | `mail` | 收件人地址 | 同收件人串行 |
  | `webhook` | 目标地址规范化（去协议头，`:`/`/` → `_`） | 同地址串行 |
  | `wecom-aibot` | `bot_id + '__' + chat_id + '__' + user_id` | 同人对同机器人串行 |
  | `github` | 仓库地址规范化（两阶段解析：https/ssh 协议与 scp 语法 `git@host:owner/repo`；去 `.git` 与尾斜杠、小写；`owner/repo` 简写补 `github.com`；输出 `host_owner_repo`） | 同仓库串行 |
  | `jira` | `站点 host + '__' + (issue_key ?? project)`——绑定具体工单取工单 key，仅按项目创建取 project key（创建型操作投递前无 key 的适配） | 同工单/项目串行 |
  | `confluence` | `站点 host + '__' + space_key + '__' + page_title`（创建型操作无页面 id，以 space+title 定目标） | 同页面串行 |

- **配置分两半**：`ExitBinding.config` 存非机密项（registry 包已落库）；机密项（密码、token）由装配根（T12）从 EnvProvider 解析后**合并进 config 再调 bind**——本包 bind 收到的就是完整配置，不感知来源。
- **失败语义**：deliver 抛错 = 投递失败，调度循环按有界重试处置（重试逻辑在 T8，本包只管"成功返回 / 失败抛错"，工具内不做重试——confluence 409 版本冲突、github 无幂等键导致的重复，均交给调度循环语义，工具不兜）。
- 运行时环境：Node 24，全局 `fetch` 可用；github 工具依赖宿主机 `gh` CLI（≥ 2.x 已登录）。
- **统一工具类模式**（2026-10-03 裁决，四工具一致）：各工具底层是**无业务知识的工具类**——构造注入、类内零 `process.env`、零全局单例、调用方（装配根）控生命周期、可在别的程序/平台直接复用；**每绑定一实例**（jira/confluence 是用户登录，不同业务可能用不同用户，这是不做跨业务单例的原因之一）。包内 `ExitTool` 实现只做薄适配：`bind(config)` 建工具类实例，`deliver(payload)` 按 op 翻译为工具类调用。

## 3. 范围与不做清单

**本任务做**：`ExitTool`/`Exit`/`ExitRegistry`/`ConfigField` 类型 + `createExitRegistry`（登记七个工具）+ 七个工具实现（wecom-webhook / mail / webhook / wecom-aibot / github / jira / confluence）。

**本任务不做**：

- 投递重试、死信、日志（归调度循环）；凭证解析（归装配根）；控制台 UI（T14 消费 configSchema）；
- wecom-aibot 的 SDK 连接属主（`AibotConnector`）——本包只定义 `AibotSender` 发送外观，由装配根注入；
- github 的 `gh` 安装与登录（宿主机/部署环境职责，bind 时 `assertUsable` 前置报错）。

## 4. 包结构

```text
packages/exit-tools/
├── package.json            # @easemob/agent-exit-tools
├── tsconfig.json
├── src/
│   ├── index.ts            # 导出清单见 §8
│   ├── types.ts            # ExitTool / Exit / ExitRegistry / ConfigField
│   ├── registry.ts         # createExitRegistry（登记七个工具）
│   ├── http.ts             # postJson 共用助手（超时、非 2xx 抛错）
│   ├── wecom-webhook.ts    # 实现
│   ├── mail.ts             # 实现
│   ├── webhook.ts          # 实现
│   ├── wecom-aibot.ts      # 实现（AibotSender 注入）
│   ├── github.ts           # 实现（GhCli，gh 子进程）
│   ├── jira.ts             # 实现（JiraClient）
│   └── confluence.ts       # 实现（ConfluenceClient）
└── tests/
    ├── registry.test.ts
    ├── wecom-webhook.test.ts
    ├── mail.test.ts
    ├── webhook.test.ts
    ├── wecom-aibot.test.ts
    ├── github.test.ts
    ├── jira.test.ts
    └── confluence.test.ts
```

工程约定同 T0 spec §4。`dependencies`：`nodemailer`（SMTP 发送，见 §9-B）；devDependencies 另加 `@types/nodemailer`。不依赖任何 workspace 包；wecom-aibot 不依赖 `@wecom/aibot-node-sdk`（发送能力经注入）。

## 5. 详细规格

### 5.1 类型（types.ts）

```ts
/** 配置项声明：控制台据此渲染表单；secret=true 的项不存入绑定配置，
 *  由控制台写入 EnvProvider、装配根 bind 前合并注入 */
export interface ConfigField {
  key: string;           // 配置键（bind 收到的 config 里的键名）
  label: string;         // 展示名（控制台表单 label）
  required?: boolean;    // 缺省 false；true 时 bind 校验缺失即抛错
  secret?: boolean;      // 缺省 false；true = 机密项（不落库进绑定、不进日志）
  placeholder?: string;  // 表单占位提示
}

/** 出口工具：内置投递器菜单的一项 */
export interface ExitTool {
  readonly kind: string;            // 标识，全平台唯一（如 'wecom-webhook'）
  readonly name: string;            // 展示名（如「企业微信群机器人」），控制台按它选用
  readonly implemented: boolean;    // 全部内置工具为 true
  readonly configSchema: ConfigField[]; // 配置项声明，控制台据此渲染表单

  /** 投递目标标识：从非机密配置提取——出口 channel_id 的第二维。
   *  必须文件路径安全；配置缺失/非法抛错（该绑定将被调度循环判失败） */
  destinationOf(config: Record<string, string>): string;

  /** 用完整配置（含已合并的机密项）实例化出口；required 项缺失即抛错。
   *  配置由实例持有，deliver 不再传 */
  bind(config: Record<string, string>): Exit;
}

/** 出口实例：已持有配置 */
export interface Exit {
  /** 投递业务产出（派生事件的 payload 原样）。成功返回；失败（网络/对端拒绝/超时）抛错 */
  deliver(result: unknown): Promise<void>;
}

/** 出口工具注册表：内置菜单的登记与取用 */
export interface ExitRegistry {
  /** 按 kind 取工具；未注册抛错 */
  get(kind: string): ExitTool;
  /** 全部内置工具，控制台菜单 */
  list(): ExitTool[];
}

/** 创建注册表（登记全部七个内置工具） */
export function createExitRegistry(): ExitRegistry;
```

### 5.2 共用助手（http.ts）

```ts
/** POST JSON。非 2xx 抛错（含状态码与响应片段）；默认 10s 超时（AbortSignal.timeout）。
 *  fetchImpl 可注入（测试用），缺省全局 fetch */
export function postJson(
  url: string,
  body: unknown,
  options?: { headers?: Record<string, string>; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<void>;
```

### 5.3 企微群 webhook（wecom-webhook.ts，kind = `'wecom-webhook'`，name = `企业微信群机器人`）

- configSchema：`url`（required，群机器人 Webhook 地址，形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>`）。
- `destinationOf`：从 url 的 query 提取 `key` 段（key 天然唯一标识一个群；它本就出现在 channel_id/日志中，属非机密）。url 非法或无 key → 抛错。
- `deliver`：POST 企微消息体 `{"msgtype":"markdown","markdown":{"content": <文本>}}`。文本生成：`result` 为字符串直接用，否则 `` ```json `` 围栏包裹的 `JSON.stringify(result, null, 2)`；**超长截断**：企微 markdown 上限 4096 字节，按 UTF-8 字节截到 4000 并追加 `\n…(已截断)`。响应 JSON 的 `errcode !== 0` → 抛错（含 errmsg）。

### 5.4 邮件（mail.ts，kind = `'mail'`，name = `邮件通知`）

- configSchema：`host`（required，SMTP 主机）、`port`（required，数字字符串）、`user`（required，SMTP 账号）、`pass`（required、**secret**，SMTP 密码/授权码）、`from`（required，发件地址）、`to`（required，收件地址）、`subject`（可选，缺省 `Easemob Agent 通知`）。
- `destinationOf`：`config.to`（同收件人串行）。
- `bind`：`port` 经 `Number()` 解析，非法抛错；`port === '465'` 时 `secure: true`，否则 false。
- `deliver`：经 nodemailer transporter `sendMail({ from, to, subject, text })`；text 生成规则同 §5.3 的文本生成（不含截断）。
- **可测试性**：工具工厂签名 `createMailExitTool(createTransport?: (config: Record<string, string>) => { sendMail(options: unknown): Promise<unknown> })`——缺省用 nodemailer 实现，测试注入假 transport，不发真实邮件。

### 5.5 自定义 webhook（webhook.ts，kind = `'webhook'`，name = `自定义 Webhook`）

- configSchema：`url`（required，目标地址）、`token`（可选、**secret**，Bearer 令牌）。
- `destinationOf`：url 规范化——去协议头，逐段把 `:` 与 `/` 替换为 `_`（如 `https://example.com:8443/hooks/a` → `example.com_8443_hooks_a`）。url 非法 → 抛错。
- `deliver`：POST JSON，body = `result` 原样（`JSON.stringify(result ?? null)`）；token 存在时带 `Authorization: Bearer <token>`。非 2xx → 抛错。

### 5.6 企微智能机器人（wecom-aibot.ts，kind = `'wecom-aibot'`，name = `企业微信智能机器人`）

- **连接模型**（2026-10-03 实测裁决）：企微强制同一 botId 单长连接，双连接互踢（被踢侧只收 `disconnected_event`，不自动重连）。因此本包**不持有 SDK 连接**；连接属主是装配根的 `AibotConnector`（按 botId 一个实例，本包不实现、不依赖 SDK），本包只消费发送外观。
- 类型与工厂：

```ts
/** 发送外观：由装配根的 AibotConnector 实现（内部转 SDK sendMessage） */
export interface AibotSender {
  send(chatId: string, markdownContent: string): Promise<void>;
}

/** 工厂：resolveSender 由装配根注入（按 bot_id 匹配连接属主）；缺省抛错 */
export function createWecomAibotExitTool(options?: {
  resolveSender?: (botId: string) => AibotSender;
}): ExitTool;
```

- configSchema：`bot_id`（required，向装配根匹配连接属主）、`chat_id`（required，会话 id，**必须来自真实交互**——用户须先与机器人会话才能主动推送）、`user_id`（required，用户 id）。
- `destinationOf`：`bot_id + '__' + chat_id + '__' + user_id`（三段 trim；`/ \ :` 与控制字符替换为 `_`）；缺任一段抛错。
- `bind`：校验三段 required 后**立即**调 `resolveSender(bot_id)` 并持有 sender（deliver 不再解析）；未注入 resolveSender → 抛错。
- `deliver`：文本生成同 §5.3（字符串原样 / 对象 json 围栏）；**按 UTF-8 字节截断到 20480**（aibot sendMessage 的 markdown 上限，与 webhook 的 4096 不同），超长追加 `\n…(已截断)`；`sender.send(chat_id, content)`。

### 5.7 GitHub 操作（github.ts，kind = `'github'`，name = `GitHub 操作`）

- **通道裁决**（2026-10-03）：经 **`gh` CLI 子进程**操作，不直接调 REST API。已实测 gh 2.83.2 + 登录态全链路可用（repo view / clone / issue create+comment+close / pr create+comment+close+删分支，见 `docs/researches/github-exit/`）。服务化/容器化部署需注入 `GH_TOKEN`（未登录时 gh 会走交互授权挂起）。
- 类型与工具类：

```ts
/** gh 子进程抽象：非零退出抛错（含 stderr 片段）；resolve 值为 stdout */
export type GhRunner = (
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

/** 无业务知识工具类：构造注入 runner/repo/env（如 GH_TOKEN），类内零 process.env */
export class GhCli {
  constructor(options: { runner: GhRunner; repo: string /* owner/repo 形态 */; env?: Record<string, string> });
  assertUsable(): Promise<void>;        // gh --version + gh auth status（bind 后首次 deliver 前惰性执行一次）
  createIssue(title: string, body?: string): Promise<void>;
  addComment(number: number, body: string): Promise<void>;   // issue/PR 同端点
  createPullRequest(title: string, body?: string, options?: { head?: string; base?: string }): Promise<void>;
  cloneRepo(dir: string): Promise<void>;
}

/** 工厂：createRunner 可注入（测试用假 runner，不发真实子进程）；缺省 execFile 实现
 *  统一注入 GH_PROMPT_DISABLED/NO_COLOR/GH_NO_UPDATE_NOTIFIER=1 防交互挂起 */
export function createGithubExitTool(options?: {
  createRunner?: (env?: Record<string, string>) => GhRunner;
  ghPath?: string;
}): ExitTool;
```

- configSchema：`repo`（required，仓库地址，支持 https / `ssh://` / scp 语法 `git@host:owner/repo` / `owner/repo` 简写）、`token`（可选、**secret**，注入子进程环境 `GH_TOKEN`）。
- `destinationOf`：仓库地址归一化（算法见 §2 表），输出 `host_owner_repo`；非法形态（单段、不支持协议）抛错。
- `bind`：校验 repo；token → env；构造 GhCli（assertUsable 惰性挂首次 deliver）。
- `deliver` payload（op 判别，缺一即抛错并列出合法形态）：
  - `{ op: 'issue', title, body? }` → 建 issue；
  - `{ op: 'comment', number, body }` → 评论（issue/PR 通用）；
  - `{ op: 'pr', title, body?, head?, base? }` → 建 PR（分支须已推送）；
  - `{ op: 'clone', dir? }` → 下载代码到 dir（缺省 repo 末段名）。
  - body 为对象时渲染为 json 围栏文本。注意 github 无幂等键，重试可能重复建 issue——payload 应带稳定 dedupe key 写入 body（业务侧约定，工具不强制）。

### 5.8 Jira 操作（jira.ts，kind = `'jira'`，name = `Jira 操作`）

- **工具类**（移植自 v2 长期生产验证的 jira-client，见 `docs/researches/jira-write-ops/`）：

```ts
export interface JiraClientOptions {
  url: string;                    // Jira 站点地址
  username: string; password: string;            // 应用凭证（Jira 账号）
  redirectUsername?: string; redirectPassword?: string;  // 网关凭证（可选）
}

/** 认证链路：每请求带网关 Basic + login.jsp 表单登录取 cookie（id="login-form"
 *  优先、首个 form 兜底，hidden input 全量提取），实例持有会话；任一 REST 401 →
 *  清会话重登一次重试。redirect: manual，超时 15s */
export class JiraClient {
  constructor(options: JiraClientOptions);
  ping(): Promise<void>;                          // GET /rest/api/2/serverInfo
  addComment(issueKey: string, body: string): Promise<void>;   // POST /rest/api/2/issue/{key}/comment
  createIssue(fields: Record<string, unknown>): Promise<{ key: string }>; // POST /rest/api/2/issue
}

/** 工厂：createClient 可注入（测试用假 client） */
export function createJiraExitTool(options?: {
  createClient?: (config: Record<string, string>) => JiraClient;
}): ExitTool;
```

- configSchema：`url`（required，站点地址）、`project`（required，项目 key）、`issue_key`（可选，绑定到具体工单时填）、`username`（required，应用账号）、`password`（required、**secret**）、`redirect_username`（可选、**secret**，网关账号）、`redirect_password`（可选、**secret**，网关密码）。
- `destinationOf`：见 §2 表（`站点 host + '__' + (issue_key ?? project)`）；url 非法/缺项抛错。
- `bind`：校验 required 四项；构造 JiraClient（不在 bind 内预认证，deliver 自然走登录）。
- `deliver` payload：`{ op: 'comment', body: string | object }` 或 `{ op: 'create', fields: { summary: string, description?: string, ...extra } }`。
  - comment：目标 key = config.issue_key（缺失抛错）；body 字符串原样、对象走 json 围栏。
  - create：`fields = { project: { key: config.project }, summary, ...(description), ...extra }`（extra 透传自定义字段，如 `customfield_11901`，可覆盖 project/summary）；拿到新 key 后无返回通道（deliver 返回 void）。

### 5.9 Confluence 操作（confluence.ts，kind = `'confluence'`，name = `Confluence 操作`）

- **工具类**（认证链路为 2026-10-03 真实验证结论，见 `docs/researches/confluence-rest/`）：

```ts
export interface ConfluenceClientOptions {
  baseUrl: string; username: string; password: string;   // 应用凭证
  gatewayUsername?: string; gatewayPassword?: string;    // 网关凭证（可选）
  timeoutMs?: number;                                     // 缺省 30s（公网 SLB 偶发慢）
}
export interface PageRef { id: string; version: number; }

/** 认证链路：每请求带网关 Basic + /login.action 表单登录（name="loginform"，兜底
 *  id="login-form" → 首个 form；POST dologin.action，302 判定成功）取 seraph.confluence
 *  cookie；任一 REST 401 → 重登一次重试。注意与 jira 差异：登录页是 /login.action
 *  而非 /login.jsp（该实例 /login.jsp 404） */
export class ConfluenceClient {
  constructor(options: ConfluenceClientOptions);
  findPage(spaceKey: string, title: string): Promise<PageRef | undefined>; // GET /rest/api/content?type=page&spaceKey=..&title=..&expand=version
  createPage(spaceKey: string, title: string, xhtml: string): Promise<string>; // POST /rest/api/content，成功状态 200（非 201），返回 id
  updatePage(id: string, version: number, spaceKey: string, title: string, xhtml: string): Promise<void>; // PUT，body 携带 version:{number: version+1}；409 抛版本冲突错，不重试
}

/** 工厂：createClient 可注入（测试用假 client） */
export function createConfluenceExitTool(options?: {
  createClient?: (config: Record<string, string>) => ConfluenceClient;
}): ExitTool;
```

- configSchema：`base_url`（required，站点地址）、`space_key`（required）、`page_title`（required）、`username`（required）、`password`（required、**secret**）、`gateway_username`（可选、**secret**）、`gateway_password`（可选、**secret**）。
- `destinationOf`：见 §2 表（`host + '__' + space_key + '__' + page_title`，不安全字符替换 `_`）；缺 required 项抛错。
- `bind`：校验 required 项；构造 ConfluenceClient。
- `deliver` payload：`{ content: string | object }` 或直接字符串。**get-or-create**：content 对象先 `JSON.stringify(_, null, 2)`；统一 XML 转义（`& < >`）、`\n` → `<br/>`、包 `<p>`；`findPage` → 有则 `updatePage`（version 取查询值 +1）→ 无则 `createPage`。缺 content / 非对象非字符串抛错。

## 6. 测试清单

HTTP 类用例用 `node:http` 起本地服务器断言请求，不发真实外部请求；mail 用注入的假 transport；wecom-aibot 用注入的假 sender；github 用注入的假 runner（零真实子进程）。

**registry.test.ts**：list 返回七个工具且全部 `implemented: true`；get 命中；get 未知 kind 抛错。

**wecom-webhook / mail / webhook**：同 2026-09-29 版（本文件初版 §6，未变）。

**wecom-aibot.test.ts**（13 用例）：destinationOf 三段拼接与缺段抛错；bind 立即解析 sender（bot_id 正确）、缺省 resolveSender 抛错、解析器抛错透出；deliver 字符串原样 / 对象 json 围栏；>20480 字节截断（多字节中文不切断）且含「已截断」；sender 拒绝 → deliver 抛错。

**github.test.ts**（20 用例）：destinationOf 四形态归一化（https/ssh/scp/简写、大写、`.git`、尾斜杠）与非法抛错；bind 缺 repo 抛错；token → runner env.GH_TOKEN；四 op 的 gh args 数组精确匹配；body 对象 json 围栏；未知 op / 缺字段抛错；runner 非零退出透传；assertUsable 仅首次 deliver 前执行一次。

**jira.test.ts**（21 用例）：destinationOf host+key/project 与缺项抛错；deliver comment 路径与 body 渲染（字符串/对象）；create 的 fields 组装（project.key/summary/extra 透传）；登录失败抛错；REST 401 一次后自愈重登成功；服务器 500 抛错；注入假 createClient 验证 bind 传参映射（含 redirect_*）。

**confluence.test.ts**（21 用例）：destinationOf 组合与非法/缺项抛错；页不存在 → createPage（请求体与 XML 转义断言）；页已存在 → PUT version+1；字符串/对象 content；登录失败抛错；401 自愈；500 抛错；注入假 createClient 验证传参映射。

## 7. 验收标准

1. 包级 `build`/`test` 与根级六项检查全绿；
2. §6 测试清单全覆盖；测试不发真实外部网络请求、不 spawn 真实 `gh`；
3. 导出签名与本文 §5/§8 一致；除 nodemailer 外无其他运行时依赖（`gh` 为宿主机外部工具，非 npm 依赖）；
4. 全包无 `process.env`、无全局单例。

## 8. 导出清单（index.ts）

- 值：`createExitRegistry`、`postJson`
- 类型：`ConfigField`、`ExitTool`、`Exit`、`ExitRegistry`
- 已实现工具工厂（供定制/测试注入）：`createWecomWebhookExitTool`、`createMailExitTool`、`createWebhookExitTool`、`createWecomAibotExitTool`、`createGithubExitTool`、`createJiraExitTool`、`createConfluenceExitTool`
- 工具类（可复用，无业务知识）：`JiraClient`（+`JiraClientOptions`）、`ConfluenceClient`（+`ConfluenceClientOptions`、`PageRef`）、`GhCli`（+`GhRunner`）
- 工具类接口：`AibotSender`

## 9. 本规格的裁决点（设计文档未覆盖，主 agent 已定）

- **A. 七个工具全登记、全部真实实现**（2026-10-03 更新，原「三个实现四个占位」已落地补全）：四个补全工具各自一个文件 + registry 登记一行，互不依赖。
- **B. 邮件用 nodemailer**：全仓第一个外部运行时依赖——SMTP 握手/TLS/认证手写代价高且易错，nodemailer 成熟、零传递依赖。mail 工具经 createTransport 注入点保持可测试。
- **C. 企微 webhook 的 url 归非机密配置**：destination_id（key 段）设计上就会出现在 channel_id 与日志中，把 url 当机密无法自洽；它是只写能力凭证，风险可接受。
- **D. 投递内容渲染最小化**：字符串原样、对象走 json 围栏/文本；企微 4096 字节上限按字节截断。不做模板、不做富文本排版。
- **E. 超时固定 10s**（postJson 默认）：投递失败交给调度循环重试，不在工具内做重试。
- **F. 统一工具类模式**（2026-10-03，四工具）：无业务知识、构造注入、零 process.env、零全局单例、每绑定一实例、装配根控生命周期、可跨程序复用；出口侧仅薄适配。jira/confluence 是用户登录，不同业务可能用不同用户，是不做跨业务单例的原因之一。
- **G. jira 创建型 destination 适配**（2026-10-03）：spec §2 原契约「站点+工单 key」对「创建新工单」无 key 可用，落地为 `issue_key ?? project`——有 key 同工单串行，无 key 同项目串行（粒度变粗不影响正确性）。
- **H. confluence 创建型 destination 与 get-or-create**（2026-10-03）：以 `space_key + page_title` 定页面（页面 id 创建前不存在）；deliver 走「按标题查页 → 无则建 / 有则 version+1 更新」，更新遇 409 抛错不重试（归调度循环）。
- **I. github 走 gh CLI 而非 REST**（2026-10-03）：owner 指定 `gh` 为操作通道，已真实验证四链路（下载代码/提 PR/评论/建 issue）；token 经 GH_TOKEN 注入子进程；容器化部署需处理 gh 登录态。幂等仍无保证，业务 payload 应带 dedupe key 写入 body。
- **J. wecom-aibot 不持连接、发送外观注入**（2026-10-03）：企微单连接互踢已实测（`single-connection-verify.mjs`），入口/出口必须共享同一 SDK 实例；本包只定义 `AibotSender` 外观，连接属主 `AibotConnector`（按 botId 单实例）归装配根，实现见后续装配任务。截断阈值 20480 字节（aibot sendMessage markdown 上限，实测调研确认，非 webhook 的 4096）。
