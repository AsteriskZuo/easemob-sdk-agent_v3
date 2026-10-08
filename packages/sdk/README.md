# @asterisk/agent-sdk

智能体平台业务侧 SDK：**业务程序的唯一编程面**。本文档是业务开发者的主文档——读完本文即可开发出合格的业务包（人或其他 AI 均可）。

- 安装：`npm install @asterisk/agent-sdk`（普通 npm 依赖，平台不做任何注入；模板已内置，见 §8）
- 运行时：Node.js ≥ 24，ESM；SDK 运行时零第三方依赖
- 导出：`import { sdk } from "@asterisk/agent-sdk"`（单例对象）+ 类型 `RunInput` / `AgentCall`

---

## 1. 业务包在平台中的位置与运作原理

### 1.1 业务是什么

**业务 = 包 + 配置**。你交付的是一个 **包（package）**：一个 git 仓库（或仓库内子路径），内含流程程序入口与胶水代码；配置（入口、出口、skill/工具绑定、config/secrets、大模型选择等）由业务创建者在平台控制台登记。平台不认识你的业务内容，只做三件事：**登记**（git 三元组：url + commit + 子路径）、**物化**（clone 到缓存并构建，见 §8.4）、**执行**（事件触发时 spawn 你的流程程序）。

### 1.2 一入一出契约（四条，业务的全部约束）

平台与业务程序之间唯一的线是子进程契约，全部要求就四条：

1. **stdin 一段 JSON 进**：平台把信封（入口事件 + 注入上下文：workspace/config/secrets/endpoint/programs/dataDir）写入 stdin 后关闭（EOF 即输入结束）；SDK 同步一次性读取；
2. **stdout 一段 JSON 出**：`sdk.return(output)` / `sdk.fail(reason)` 写出唯一结果后进程退出；平台**只认第一个合法结果对象**，其后内容忽略；
3. **失败语义机械**：run 内任何一步失败 = 整体失败（`sdk.fail`、异常退出、超时、stdout 超限），平台打标 failed，**不重跑、不断点续跑**；
4. **日志走 `sdk.log`**：结构化行写 stderr，平台采集进该 run 的业务日志文件，secrets 源头脱敏。

不用 SDK 也能合规（其他语言：手写同一段 JSON 到 stdout 再退出），但 Node/TS 程序用 SDK 天然合规。

### 1.3 双事件循环与结果扇出

平台有两个调度循环：

- **入口事件循环**：入口适配器把外部事件包装成信封落入口队列 → 按 `(source, event_type)` 订阅匹配出关注业务 → 挂业务通道（`source__session_id__business_id`，**同通道严格串行**）→ spawn 你的流程程序执行；
- **出口事件循环**：你的 `sdk.return(output)` 产出后，平台派生 internal 事件（`event_type = {你的业务id}.completed`，payload = output 原样）**无脑扇出**到入口队列（下游业务订阅消化）与出口队列（按出口绑定投递：企微/邮件/webhook/jira/confluence/github）。

**业务代码里一行通知/投递代码都没有**：投递、投递重试（有界退避、耗尽死信）、结果扇出、下游触发，全部平台包办。

### 1.4 run 隔离模型

一次事件触发 = 一次 run = 一个独立子进程：

- 每 run 独立 **workspace**（隔离临时目录，进程 cwd，TTL 清理）与 **dataDir**（业务级持久目录，见 §7）；
- **环境变量清空注入**（`env: {}`）——平台环境不泄漏，凭据只走 stdin 的 secrets；
- 同 `{source, session_id, business_id}` 的 run 被通道串行化（同一会话的同一业务严格有序，跨通道并行）；
- 超时 wall-clock 强杀、stdout 上限 1MB、agent 调用次数配额服务端强制——任何业务错误不影响平台与其他业务。

### 1.5 平台已包办、业务不要重复造的事

| 事项 | 平台机制 |
| ---- | -------- |
| 事件接收与投递 | 入口适配器（webhook/jira-polling…）+ 出口工具（七个内置） |
| 投递重试 | 出口循环有界退避重试，耗尽死信 + 告警 |
| 日志采集 | `sdk.log` → stderr → 该 run 业务日志文件（secrets 脱敏） |
| 会话连续性 | `sdk.agent` 的 `mode: 'channel'` 自动恢复/绑定通道会话 |
| 入口幂等 | `event_id` 队列层唯一约束去重（源生重推自动丢弃） |
| 排队与串行 | 任务队列持久化 + 通道串行 + 并发闸门 |
| 结果扇出 | `sdk.return` 的 output 自动派生事件给下游与出口 |

业务语义级去重（如「同一工单同版本只审一次」）平台不代办——用 dataDir 自行实现（见 §7 与 §10 参考实现）。

---

## 2. SDK 全 API

一个业务进程 = 一次 run，`sdk` 是单例（无状态共享问题）。所有「读」API 共享同一份 stdin 信封（一次性读取并缓存）。

### 2.1 `sdk.input(): RunInput`

```ts
interface RunInput {
  event: unknown; // 触发信封（EventEnvelope 形状，见 §6.1）
  workspace: string; // 本 run 的隔离工作目录绝对路径（= 进程 cwd）
}
```

- **用途**：流程程序的入口——读触发事件与工作目录；
- **异常**：信封缺 `workspace`（平台注入必填）→ 抛错；stdin 是 TTY / 为空 / 信封非法（非 `contract_version:"v1"` 或无 `input`）→ 抛带原因的错；
- 本地调试用管道喂 mock 信封（§8.2）。

```ts
const { event, workspace } = sdk.input();
const { source, session_id, payload } = event as {
  source: string;
  session_id: string;
  payload: { issue_key?: string };
};
```

### 2.2 `sdk.runInput(): { input: unknown; config: Record<string, string> }`

- **用途**：**子程序侧**读口——被 `sdk.run` 调起的程序用它读调用方传入的 `input` 与 `config`（契约递归同构）；`config` 缺省返回 `{}`；
- 流程程序被平台调起时用 `sdk.input()`；同一个程序被 `sdk.run` 调用时用 `sdk.runInput()`——同一信封结构、两个视角。

```ts
// 工具程序（如 jira-fetch）内部
const { input, config } = sdk.runInput();
const { key } = input as { key: string };
const token = config.token; // 凭据由调用方显式传入（子程序拿不到 secrets）
```

### 2.3 `sdk.config(): Record<string, string>`

- **用途**：读本业务在控制台登记的非机密配置（普通桶）；无配置返回 `{}`；
- **取值**：key 名业务自定（见 §3）。

### 2.4 `sdk.secret(name: string): string`

- **用途**：读本业务安全桶变量（平台注入，业务不碰环境变量）；
- **异常**：该名未注入 → 抛错（`安全变量未注入：<name>`）；
- secrets 只注入流程程序；`sdk.run` 子程序拿不到（见 §2.8）。

```ts
const jiraToken = sdk.secret("jira_token"); // key 名业务自定
```

### 2.5 `sdk.dataDir(): string`

- **用途**：**业务级持久目录**绝对路径——跨 run 状态的落点（如审查去重记录 `review-records.json`）。平台 run 启动时已创建；同通道（`{source, session_id, business_id}`）的 run 天然串行，读写状态文件**无需自锁**；平台不做 TTL，业务自管容量与清理；
- **异常**：信封缺失 → 抛错。只有**平台→流程程序**注入；`sdk.run` 子程序拿不到（叶子无状态语义；子程序确需持久，由流程程序把路径经 `input` 传入）；本地 mock 信封没给 `dataDir` 时调用即抛错（mock 时自行补上）。

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const file = join(sdk.dataDir(), "review-records.json");
const records = existsSync(file)
  ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
  : {};
```

### 2.6 `sdk.agent(call: AgentCall): Promise<unknown>`

```ts
interface AgentCall {
  skills: string[]; // 本次注入的 skill 名（可多个、可跨 skill 集合）；均须在本业务绑定的 skill 集合内
  input: unknown; // 给大模型的内容（业务保证已脱敏）
  mode?: "channel" | "fresh"; // 缺省 'channel'
}
```

- **用途**：调大模型服务（unix socket 到平台 agent 服务；模型凭据平台持有，不进业务进程；run 级调用次数配额服务端强制）；
- **mode**：`'channel'`（缺省）= 沿用/恢复当前通道的 agent 会话（多轮业务每轮都用它）；`'fresh'` = 独立会话、不写通道映射（单 run 内初审→复审这类额外调用，上下文不串味）；
- **异常**：`skills` 为空 → 抛错；信封无 `endpoint`（本地调试/mock 未给）→ 抛错（当前环境不可调用 agent/session）；服务端拒绝（白名单不通过、配额超限、agent 异常）→ reject 带原因。

```ts
const review = await sdk.agent({
  skills: ["ticket-review"],
  input: maskedTicket,
});
```

### 2.7 `sdk.session.compact()` / `sdk.session.clear()`

- **用途**：当前通道的 agent 会话操作——多轮业务处理 `/compact`、`/clear` 类用户命令用（**命令的识别归业务**：用户消息原样到达流程程序，平台不识别不翻译）；
- `compact()`：压缩当前通道会话上下文；`clear()`：清空映射，之后的 `agent` 调用用全新会话；
- **异常**：无 `endpoint` → 抛错（同 `agent`）。

```ts
if (userText === "/clear") {
  await sdk.session.clear();
  sdk.return("会话已清空");
}
```

### 2.8 `sdk.run(program, args): Promise<unknown>`

```ts
sdk.run(program: string, args: {
  input: unknown;
  config?: Record<string, string>;
  timeout_ms?: number; // 缺省 300_000（5 分钟）
}): Promise<unknown>;
```

- **用途**：调子程序——`program` 是**程序名**（本包 programs ∪ 绑定工具 programs），SDK 从平台注入的 `programs` 映射（名 → 物化绝对路径）查表后 spawn；**业务按名调用，永不接触路径**；
- **语义**：子程序与流程程序同一入一出契约；对端 `ok=true` → resolve `output`；对端 `ok=false` / 异常退出 / 超时 → reject（reason 进 message）；超时 SIGTERM、5 秒宽限后 SIGKILL；
- **异常**：程序名不存在 → 抛错（消息列出全部可用程序名）；
- **注入差异（机制强制）**：子程序信封只含 `{contract_version, input, config, workspace}`——**拿不到 secrets、endpoint、programs、dataDir**：物理上调不了大模型、摸不到安全桶、不能再按名调别的程序。工具需要的凭据由调用方显式放进 `config`。

```ts
const ticket = await sdk.run("jira-fetch", {
  input: { key: "PRJ-123" },
  config: { site: sdk.config().jira_site, token: sdk.secret("jira_token") },
});
```

### 2.9 `sdk.log(level, message, fields?): void`

- **签名**：`level: "error" | "warn" | "info" | "debug"`，`fields` 为可选结构化字段；
- **用途**：业务日志唯一通道——写 stderr 结构化行，平台采集进该 run 的业务日志文件，secrets 源头脱敏；**永不抛错**（日志管道自身异常静默吞掉）；
- stdout 只承载结果，不要往 stdout 写日志；直接写 stderr 也会被原样采集但不受管控（不享受脱敏与结构化），请走 `sdk.log`。

```ts
sdk.log("info", "fetch ticket", { key: "PRJ-123" });
```

### 2.10 `sdk.return(result): never` / `sdk.fail(reason): never`

- **唯一出口**：`return` 写成功结果后 `exit(0)`；`fail` 写失败原因后 `exit(1)`。二者**只生效一次**——重复调用任何出口 → 写错误日志并 `exit(1)`；
- `sdk.return(null)` = **本业务明确无产出：出口不投递**（入口下游照常收到派生事件，payload=null，下游自行判断）；无需通知的判定用它，不要返回空字符串占位；
- output 会成为派生事件的 payload：下游业务收到的就是它，出口投递的也是它——返回形状对着出口工具的 resultDoc 写（§6.3）。

### 2.11 主流形态完整示例（单轮审查工单）

```ts
import { sdk } from "@asterisk/agent-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 单轮审查工单：收事件 → 业务级去重 → 拉详情 → 大模型审查 → 组消息 → 唯一出口
const { event } = sdk.input();
const envelope = event as {
  event_id: string;
  session_id: string; // 工单 key
  payload: { issue_key?: string; updated?: string };
};
sdk.log("info", "run started", { event_id: envelope.event_id });

// 1. 检查：输入不合规 = 直接失败（不扇出、下游不触发）
const issueKey = envelope.payload.issue_key;
if (!issueKey) {
  sdk.fail("检查未通过：缺少 payload.issue_key");
}

// 2. 业务级去重（平台只保 event_id 幂等；「同工单同版本只审一次」是业务语义，自己管）
const recordsPath = join(sdk.dataDir(), "review-records.json");
const records = existsSync(recordsPath)
  ? (JSON.parse(readFileSync(recordsPath, "utf8")) as Record<string, string>)
  : {};
if (records[issueKey] === envelope.payload.updated) {
  sdk.return(null); // 无产出：出口不投递，下游自行判断
}

// 3. 拉详情：绑定工具资产的子程序，凭据显式传（子程序拿不到 secrets）
const ticket = await sdk.run("jira-fetch", {
  input: { key: issueKey },
  config: { site: sdk.config().jira_site, token: sdk.secret("jira_token") },
});

// 4. 大模型审查：skills 须在业务绑定的 skill 集合内；input 业务保证已脱敏
const review = (await sdk.agent({
  skills: ["ticket-review"],
  input: ticket,
})) as { verdict: string; reasons: string[] };

// 5. 门禁：机械校验结果，不合格 = 失败（不重做）
if (!review || typeof review.verdict !== "string") {
  sdk.fail("门禁未通过：审查结果不合规");
}

// 6. 组消息（形状对着出口工具 resultDoc）+ 落去重记录 + 唯一出口
records[issueKey] = envelope.payload.updated ?? "";
writeFileSync(recordsPath, JSON.stringify(records, null, 2));
sdk.return({
  content: `工单 ${issueKey} 审查完成：${review.verdict}`,
  mentions: ["zhangsan"],
});
```

---

## 3. config / secrets：自定义 key 规则

控制台为每个业务维护两个 key-value 桶，运行时经 stdin 信封注入：

| 桶 | 读口 | 内容 | 规则 |
| -- | ---- | ---- | ---- |
| 普通桶 | `sdk.config()` | 非机密配置（jira 站点地址、项目 key、仓库地址…） | key 名业务自定，明文回显 |
| 安全桶 | `sdk.secret(name)` | 机密（token、密码…） | key 名业务自定；只写不读明文、掩码回显、不进日志（平台日志管道源头脱敏） |

- github/jira 等账号凭据**一律走安全桶**，key 名业务自定（如 `jira_token`）；入口配置里的 `token_key` / `username_key` / `password_key` 这类字段存的是**安全桶键名引用**（不是值本身）；
- **例外约定 `exit.{kind}.{field}`**：出口工具的机密配置项（configSchema 里 `secret: true` 的字段，如邮件工具的 `pass`、jira 的 `password`、github 的 `token`）不落库进绑定配置，由平台在投递前从**本业务安全桶**按 `exit.{工具kind}.{字段key}` 回填（如 `exit.mail.pass`）。这组 key 是给平台出口投递用的保留命名，业务代码不要拿它当普通配置用；控制台出口表单会标注每个机密项应配的键名；
- 另有平台侧约定：私有资产仓库的 `credential_key` 指向**通用层**安全桶（资产登记用，与业务两桶无关）；
- 子程序拿不到 secrets（§2.8）——共享工具需要的凭据由流程程序 `sdk.secret()` 读出后经 `sdk.run` 的 `config` 显式传入，给什么由包作者决定。

---

## 4. skill：编写 / 注册 / 绑定 / 共享

skill = 给大模型的能力单元（可复用提示词组件）。

- **编写**：一个 skill = 一个含 `SKILL.md` 的目录；SKILL.md 遵循公开 skill 规范（frontmatter `name`/`description` + 正文规则与边界、输出 schema），**不为本平台做任何适配**；
- **注册资产**：skill 资产 = 一个 **skill 集合**（git 仓库或子路径；资产根下每个含 SKILL.md 的直接子目录是一个 skill，**技能名 = 目录名**，无清单文件）。控制台登记 git 三元组（url + commit + 子路径）即注册；skill 是纯文档资产，物化不构建、不需要初始化脚本；
- **共享与可见性**：skill（与工具）登记时定 `shared: true | false`，**设置后不可改**；能绑定 = 自己的全部资产 + 他人共享的资产。包（package）不共享；
- **绑定与使用**：业务绑定任意多 skill 集合 → `sdk.agent({ skills: [...] })` 的白名单 = 绑定集合的技能并集（可多个、可跨集合；服务端逐个校验、逐个注入）。包清单 `requires.skills` 声明代码引用的 skill 名，控制台在绑定配置期机械校验缺绑与重名（配置期报错，不拖到运行时）；
- **没有运行时注册接口**：skill 是静态资产，按名引用即可；包内不内嵌 skill——想单仓开发：同一仓库注册两次（根 = 包、`skills/` 子路径 = skill 集合），代码引用的是名字不是路径，将来拆仓复用业务代码零改动。

---

## 5. tool：注册 / 绑定 / 调用

工具 = 可复用的**代码组件**（jira-fetch、脱敏、还原这类机械能力：零 token、行为确定），不能独立完成业务任务。

- **注册与共享**：与包同一份清单契约（`agent-package.json`，见 §8.3），**没有 `requires` 字段**（工具是叶子，出现即清单校验失败）；共享规则同 skill（§4）；物化与包同流程（必带 `agent.materialize.mjs`，§8.4）；
- **绑定**：业务绑定任意多工具资产 → `sdk.run` 可调范围 = 本包 programs ∪ 绑定工具 programs；绑定配置期平台机械校验：程序名查重（重复拒绝）、包清单 `requires.tools` 的名字被绑定覆盖；
- **调用**：共享工具**只能 `sdk.run('名')` 按名调用**——跨仓库，物理路径平台注入，业务代码永远不写路径；调用语义与凭据传递见 §2.8；
- **包内程序直接 import 的取舍**：本包 `programs` 声明的程序同仓库路径可知——**首选直接 import 进程内调用**（零进程开销）；需要隔离/独立超时/别的语言时才 `sdk.run` 走子进程。包自由掌握。

---

## 6. 入口事件与出口结果对照

### 6.1 事件信封（一切入口的统一形状）

`sdk.input().event` 的形状（契约 v1）：

```jsonc
{
  "contract_version": "v1", // 恒为 "v1"
  "source": "webhook", // wecom | jira | github | webhook | cron | internal | manual
  "event_id": "evt_01J…", // 全局唯一锚点，兼作入口幂等键（重推被队列丢弃）
  "event_type": "jira.issue.updated", // 类别标签：业务 match 行声明的关注键
  "timestamp": "2026-10-08T10:00:00.000+08:00", // ISO 8601 带时区
  "session_id": "PRJ-123", // 源生会话标识（工单 key 等），通道串行键的一维
  "correlation_id": "evt_01J…", // 派生链首个任务的 event_id，全链追溯
  "hop_count": 0, // 派生转发计数，防循环
  "payload": {}, // 事件数据载体；internal 派生事件 = 上游业务产出原样
  "producer_business_id": "b01J…", // 仅 internal 派生事件填写
}
```

### 6.2 内置入口适配器事件对照

**自定义 Webhook（source=`webhook`，默认开启）**——接收任意外部系统 HTTP 推送：

- 投递地址：`POST http://<host>:<port>/hooks/{path}`（端口由部署配置 `AGENT_WEBHOOK_PORT` 决定，默认 6200），`{path}` 来自业务 match 行的 `entry_config.path`（合法字符 `[a-z0-9-]`，全平台唯一）；
- match 行 `entry_config`：

  | 键 | 必填 | 说明 |
  | -- | ---- | ---- |
  | `path` | 是 | URL 路径段 |
  | `session_id_key` | 是 | payload 内取 session_id 的点分路径（如 `issue.key`）；取不到/非非空字符串 → 400 |
  | `event_id_key` | 否 | payload 内取 event_id 的点分路径；缺省平台生成（此时幂等由推送方自负） |
  | `token_key` | 否 | 验签 token 的 secrets 键名；设置后请求须带 header `x-webhook-token` 等值，不符 → 401 |

- 产出信封：`payload = 请求 body 原样`（body 必须是 JSON object，形状推送方自定义）；`event_type` = match 行配置；`correlation_id = event_id`；`hop_count = 0`；
- 推送方视角响应：`200 { "event_id" }`（event_id 重推幂等丢弃仍回 200）/ `400`（body 或字段非法）/ `401`（验签失败）/ `404`（未知 path）；body 上限 1MB；
- 示例：`curl -X POST http://<host>:6200/hooks/jira-listener -H 'Content-Type: application/json' -H 'x-webhook-token: <token>' -d '{"issue":{"key":"PRJ-123"},"action":"updated"}'`（对应 `entry_config = { "path": "jira-listener", "session_id_key": "issue.key", "token_key": "webhook_token" }`）。

**Jira 定时轮询（source=`jira`，默认关闭）**——内部测试与无外网 webhook 场景的工单拉取：

- match 行 `entry_config`：

  | 键 | 必填 | 说明 |
  | -- | ---- | ---- |
  | `jira_url` | 是 | jira 站点根地址 |
  | `username_key` / `password_key` | 是 | 凭据的 secrets 键名（键名引用，凭据值在安全桶） |
  | `project` | 是 | 项目 key（JQL `project = "X"`） |
  | `assignees` | 否 | 负责人过滤，逗号分隔；缺省或 `*` = 不过滤 |
  | `days_back` | 否 | JQL `updated >= -Nd`，默认 7 |
  | `interval_seconds` | 否 | 轮询间隔秒，默认 60，下限 30 |

- 产出信封：`session_id = 工单 key`；`event_id = jira:{issueKey}:{updated}`（updated 变化 = 新事件，天然增量）；`event_type` = match 行配置（建议 `jira.issue.updated`；轮询形态不区分 jira 原生事件类型）；
- `payload`（轻量字段；**详情由业务自行 `sdk.run` 拉取，平台不做预取**）：

  ```json
  {
    "issue_key": "PRJ-123",
    "summary": "工单摘要",
    "status": "In Progress",
    "priority": "Major",
    "issue_type": "Bug",
    "assignee": "zhangsan",
    "reporter": "lisi",
    "updated": "2026-10-08T10:00:00.000+0800"
  }
  ```

- 环境约束：认证为 easemob jira **表单登录**形态（非 REST 基本认证/API Token）。

**对接上游业务（source=`internal`）**——流水线形态：

- 下游业务的 match 行：`source = internal`，`event_type = {上游业务id}.completed`（或 `.failed`）；控制台编辑页选 internal 时提供「上游业务 + 结果类型」引导自动生成；
- 信封：`payload` = **上游业务 `sdk.return` 的 output 原样**（上游 `sdk.return(null)` 时 payload 为 null，下游自行判断）；失败扇出（上游配置 on_failure 且失败/超时）时 `payload = { status, output }`；`session_id` / `correlation_id` 继承上游源生标识，`hop_count` +1，`producer_business_id` = 上游业务 id。

控制台业务编辑页入口区会按所选 source 渲染该适配器的完整 eventDoc（本节是它的镜像）；最新口径以控制台/`GET /api/config` 的 `entry_adapters[].eventDoc` 为准。

### 6.3 出口工具 result 对照（sdk.return 该返回什么）

通用约定：`sdk.return(null)` = 无产出不投递（各工具不再重复此条）。控制台出口区按所选工具渲染完整 resultDoc（本节是镜像）；最新口径以 `GET /api/exit-tools` 的 `resultDoc` 为准。

| 出口工具（kind） | `sdk.return` 期望形状 |
| ---------------- | --------------------- |
| `wecom-webhook`（企业微信群机器人） | 字符串（原样为 markdown 正文）或 `{ content: string\|object, mentions?: string[] }`（content 对象转 json 围栏文本；mentions 拼 `<@userid>` 追加文末）；正文超 4000 字节截断 |
| `wecom-aibot`（企业微信智能机器人） | 字符串原样；其他 JSON 值转 json 围栏文本；正文超 20480 字节截断；会话与触发用户在出口配置指定 |
| `mail`（邮件通知） | 字符串原样为正文（纯文本）；其他 JSON 值转 json 围栏文本；主题/收件人取出口配置 |
| `webhook`（自定义 Webhook） | **任意 JSON 值**，原样 POST 到配置地址（`Content-Type: application/json`，可配 Bearer） |
| `jira`（Jira 操作） | 带 `op` 的对象：`{ op: "comment", body }`（给配置的 issue_key 加评论）/ `{ op: "create", fields }`（在配置的 project 建工单，fields 含非空 summary） |
| `confluence`（Confluence 操作） | 字符串原样为页面正文，或 `{ content: string\|object }`；目标页面 = 配置的 space_key + page_title（存在则整体覆盖，不存在则创建） |
| `github`（GitHub 操作） | 带 `op` 的对象：`issue`（title 必填、body）/ `comment`（number 正整数必填、body 必填）/ `pr`（title 必填、body、head、base）/ `clone`（path 必填、ref——下载 tarball 到 path） |

示例（企微群机器人）：`sdk.return({ content: "工单 PRJ-123 审查完成：通过", mentions: ["zhangsan"] })`。

---

## 7. run 生命周期

一次 run 的完整过程：通道轮到 → 并发闸门取得令牌 → 建目录 → spawn 流程程序（cwd = workspace，`env: {}` 清空注入）→ stdin 写信封并关闭 → 收 stdout 结果 / 超时强杀 → 打标（success/failed/timeout）→ 结果扇出。

**两个目录的分工**：

| | workspace | dataDir |
| ---- | ---- | ---- |
| 路径 | `{workspace}/runs/{source}/{session_id}/{business_id}/{run_id}/` | `{workspace}/data/{source}/{session_id}/{business_id}/` |
| 生命周期 | per-run 隔离临时目录，TTL 清理 | 业务级持久，平台不做 TTL（业务自管容量与清理） |
| 用途 | 本次执行的临时产物（= 进程 cwd） | 跨 run 状态（去重记录、游标、进度…） |
| 读口 | `sdk.input().workspace` | `sdk.dataDir()` |
| 并发 | 每 run 独占 | 同通道 run 串行 ⇒ 读写无需自锁 |

**其他边界**：

- **超时**：wall-clock 默认 60 分钟（业务可在控制台覆盖），到点 SIGTERM、5 秒宽限后 SIGKILL；`sdk.run` 子程序单独计时（缺省 5 分钟，`timeout_ms` 可调）；
- **配额**：agent 调用次数按 run 计上限（服务端强制，默认 20，业务可覆盖）；stdout 累计上限 1MB，超限即杀即判 failed；
- **环境变量清空**：`process.env` 在业务进程里是空的——不要读环境变量，配置与凭据一律走 `sdk.config()` / `sdk.secret()`；
- **agent 会话**：`mode: 'channel'` 沿用通道会话（多轮业务连续）；`'fresh'` 独立会话；`sdk.session.compact()/clear()` 管理上下文（§2.6/§2.7）；
- **失败语义**：任一步失败 = 整体 failed，不重跑；默认不扇出（下游不触发、出口无投递），业务配置 on_failure 后失败也扇出（带失败状态，下游门禁验收）。

---

## 8. 本地开发与独立运行

### 8.1 从模板开始

平台仓 `templates/agent-package/` 是**拷贝即用**的包模板：内置与平台同构同版本的完整工具链，你只写 `src/` 业务代码。快速开始：

1. 拷贝模板目录到你的仓库；改 `agent-package.json` 与 `package.json` 的 `name`；
2. `npm install`（`@asterisk/agent-sdk` 是普通 npm 依赖；平台未发布 npm 时的离线兜底：改为 `file:<平台仓>/packages/sdk`，平台验收脚本 `scripts/verify-template.sh` 即此做法）；
3. 写 `src/` 业务代码（新增子程序 = `programs` 加条目；引用外部工具/skill = `requires` 加名字）；
4. **六条检查全绿**：`npm run build` / `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run circular`——本地跑绿的就是平台要求的全套检查；
5. 推送 git → 控制台登记为包资产 → 创建业务绑定（同时绑定 requires 声明的工具与 skill）。

模板 README 讲模板工程本身的用法；业务开发的完整知识以本文为准。

### 8.2 mock 信封本地调试

信封就是 stdin 的一段 JSON，本地用管道喂 mock 即可跑通整条流程：

```bash
echo '{
  "contract_version": "v1",
  "input": { "source": "webhook", "event_id": "evt_test", "event_type": "demo",
             "timestamp": "2026-10-08T10:00:00+08:00", "session_id": "PRJ-123",
             "correlation_id": "evt_test", "hop_count": 0,
             "payload": { "issue_key": "PRJ-123" } },
  "workspace": "/tmp/my-run",
  "config": { "jira_site": "https://jira.example.com" },
  "secrets": { "jira_token": "…" },
  "dataDir": "/tmp/my-data"
}' | node dist/programs/main.js
```

- mock 信封的 `input` 就是 `sdk.input().event`——形状自己造（建议直接复制 §6.2 的示例信封）；
- `workspace` 必填（`sdk.input()` 校验）；`dataDir` 仅当你的代码调用 `sdk.dataDir()` 时需要；
- **`sdk.agent` / `sdk.session` 本地不可用**（无 endpoint，调用即抛错）——本地调试到 agent 边界为止，或用测试替身隔离；`sdk.run` 可用（在 mock 信封里给出 `programs` 映射）。

### 8.3 包清单（agent-package.json）

```jsonc
{
  "name": "my-package", // 非空
  "version": "0.1.0", // 推荐
  "programs": {
    // 子程序名 → 物化后产物的相对路径（必须 .js、相对、不含 ..）
    "main": "dist/programs/main.js"
  },
  "requires": {
    // 可选，仅 package 可有：名字级依赖声明（不钉版本）
    "tools": ["jira-fetch"], // 本包 sdk.run 引用的外部工具名
    "skills": ["ticket-review"], // 本包 sdk.agent 引用的 skill 名
  },
}
```

`requires` 是包作者的自文档 + 配置期护栏：控制台绑定校验缺绑/重名即报错。版本钉在业务绑定里（资产登记行已钉 commit），升一次 skill 版本只需控制台重绑，不逼着包仓库改代码。

### 8.4 平台物化流程（登记后平台替你做的构建）

业务创建/变更绑定时，平台把资产 clone 到 `cache/assets/{asset_id}/` 并执行固定流程（package/tool；skill 纯文档不构建）：

```text
git clone → 清单形状校验 → npm ci（有 package.json 时，必须同时含 package-lock.json）
  → 执行 node agent.materialize.mjs（资产根的初始化脚本，必带）
  → 产物校验（programs 每条路径必须真实存在）→ 完成标记
```

- **`agent.materialize.mjs` 必带**：package/tool 资产根缺它 = 物化失败；职责 = 完成本仓库的一切初始化（转译/codegen/资源下载…），平台不传参、不理解过程，只验收产物；模板自带默认实现（esbuild 转译 `src/` → `dist/`，与 `npm run build` 同产物），简单项目原样可用；
- **环境边界**：物化环境只保证 node 24 + npm + git；脚本子进程 env 仅 `PATH`/`HOME`/`NPM_CONFIG_REGISTRY`；其他语言环境谁用谁装；**所有 program 入口必须 node 可执行的 JS**（其他语言 = 薄 JS wrapper + child_process）；
- **lockfile**：v1 只支持 npm + `package-lock.json`（锁文件必须进 git）；
- 构建产物与 node_modules 随资产缓存同生共死；缓存清理（控制台设置页，admin）后下次 run 懒重建（可能分钟级）。

---

## 9. 版本兼容政策

- 全部平台契约（stdin 信封、stdout 结果、事件信封、socket 协议）带 `contract_version`，当前恒为 `"v1"`；版本路由靠它——v2 到来时按值区分，新旧业务并存；
- 信封校验**忽略不识别字段**（向后兼容规则）：平台新增信封字段不破坏旧业务；
- SDK 按 npm 语义化版本发布，业务在 `package.json` 钉版本（模板默认 `^0.1.0`）；SDK 升级不改变契约版本——契约变更才会动 `contract_version`；
- 资产的版本 = 登记的 commit：更新资产 = 登记新 commit = 新资产行，使用旧版本的业务不受打断。

---

## 10. FAQ 与参考实现

### 10.1 FAQ

**Q：业务失败会自动重试吗？**
不会。run 内任一步失败 = 整体 failed，不重跑、不断点续跑。需要重试由上游源重新触发（入口幂等靠 event_id）。出口投递的重试（通知对端失败）平台已包办，与业务无关。

**Q：「这条事件不用处理/不用通知」怎么表达？**
`sdk.return(null)`——出口不投递；入口下游仍会收到派生事件（payload=null）并自行判断。不要用空字符串或空对象占位。

**Q：同一工单更新了会重复审查吗？**
平台只保证 event_id 级幂等（jira-polling 的 `jira:{issueKey}:{updated}` 已让「同 updated 重推」天然去重）。「同版本只审一次」这类业务语义去重自己用 dataDir 实现（§2.11 示例）。

**Q：子程序能调大模型 / 读 secrets 吗？**
不能，机制强制：子程序信封没有 endpoint/secrets/programs/dataDir。凭据由流程程序读出后经 `config` 显式传入；大模型调用只发生在流程程序（包的胶水代码）里。

**Q：能直接用环境变量传配置吗？**
不能——业务进程环境变量被清空（`env: {}`）。一律 `sdk.config()` / `sdk.secret()`。

**Q：多个 skill 能一次注入吗？**
可以：`sdk.agent({ skills: ["a", "b"] })`，可多个、可跨 skill 集合，全部须在业务绑定白名单内。

**Q：包内程序和共享工具怎么选调用方式？**
包内程序首选直接 import（零进程开销）；共享工具只能 `sdk.run('名')`。需要子进程隔离/独立超时的包内环节也可 `sdk.run`（§5）。

**Q：其他语言（Python/Rust/Go）能写业务吗？**
program 入口必须是 node 可执行的 JS（runner 以 `node <program>` 拉起）。其他语言 = 薄 JS wrapper 接信封 + child_process 调目标语言，目标语言产物/环境由 `agent.materialize.mjs` 准备（谁用谁装，平台只保证 node 24 + npm + git）。

**Q：webhook 的 path 被占用了怎么办？**
path 全平台唯一（创建/更新业务时校验查重，冲突 400 并列出占用方）。换路径段，或让占用方释放。

**Q：物化失败去哪看原因？**
绑定操作同步返回物化错误（消息含阶段名与 stderr 尾部 30 行）；管理员也可用平台物化脚本独立 CLI 复现完整输出。常见原因：缺 `agent.materialize.mjs`、缺 `package-lock.json`、初始化脚本 exit≠0、programs 产物缺失。

### 10.2 参考实现 walkthrough（单轮审查工单，端到端）

以「jira 工单更新 → 大模型审查 → 企微群通知」业务为例，全链路如下：

1. **写 skill**：建 skill 仓库，`ticket-review/SKILL.md` 写审查规则与输出 schema（frontmatter `name: ticket-review`）→ 控制台登记为 skill 集合资产；
2. **备工具**：复用共享的 `jira-fetch` 工具资产（或自建：同包清单契约，`agent-package.json` 声明 `programs: { "jira-fetch": "dist/programs/jira-fetch.js" }`，程序内部用 `sdk.runInput()` 读 input/config）→ 登记为共享工具；
3. **写包**：拷贝模板，流程程序 = §2.11 的完整示例（检查 → dataDir 去重 → `sdk.run('jira-fetch')` 拉详情 → 脱敏 → `sdk.agent({ skills: ['ticket-review'] })` 审查 → 还原/门禁 → 组企微消息形状 `sdk.return`）；清单 `requires: { tools: ["jira-fetch"], skills: ["ticket-review"] }`；
4. **本地验证**：mock 信封管道喂入跑通到 agent 边界；六条检查全绿；
5. **登记与绑定**：包仓库推送 git → 控制台登记（kind=package）→ 创建业务：绑定包（选入口程序 `main`）+ 工具 + skill 集合（配置期校验 requires 覆盖与查重）；
6. **配入口**：jira-polling match 行（`source=jira`，`event_type=jira.issue.updated`，entry_config 填 jira_url/project/username_key/password_key——键名指向业务安全桶里的凭据）；或 webhook match 行 + 让 jira 推送到 `POST /hooks/jira-listener`；
7. **配出口**：勾选 `wecom-webhook`，在出口配置里填群机器人 webhook 地址（该工具唯一配置项 `url`，非机密，直接进绑定配置；有机密项的工具会标注 `exit.{kind}.{字段}` 键名去安全桶配）；
8. **跑通**：工单更新 → 入口落队 → 通道串行执行 → 审查结果投递企微群；`sdk.return(null)` 的重复更新静默跳过投递。

现成参照：模板 `templates/agent-package/`（可运行的工程骨架，`src/programs/main.ts` 注释承载契约四条）；平台仓 `business/jira-ticket-review/` 是该参考业务的三族资产落位目录（`package/`、`tools/`、`skills/`），结构对应本节的 1–3 步。
