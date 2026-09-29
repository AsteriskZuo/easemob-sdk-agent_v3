# T9 exit-tools 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/scheduler-loop-contracts.md` §6、`design/channel-model.md` §2。

## 1. 目标

产出 `@easemob/agent-exit-tools` 包：**出口工具注册表 + 全部七个内置出口工具的登记**——其中三个本任务实现（企微群 webhook / 邮件 / 自定义 webhook），四个以**占位**形式登记（企微智能机器人 / github / jira / confluence，调研后后续任务补实现）。出口工具相互独立、互不依赖，占位与实现只影响自身。出口事件循环（T8 已完成）经 `ExitDriver` 间接调用本包；控制台（T14）用注册表菜单渲染配置表单。

## 2. 背景知识（执行所需的最小上下文）

- **出口不过 LLM**：业务产出（派生事件的 payload）即投递内容，出口不做内容加工，只做格式化承载。
- **destination_id**：投递目标标识，出口 channel_id = `exit__<destination_id>` 的第二维——同目标串行保序、天然限流。它由工具的 `destinationOf` 从绑定配置提取，**只能来自非机密配置**（派发期拿不到机密项），且必须文件路径安全（不含 `/` `\` `:` 及控制字符）。
- **各工具的 destination_id 提取规则**（扩展契约，占位工具后续实现时按此执行）：

  | 工具 kind | destination_id | 串行效果 |
  |-----------|----------------|---------|
  | `wecom-webhook` | webhook 地址的 key 段 | 同群串行 |
  | `mail` | 收件人地址 | 同收件人串行 |
  | `webhook` | 目标地址规范化（去协议头，`:`/`/` → `_`） | 同地址串行 |
  | `wecom-aibot` | 机器人 id + 会话 id + 用户 id | 同人对同机器人串行 |
  | `github` | 仓库地址规范化（去协议头与 `.git`，`:`/`/` → `_`） | 同仓库串行 |
  | `jira` | 站点 + 工单 key | 同工单串行 |
  | `confluence` | 站点 + 页面标识 | 同页面串行 |

- **配置分两半**：`ExitBinding.config` 存非机密项（registry 包已落库）；机密项（密码、token）由装配根（T12）从 EnvProvider 解析后**合并进 config 再调 bind**——本包 bind 收到的就是完整配置，不感知来源。
- **失败语义**：deliver 抛错 = 投递失败，调度循环按有界重试处置（重试逻辑在 T8，本包只管"成功返回 / 失败抛错"）。
- 运行时环境：Node 24，全局 `fetch` 可用。

## 3. 范围与不做清单

**本任务做**：`ExitTool`/`Exit`/`ExitRegistry`/`ConfigField` 类型 + `createExitRegistry`（登记七个工具）+ 三个工具实现（wecom-webhook / mail / webhook）+ 四个占位工具（wecom-aibot / github / jira / confluence）。

**本任务不做**：

- 四个占位工具的真实投递实现（未经调研不做，后续单独任务，按本包模式加一个文件 + 改注册一行）；
- 投递重试、死信、日志（归调度循环）；凭证解析（归装配根）；控制台 UI（T14 消费 configSchema）。

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
│   └── placeholders.ts     # 四个占位工具
└── tests/
    ├── registry.test.ts
    ├── wecom-webhook.test.ts
    ├── mail.test.ts
    └── webhook.test.ts
```

工程约定同 T0 spec §4。`dependencies`：`nodemailer`（SMTP 发送，见 §9-B）；devDependencies 另加 `@types/nodemailer`。不依赖任何 workspace 包。

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
  readonly implemented: boolean;    // false = 占位（菜单可见但不可实际投递；控制台据此置灰/标记）
  readonly configSchema: ConfigField[]; // 配置项声明，控制台据此渲染表单；占位工具为空数组（待定）

  /** 投递目标标识：从非机密配置提取——出口 channel_id 的第二维。
   *  必须文件路径安全；配置缺失/非法抛错（该绑定将被调度循环判失败）。
   *  占位工具调用即抛「未实现」 */
  destinationOf(config: Record<string, string>): string;

  /** 用完整配置（含已合并的机密项）实例化出口；required 项缺失即抛错。
   *  配置由实例持有，deliver 不再传。占位工具调用即抛「未实现」 */
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
  /** 全部内置工具（含占位），控制台菜单 */
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

### 5.6 占位工具（placeholders.ts）

```ts
/** 占位工具工厂：菜单登记用，真实实现待调研后补（后续任务）。
 *  destinationOf / bind 调用即抛 Error(`出口工具 '<kind>' 尚未实现`)；
 *  destination_id 提取规则按 §2 表执行（实现时的契约） */
export function createPlaceholderExitTool(kind: string, name: string): ExitTool;
```

登记四个：`wecom-aibot`（企业微信智能机器人）、`github`（GitHub 操作）、`jira`（Jira 操作）、`confluence`（Confluence 操作）。

## 6. 测试清单

HTTP 类用例用 `node:http` 起本地服务器断言请求，不发真实外部请求；mail 用注入的假 transport。

**registry.test.ts**：list 返回七个工具（三个 `implemented: true`，四个占位 `implemented: false` 且 configSchema 为空）；get 命中；get 未知 kind 抛错；占位的 destinationOf/bind 抛「未实现」。

**wecom-webhook.test.ts**：
- destinationOf 从合法 url 提取 key；无 key / 非法 url → 抛错；
- deliver：字符串 payload → 请求体 msgtype=markdown、content 原样；对象 payload → json 围栏；
- 超长 payload（>4000 字节）→ content 截断且含 `已截断`；
- 服务器返回 `{"errcode":93000,"errmsg":"..."}` → 抛错；网络层非 2xx → 抛错；
- bind 缺 url → 抛错。

**mail.test.ts**：
- destinationOf = to；
- deliver 调用 transport 的 sendMail，from/to/subject/text 正确（对象 payload 走 json 文本）；
- sendMail 拒绝 → deliver 抛错；
- bind：port 非法 → 抛错；缺 required 项 → 抛错；`port: '465'` → secure=true（用捕获 config 的假 createTransport 断言）。

**webhook.test.ts**：
- destinationOf 规范化：去协议、`:`/`/` → `_`（含端口例）；非法 url → 抛错；
- deliver：body 为 payload 原样 JSON、Content-Type 正确；带 token → Authorization 头正确；无 token → 无该头；
- 服务器返回 500 → 抛错；
- bind 缺 url → 抛错。

## 7. 验收标准

1. 包级 `build`/`test` 与根级六项检查全绿；
2. §6 测试清单全覆盖；测试不发真实外部网络请求；
3. 导出签名与本文 §5 一致；除 nodemailer 外无其他运行时依赖；
4. 全包无 `process.env`、无全局单例。

## 8. 导出清单（index.ts）

- 值：`createExitRegistry`、`postJson`、`createPlaceholderExitTool`
- 类型：`ConfigField`、`ExitTool`、`Exit`、`ExitRegistry`
- 已实现工具工厂（供定制/测试注入）：`createWecomWebhookExitTool`、`createMailExitTool`、`createWebhookExitTool`

## 9. 本规格的裁决点（设计文档未覆盖，主 agent 已定）

- **A. 七个工具全登记、三个实现四个占位**：占位 = `implemented: false` + 空 configSchema + destinationOf/bind 抛「未实现」。菜单完整可见（控制台可置灰），目的地提取规则以 §2 表为扩展契约。占位工具的补实现是独立后续任务，不动本包其他代码。
- **B. 邮件用 nodemailer**：全仓第一个外部运行时依赖——SMTP 握手/TLS/认证手写代价高且易错，nodemailer 成熟、零传递依赖。mail 工具经 createTransport 注入点保持可测试。
- **C. 企微 webhook 的 url 归非机密配置**：destination_id（key 段）设计上就会出现在 channel_id 与日志中，把 url 当机密无法自洽；它是只写能力凭证，风险可接受。
- **D. 投递内容渲染最小化**：字符串原样、对象走 json 围栏/文本；企微 4096 字节上限按字节截断。不做模板、不做富文本排版。
- **E. 超时固定 10s**（postJson 默认）：投递失败交给调度循环重试，不在工具内做重试。
