# T11 agent-service 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/business-workflow.md` §4、`design/package-model.md` §10、`design/channel-model.md` §3。
> 包名 `@asterisk/agent-service`，目录 `packages/agent-service/`。

## 1. 目标

产出 `@asterisk/agent-service` 包：`sdk.agent()` / `sdk.session.*` 的平台另一端。每个 run 监听一个 unix socket（一次性 token 鉴权）；agent 调用 spawn pi 子进程执行（白名单注入 skill、按通道恢复会话、按 run 计配额、请求体审计落盘）；compact 经 pi RPC 模式执行；clear 解除通道会话映射。

**pi 是唯一内核**，本包是平台唯一 spawn pi 的地方。

## 2. 背景知识（执行所需的最小上下文）

- **AgentService 为什么存在**：模型凭据由平台持有、不进入业务进程——业务进程里没有 API key，大模型调用的唯一通道是本服务（`sdk.agent()` 的另一端）。配额、审计、会话内守卫全部挂在这个平台通道上，业务无法绕过。
- **pi 是唯一内核**：pi = `@earendil-works/pi-coding-agent`（0.87.1 已实证）。本任务用到两种无头形态：`pi -p --mode json`（单次推理，stdout 出 JSONL 事件流）与 `pi --mode rpc`（长驻进程，stdin/stdout 双向 JSONL——compact 走这里，因为 compact 没有 headless CLI 入口，只有 RPC/SDK）。白名单纪律：`--no-skills` / `--no-extensions` 关闭自动发现，显式 `--skill` / `-e` 逐个注入。实证命令行见 `docs/researches/jira-review-masking-hooks/run-all.sh`，调研报告见 `docs/researches/pi-hooks/2026-09-26-pi-hooks-research.md`。
- **会话连续性**：业务通道 `channel_id ↔ pi 会话 id` 的映射存 ChannelStore（T5 已实现，本包经注入的最小接口使用）。`mode:'channel'` = 恢复/绑定通道会话；`'fresh'` = 全新会话不写映射。pi 对不存在的 `--session-id` 会创建新会话文件（实证）。
- **hooks 三条纪律**（适用于会话内 extension）：① fail-closed——hook 解析/执行异常 = 阻断，不是放行；② 判定自写日志——hook 阻断不反映在进程退出码（exit=0），判定以 hook 自写的结构化日志为准；③ 边界审计——每次 LLM 调用落盘真实请求体。**本版业务侧不提供 extension**——会话内只有平台审计 extension，直接受 ①③ 约束。
- **审计是什么、为什么存在（黑匣子）**：平台的安全主张「敏感内容不出边界」靠业务在请求进 LLM 前脱敏——但脱敏是业务代码，可能写错、漏规则。审计 extension 挂在 `before_provider_request`（请求出边界的最后一刻）把真实请求体逐次落盘，是脱敏有效性的**唯一直接证据**：事后拿敏感原值扫审计文件即可验证 0 泄漏（实证：run-all.sh 校验 5b 正是这么做的）。它类似飞机黑匣子：平时没人看；出事（疑似泄漏、合规检查、客户质询"我的数据发给大模型了吗"）时它是唯一能回答"到底发出去什么"的东西——**事后无法补录，所以必须默认开启**。**审计必须由平台注入而非业务自觉**：交给业务实现则可被移除或绕过，平台装配时统一 `-e` 注入、业务无法摘除（`--no-extensions` 白名单纪律，且不支持业务 extension）。次要用途：用量/成本分析的数据源。
- **依赖规则**：本包是依赖管理第 3 类（上下文注入）——`createAgentService(deps)` 工厂注入全部依赖，**不读 `process.env`**；唯一例外是 `@asterisk/agent-logger` 全局外观（顶级规则允许的共享面）。
- **socket 协议**：wire 协议的唯一定义处在 T10 spec §5.4（本 spec §5.3 逐字复述）；SDK 侧已实现客户端，本包实现服务端，两侧各自定义类型、不共享代码。

### 2.1 消费的上游包（真实签名，以此为准）

`@asterisk/agent-logger`（全局外观，initLogger 归 app/server T12，本包不初始化）：

```ts
export const logger: {
  /** 绑定模块上下文取分类日志器。路由：module 'entry-loop'→entry-loop.log、
   *  'exit-loop'→exit-loop.log、其余一律归 system.log */
  for(context: { module: string } & LogFields): CategoryLogger;
  // CategoryLogger: error/warn/info/debug(message: string, fields?: LogFields): void
};
```

本包埋点用 `logger.for({ module: 'entry-loop', run_id, channel_id })`——agent 调用发生在入口循环消化期间，执行过程归入口循环日志（logging.md 的职责划分；module 值即路由键）。

## 3. 范围与不做清单

**本任务做**：`createAgentService(deps)` 工厂 → `serve(ctx)` 每 run 一个服务端点；op = agent / compact / clear；平台自有的请求体审计 extension；fake-pi 测试夹具。

**本任务不做**：

- 业务资料加载（ContextLoader）、程序包物化与名解析（PackageRegistry）——上游已把 skill 解析成物化路径传进来；
- 业务进程 spawn（T10 已做）、Lifecycle 组装（T12）；
- wall-clock 超时（归 WorkflowRunner，T10 已做）；
- console / 管理 API（T13/T14）；
- pi 工具白名单开放（v1 恒 `--no-tools`，后续作为业务资料字段再开）；
- 业务 pi extension（**不支持**——会话内只有平台审计 extension。v1 恒 `--no-tools` 无工具可拦、脱敏/门禁等守卫均在会话外业务程序内，会话内守卫无剩余场景；将来有真实需求再加，装配清单多一类 `-e` 而已）。

## 4. 包结构

```
packages/agent-service/
├── package.json            # @asterisk/agent-service；deps: @asterisk/agent-logger（workspace:*）
├── tsconfig.json           # 与各包同构（extends ../../tsconfig.base.json）
├── src/
│   ├── index.ts            # createAgentService + 类型导出
│   ├── socket-server.ts    # unix socket 监听/协议/串行化/token
│   ├── pi-runner.ts        # agent op：装配命令行、spawn、JSONL 输出提取、配额
│   └── pi-compact.ts       # compact op：RPC 子进程
├── extensions/
│   └── audit.js            # 平台审计 extension（plain JS，不进 tsconfig 构建）
└── tests/
    ├── agent-service.test.ts
    ├── audit-extension.test.ts
    └── fixtures/fake-pi.js # 假 pi：见 §6
```

## 5. 详细规格

### 5.1 pi 子进程装配（agent op 的命令行，唯一形态）

```
pi -p --mode json
   --session-id <id> --session-dir <ctx.session_dir>
   --system-prompt <ctx.prompt>
   --model <ctx.model>
   --no-skills [--skill <path>]…              # 请求命中且过白名单的 skills
   --no-extensions -e <auditExtensionPath>    # 仅平台审计 extension，无业务 extension
   --no-prompt-templates --no-context-files
   --no-tools
   <inputText>                                # input 的字符串化（见下）
```

- `cwd = ctx.workspace`；`env = { ...deps.pi_env, PI_CODING_AGENT_DIR: deps.pi_agent_dir, AUDIT_LOG_PATH: ctx.audit_log_path }`（不继承其他环境）；
- `input` 为字符串则直传，否则 `JSON.stringify(input)`；序列化后 **> 512KB → `ok:false input_too_large`**，不 spawn（argv 长度保护）；
- `--system-prompt` 用总纲整体替换 pi 默认编码助手提示（行为确定性优先）；
- exit≠0 → `ok:false agent_failed: <stderr 尾部 2KB>`；stdout 解析失败/无 assistant 消息 → `agent_empty_output`；
- 审计 extension 文件路径 = 本包 `extensions/audit.js`（`import.meta.url` 相对解析）。

### 5.2 公开接口（index.ts 导出，每个成员都要有注释）

```ts
/** skill 引用：上游（PackageRegistry/ContextLoader）已完成名解析与物化 */
export interface SkillRef {
  name: string;            // 白名单校验的键（sdk.agent 请求里的名）
  path: string;            // 物化后的 skill 绝对路径（--skill 注入）
}

/** 每 run 一次的 serve 上下文（与 BusinessContext 的字段映射归装配层 T12） */
export interface AgentServeContext {
  run_id: string;                  // run 标识（socket 文件名、日志关联用）
  channel_id: string;              // 业务通道 channel_id（会话映射键；出口通道不到这里）
  workspace: string;               // run 工作目录 = pi 子进程 cwd
  prompt: string;                  // 提示词总纲 → --system-prompt
  skills: SkillRef[];              // 本业务 skill 白名单（全集；请求选子集注入）
  model: string;                   // --model 值（provider/id 或 models.json 中的模型名）
  session_dir: string;             // pi 会话存储目录 cache/agent-sessions/{三维}/（装配根保证存在）
  audit_log_path: string;          // 请求体审计落盘路径 runs/{三维}/{run_id}/audit/llm-requests.jsonl
  quota: { max_agent_calls: number }; // 按 run 计的 agent 调用上限
}

/** 通道会话映射最小面（T5 ChannelStore 结构兼容，本包自定义不 import） */
export interface AgentSessionMapping {
  bindAgentSession(channelId: string, agentSessionId: string): void;
  getAgentSession(channelId: string): string | undefined;
  clear(channelId: string): void;
}

/** 装配根注入的依赖 */
export interface AgentServiceDeps {
  pi_cli_path: string;             // pi 可执行文件绝对路径（测试指向 fixture 脚本）
  pi_agent_dir: string;            // PI_CODING_AGENT_DIR（models.json 所在，平台管理）
  pi_env: Record<string, string>;  // pi 子进程基础 env（PATH/HOME/模型凭据实际值等，装配根组齐）
  mapping: AgentSessionMapping;
}

/** serve 返回的运行句柄 */
export interface RunningAgentService {
  endpoint: { socket_path: string; token: string };  // 与 T10 spec §5.4 ServiceEndpoint 同形
  close(): Promise<void>;                            // 幂等；杀在飞 pi、删 socket、token 失效
}

export interface AgentService {
  /** 每 run 调一次：监听就绪后返回（endpoint 可注入业务进程） */
  serve(ctx: AgentServeContext): Promise<RunningAgentService>;
}

export function createAgentService(deps: AgentServiceDeps): AgentService;
```

### 5.3 socket wire 协议（逐字复述 T10 spec §5.4，唯一锚在那）

一行一条 JSON（`\n` 结尾），一次调用一条连接，**服务端回完即关**：

```ts
interface ServiceRequest {
  contract_version: 'v1';
  token: string;
  op: 'agent' | 'compact' | 'clear';
  skills?: string[];   // op='agent' 必填（非空、逐个白名单校验）
  input?: unknown;     // op='agent' 必填
  mode?: 'channel' | 'fresh'; // 缺省 'channel'
}
type ServiceResponse =
  | { contract_version: 'v1'; ok: true; output: unknown }   // agent: 最终文本；compact/clear: null
  | { contract_version: 'v1'; ok: false; error: string };
```

错误消息稳定前缀（测试断言用）：`invalid_request` / `quota_exceeded` / `skill_not_allowed: <name>` / `input_too_large` / `agent_failed: <tail>` / `agent_empty_output` / `service_closed`。

- socket 路径：`path.join(os.tmpdir(), `ea-${run_id}.sock`)`——**不放 workspace**（unix socket 路径长约 104 字符，三维 run 目录易超限）；close 时删除文件；
- token：`crypto.randomUUID()`，serve 时生成，close 后失效；
- compact/clear 无映射会话时：compact → `ok:true, output:null`（无会话可压，no-op）；clear → `ok:true, output:null`（幂等）。

### 5.4 平台审计 extension（extensions/audit.js）

定位见 §2「审计是什么、为什么存在」——黑匣子，默认开启、平台注入、业务不可移除。

形态：plain JS、不经构建（pi 经 jiti 直接加载），默认导出工厂 `(pi) => { pi.on('before_provider_request', handler) }`：handler 把 `{ts, provider, model, body}` 追加为 JSONL 一行到 `process.env.AUDIT_LOG_PATH`（父目录先 mkdir -p）。**fail-closed**：写盘失败即抛错（pi 语义：hook 抛错 = 阻断该请求）——宁可调用失败，不留无审计的 LLM 请求。

### 5.5 实现要点

1. **串行化**：serve 内维护 promise 链，请求处理逐个挂链尾；
2. **子进程跟踪**：spawn 的 pi 进程登记到活跃集合，退出移除；close 时遍历 SIGTERM→2s→SIGKILL（仿 T10 runner 的杀法）；
3. **RPC compact**：读 stdout 按行解析，匹配 `type==='response' && command==='compact'`；30 秒无响应 → 杀进程回 `agent_failed: compact timeout`；
4. **日志**：每次调用的埋点（run_id/op/skills/耗时/usage?/结果前缀）经 `logger.for({module:'entry-loop', ...})` 记录；
5. **审计文件父目录**：serve 时 mkdir -p 一次。

## 6. 测试清单

**fake-pi.js**（plain JS，可执行）：把 argv 与 cwd 追加写进 `FAKE_PI_CAPTURE` 指向的文件（一行 JSON）；`--mode json` 时输出 session header + 两条 message_end（最后一条 assistant 文本来自 `FAKE_PI_REPLY`）；`--mode rpc` 时读 stdin 行，`type:'compact'` → 回 `{id 原样, type:'response', command:'compact', success:true, data:{}}`；`FAKE_PI_SLEEP_MS` 支持挂起（测 close 强杀）；`FAKE_PI_EXIT` 支持非零退出（写 stderr）。

**agent-service.test.ts**：

1. serve 返回 endpoint（socket 文件存在于 tmpdir）；非法 JSON / 版本不符 / token 错 → `ok:false invalid_request`；
2. agent 正常：fake pi 回文本 → `ok:true` output 一致；capture 断言 argv 含 `--no-skills`、逐个 `--skill`、`-e` 仅审计 extension 一个、`--session-id/--session-dir/--model/--system-prompt`、`--no-tools`、`--no-extensions`；cwd = workspace；env 含 `PI_CODING_AGENT_DIR`/`AUDIT_LOG_PATH`；
3. 白名单：`skills:['not-allowed']` → `ok:false skill_not_allowed`，capture 无新增行（未 spawn）；
4. 空 skills / 缺 input → `ok:false invalid_request`；输入序列化超 512KB → `input_too_large`；
5. 配额：max_agent_calls=1，第二次 agent → `quota_exceeded`，未 spawn；失败的调用也计数；
6. 会话：channel 首次 → mapping.bind 被调（新 uuid 入 argv）；第二次 → argv 用映射 id；fresh 两次 → 两个不同 id 且不写映射；
7. `FAKE_PI_EXIT=1` → `ok:false agent_failed` 含 stderr 尾部；fake 不回 assistant 消息 → `agent_empty_output`；
8. compact：有映射 → fake pi RPC 回 success → ok:true；无映射 → ok:true 且不 spawn；
9. clear → mapping.clear 收到 channel_id；
10. close：`FAKE_PI_SLEEP_MS` 挂起的 pi 被杀（进程不存在）；close 后请求 → `service_closed`；socket 文件删除；close 幂等；
11. 串行化：并发发两个 agent（fake sleep 100ms）→ capture 两行启动间隔 ≥ 100ms。

**audit-extension.test.ts**：模拟 pi API 对象（捕获 on 注册的 handler）调用工厂 → handler 写 JSONL 到临时文件、字段齐全（ts/provider/model/body）；写盘失败（只读目录）→ handler 抛错。

## 7. 验收标准

1. 全部测试通过；根级六连全绿（`yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular`）；
2. 本包运行时依赖仅 `@asterisk/agent-logger`；无 `process.env` 读取（deps 注入）；
3. 接口与 §5.2 逐字一致；
4. **实现期实证核对**（完成后记入任务汇报）：用真 pi 对 RPC compact 做一次手动 smoke（`--mode rpc --session-id` 绑定既有会话 + compact 命令），确认协议可用；不可用则按 §8.8 降级方案实现并说明。

## 8. 本规格的决策点（已定，不再讨论）

1. **依赖规则第 3 类（上下文注入）**：有状态服务、每 run 一个 serve 实例；pi 子进程 env 由装配根经 deps 注入，本包不读 `process.env`。
2. **per-endpoint 请求串行化**：同一 endpoint 的请求排队逐个处理（promise 链）。业务代码 `await sdk.agent()` 天然串行；串行化防并发写同一会话文件。
3. **skill 注入**：请求 `skills` 逐个校验 ∈ ctx 白名单（按 `name`），通过后逐个 `--skill <path>` 注入；**恒带 `--no-skills`**（pi 子进程 cwd 是 run 工作区，不关自动发现会被业务丢目录绕过）。
4. **extension 注入**：恒带 `--no-extensions`；显式 `-e` 只注入平台审计 extension（本包自带）。**不支持业务 extension**：v1 恒 `--no-tools` 无工具可拦，脱敏/门禁等守卫均在会话外业务程序内（顺序由业务代码控制），会话内守卫无剩余场景；extension 与 pi 同进程同权限，砍掉后信任面更小。将来有真实需求再加。
5. **v1 恒带 `--no-tools`**：skill 以提示词能力为主；工具白名单开放是后续业务资料字段，不在本版。
6. **会话模型**：`--session-dir <ctx.session_dir>` 恒定；`mode:'channel'` → 查映射，有则用、无则新生成 id 并在 spawn 前 `bindAgentSession`（pi 对不存在的 session-id 会创建，先绑安全）；`mode:'fresh'` → 每次新生成 id、不写映射。会话 id 用 `crypto.randomUUID()`。
7. **输出提取**：`--mode json` 的 stdout JSONL 事件流中，**最后一条** `{type:'message_end', message.role:'assistant'}` 的 text 内容片拼接为最终输出（实证提取式见 run-all.sh §4）。
8. **compact 走 RPC 模式**：spawn `pi --mode rpc`（带 `--session-id`/`--session-dir`/`--model` + 审计 extension），stdin 写一行 `{"id":"c1","type":"compact"}`，读到 `{type:'response',command:'compact',success:true}` 即成功，随后杀进程。协议形状以 pi 包 `dist/modes/rpc/rpc-types.d.ts` 为准（实现时核对；若 RPC 绑定既有会话有障碍，降级方案 = pi SDK 子进程 helper，实现期验证后回报）。
9. **clear 纯映射操作**：`mapping.clear(channel_id)`，不调 pi；旧会话文件留在 cache 由 TTL 清理。
10. **配额按调用计**：每次 agent 请求计 1（不论成败），超限 → `ok:false quota_exceeded`，不 spawn。
11. **close 语义**：停止接受新连接（已有连接按协议回完）、杀掉本 run 全部在飞 pi 子进程（SIGTERM，2 秒后 SIGKILL）、删除 socket 文件、token 失效；挂起中的请求回 `ok:false service_closed`。
12. **埋点**：最终 assistant 消息若带 `usage` 字段，随调用日志记录（best-effort，不影响契约）。
13. **socket 不放 workspace**：unix socket 路径长约 104 字符，三维 run 目录易超限，故放 `os.tmpdir()`。
