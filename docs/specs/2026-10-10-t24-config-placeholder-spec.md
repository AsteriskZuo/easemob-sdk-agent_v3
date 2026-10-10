# T24 spec：入口/出口配置统一占位符（{{key}}）机制

- **日期**：2026-10-10
- **状态**：已实现（2026-10-10，用户审通过后落地）
- **决策来源**：2026-10-09 ~ 2026-10-10 讨论结论——入口和出口共用一套 value 级占位机制；平台不知道也不需要知道"哪些字段敏感"，用户自己决定哪段值用占位、占位 key 放哪个桶；key 保持静态契约（不做 key 占位）；不用 YAML；入口/出口配置 UI 均为表单/JSON 双视图

## 1. 背景

当前入口/出口的敏感参数各有一套私有约定，平台因此耦合了每个适配器/工具"哪些字段是敏感的"这一业务细节：

| 位置 | 现状约定 | 问题 |
| ---- | -------- | ---- |
| jira-polling 入口 | `username_key` / `password_key` 存 secrets 键名引用，适配器自己去桶里取真值 | 字段语义是"键名"不是"值"，用户要在两处建立心智映射；缺 redirect 网关凭据字段（JiraClient 已支持，配置层打不通） |
| webhook 入口 | `token_key` 存 secrets 键名引用 | 同上 |
| 出口工具 | `configSchema` 标 `secret: true` 的字段不写 binding.config，控制台按派生键 `exit.{kind}.{field}` 写安全桶，exit-driver 投递前回填（`app/server/src/exit-driver.ts` 的 `exitSecretKey`） | 平台内置了"哪个工具哪个字段敏感"的硬编码规则；用户无法自选存储桶；新增工具要平台配合改约定 |

统一后：**配置值中任何位置可写 `{{key}}`，平台在派发/使用前统一解析为环境配置（两桶 × 两级）里的真值**。平台只认占位语法，不认字段语义。

## 2. 范围

**做**：

- `packages/runtime` 新增占位符解析模块 + `EnvProvider.lookup`
- 入口侧：jira-polling 配置重构（含补 redirect 字段）、webhook `token_key` → `token`
- 出口侧：exit-driver 删 `exitSecretKey` 回填改占位解析；`destinationOf` 保持吃未解析配置（含占位时的目标标识规则）
- console-api：保存业务/匹配行/出口绑定时校验占位 key 存在性（fail fast）
- console：入口 MatchEditor、出口绑定编辑区改为表单/JSON Tab 双视图
- 文档回写与测试

**不做（范围外）**：

- 递归解析（占位符的值里再有 `{{}}` 不二次展开）
- key 占位（`{{}}` 只允许出现在 value）
- YAML 配置（存储层本就是 JSON）
- 业务包程序内 sdk 读取环境配置的行为——sdk 侧 `sdk.env` 不变（业务代码拿到的本就是解析后的桶值，占位机制只作用于适配器/出口工具的配置）
- 兼容层：破坏性变更直接切换（存量只有开发环境，见 §8）

## 3. 占位符机制（packages/runtime）

### 3.1 语法

- 形态：`{{key}}`，只出现在配置 **value**（字符串）中；一个 value 可含 0..n 个
- key 约束：trim 后非空、不含 `{`/`}`；合法 key 与原样匹配环境配置的键名
- 两种用法等价合法，按值的性质自选（约定写进文档）：
  - 整值占位：`"url": "{{wecom_webhook_url}}"` —— 值整体是敏感凭据时
  - 内嵌占位：`"url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={{wecom_key}}"` —— 结构公开稳定、只有一段敏感时（自解释：配置里看得出这是什么出口）
- 替换是纯字符串替换，**不做 URL 编码**——占位值本身必须是合法的最终片段
- 不递归：替换进来的值里再出现 `{{}}` 不二次展开（防循环、防注入放大）

### 3.2 查找顺序

`EnvProvider` 新增方法：

```ts
/** 占位符解析专用：按 业务 secrets → 业务 vars → 全局 secrets → 全局 vars 顺序取第一个命中；
 *  全缺返回 undefined。与 getFor 的桶内合并语义不同——这里 secrets 优先于 vars（就近+机密优先） */
lookup(business_id: string, key: string): string | undefined;
```

顺序理由：业务级优先于全局级（与既有"业务覆盖通用"一致）；同级的 secrets 优先于 vars（同名 key 放安全桶的意图应胜出）。

**隔离底线**：不同业务的 key 名可以相同（如都叫 `jira_password`），解析必须严格落在发起方的 `business_id` 上——入口侧用 match 行的 `business_id`、出口侧用 binding 的 `business_id`，绝不串业务桶；全局层只是兜底，不是共享（同名时业务值永远胜出）。测试须覆盖「两业务同名 key 不同值」场景。

### 3.3 解析入口

```ts
// packages/runtime/src/placeholder.ts（新文件）

/** 解析配置对象所有字符串值中的 {{key}} 占位；浅层（第一层 value 为字符串才处理，
 *  非字符串原样透传）。缺失 key 抛 PlaceholderError，message 列出缺失键名（不含任何值） */
export function resolveConfigPlaceholders(
  config: Record<string, unknown>,
  env: EnvProvider,
  business_id: string,
): Record<string, unknown>;

/** 提取配置中全部占位 key（去重、排序）；保存时校验用（只验存在性，不解析值） */
export function extractPlaceholderKeys(config: Record<string, unknown>): string[];

/** 占位解析失败错误：message 含缺失 key 列表；keys 字段结构化携带 */
export class PlaceholderError extends Error {
  readonly keys: string[];
}
```

### 3.4 secrets 纪律

- 解析结果只在调用方内存中使用；平台任何日志不打印解析后的配置
- `PlaceholderError` 只携带 key 名，绝不携带值

## 4. 入口侧改造

### 4.1 jira-polling

`entry_config` 字段重构（`JIRA_POLLING_ADAPTER_SPEC.configSchema` + `parseJiraEntryConfig`）：

| 字段 | 必填 | 说明 |
| ---- | ---- | ---- |
| `jira_url` | 是 | 站点根地址（可占位） |
| `username` | 是 | 登录账号（可占位，建议 `{{jira_username}}`） |
| `password` | 是 | 登录密码（可占位，建议 `{{jira_password}}`） |
| `redirect_username` | 否 | 网关 Basic 账号（可占位）——**新增**，打通 JiraClient 已有的 redirectUsername |
| `redirect_password` | 否 | 网关 Basic 密码（可占位）——**新增** |
| `project` | 是 | 项目 key（可占位） |
| `assignees` / `days_back` / `interval_seconds` | 否 | 不变（可占位，解析后按原规则收敛） |

- 删除 `username_key` / `password_key`
- `JiraPoller.run()`：`resolveConfigPlaceholders(entry_config)` → `parseJiraEntryConfig` → 建 client（带 redirect 凭据）。占位解析失败 = 配置非法，记 warn 跳过本轮（沿用既有「行配置是用户数据，不抛错」纪律）
- `eventDoc` 更新（凭据不再走键名引用，redirect 字段说明）

### 4.2 webhook

- `token_key` → `token`（可选，可占位）：验签直接用解析后的值比对 `x-webhook-token`
- 请求处理链在「path 路由命中 match 行」后先 `resolveConfigPlaceholders(row.entry_config)` 再验签/提取；解析失败 → 500 记 error（该行配置缺陷，非推送方问题）
- `eventDoc` 更新

## 5. 出口侧改造

### 5.1 exit-driver

- 删除 `exitSecretKey` 及回填循环（`app/server/src/exit-driver.ts`）
- `deliver`：`resolveConfigPlaceholders(binding.config, env, binding.business_id)` → `bind(resolved).deliver(payload)`。占位缺失抛 `PlaceholderError`，出口循环按配置类错误处置（有界重试耗尽死信，与现状语义一致）

### 5.2 destinationOf 保持吃未解析配置（关键决策）

`destinationOf(binding)` **不解析占位**，直接消费原始配置文本。理由：

- channel_id 明文嵌入 destinationId（`exit__{destinationId}`），解析后可能把 secret 泄进通道标识与日志
- 「同目标串行」的身份用占位模板文本计算即可——同模板 = 同目标；secret 轮换不重建通道（更稳定）

含占位时的目标标识规则（exit-tools 内集中实现一个 helper，各工具 `destinationOf` 共用）：

- 消费字段不含 `{{` → 走现有解析（行为不变）
- 消费字段含 `{{` → 目标标识 = `tpl_` + sha256(原始模板串) 前 12 位（合法字符集，过 `assertSafeSegment`；两绑定模板相同则同通道）

### 5.3 ConfigField.secret 语义降级

- `secret: true` 从「console 拆写安全桶 + driver 回填」降级为**纯 UI 提示**（表单渲染时提示"建议 `{{key}}` 占位、值存安全变量桶"）
- console 不再把 secret 字段拆写安全桶；**所有字段原样存 `binding.config`**（含占位文本）
- 各出口工具 configSchema 字段不变；`resultDoc`/示例更新（wecom-webhook 示例改为 `...?key={{wecom_key}}`）

## 6. 保存时校验（console-api，fail fast）

写 `entry_config` / `exit_bindings` 的全部路由（POST/PUT businesses、POST matches 等，`routes-businesses.ts`）在现有 DTO 校验后追加：

1. `extractPlaceholderKeys` 提取全部占位 key
2. 存在性校验：key 须在 业务 secrets ∪ 业务 vars ∪ 全局 secrets ∪ 全局 vars 四个键名集合之一中（用 `env.list(business_id)` + `env.list(null)`，只看键名不读明文）
3. 有缺失 → `invalid_input`，message 列出缺失 key 及提示（"请先在业务/通用环境配置中创建对应键"）

只验存在性、不解析值；校验失败不落库。

## 7. 控制台 UI（app/console）

### 7.1 MatchEditor（入口）

- 现有「表单 + 折叠裸 JSON」改为 antd **Tabs**：「表单」/「JSON」
- 两个视图编辑同一份 `entry_config_text`（唯一事实源不变）：表单编辑经 `withEntryConfigValue` 回写 JSON 文本；JSON 视图即现有 textarea
- JSON 非法时禁止切回「表单」Tab（Tab disabled + 现有 Alert 提示）
- 表单字段的 placeholder 文案按 §4 新字段更新，敏感字段提示"可填 `{{key}}` 占位"

### 7.2 出口绑定编辑区

- 同构 Tabs：「表单」/「JSON」，编辑同一份绑定 config
- `secret: true` 字段提示改为："建议填 `{{key}}` 占位，真值存安全变量桶（本页面上方「环境配置」）"
- JSON 视图预填模板含占位示例（如 wecom-webhook 的 `{"url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={{wecom_key}}"}`）

## 8. 破坏性变更与迁移

不做兼容层（存量只有开发环境，用户已确认）。具体变化与影响：

| 变更 | 存量影响 | 迁移动作 |
| ---- | -------- | -------- |
| 删 jira `username_key`/`password_key` | 旧 entry_config 解析失败 → 轮询记 warn 跳过（不崩溃） | 控制台重新保存入口配置 |
| 删 webhook `token_key` | **旧配置等于未配置 token = 不再验签**（安全语义变化，显式声明） | 控制台重新保存为 `token` 字段 |
| 删 `exitSecretKey` 回填 | 旧绑定 config 缺 secret 字段（当初没存）→ bind 校验抛错 → 重试耗尽死信 | 控制台重新保存出口绑定；安全桶里 `exit.{kind}.{field}` 键成孤儿，可手动删 |
| console 不再拆写 secret 字段 | 新保存的绑定 config 含全部字段（占位文本） | 无 |

## 9. 文档回写

- `docs/specs/2026-09-29-t8-scheduler-spec.md`：出口机密回填段落改为占位解析
- `docs/specs/2026-09-30-t16-package-registry-spec.md` / `t17-runtime-spec.md`：涉及 entry_config 键名引用的段落
- `docs/specs/2026-10-05-t13-console-api-spec.md`、`2026-10-07-t14-console-spec.md`：保存校验与 UI 双视图
- `docs/specs/2026-10-08-t21-platform-landability-spec.md`：入口适配器配置示例
- 业务仓 `business/jira-ticket-review/平台配置指南.md`：入口匹配行字段、出口 url 占位示例（独立提交）

## 10. 测试

- `runtime`：lookup 四级顺序与覆盖、resolve 整值/内嵌/多占位、缺 key 报错（message 不含值）、不递归、非字符串透传
- `entry-adapters`：jira-poller 占位解析 + redirect 凭据传递；webhook token 占位验签
- `exit-driver`：deliver 前解析；destinationOf 含占位 → `tpl_` 哈希身份、不含占位 → 行为不变
- `console-api`：保存校验（缺失 key 拒绝、四桶命中放行、全局桶命中放行）
- `console`：Tabs 切换同步、JSON 非法禁止切回
- 回归：根目录六连全绿

## 11. 任务依赖

- 依赖：T23 已完成（jira-client 已发布，redirect 凭据参数现成）
- 被依赖：T22 真机验证（平台配置指南按本 spec 新形态重写后，用户手动验证）
- 无代码级并行冲突；console 与 console-api 可并行实现
