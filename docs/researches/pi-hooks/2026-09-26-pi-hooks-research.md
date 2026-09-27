# pi hooks 能力调研报告

- **调研日期**：2026-09-26
- **调研对象**：pi 0.87.1（本机安装包为 `@earendil-works/pi-coding-agent`，即 pi-mono 系的 coding agent）
- **调研方法**：本机实证为主。全部实验使用本机 ollama（`qwen3.6:latest`）真实跑 LLM，无头模式（`pi -p` / `--mode json`）执行；agent 配置目录用 `PI_CODING_AGENT_DIR` 指向临时目录隔离，未触碰 `~/.pi/agent/`，未读取任何 API key。
- **证据标注**：每条结论标注【实测】（本报告实验跑通，产物在 `results/`）或【文档/源码】（仅依据官方文档与 `.d.ts` 类型定义，未实跑）。

## 一、结论先行

| 平台需求 | pi 是否支持 | 机制 | 证据 |
|---|---|---|---|
| ① 前置检查（会话/任务开始时执行自定义逻辑并可阻断） | ✅ 支持 | `pi.on("input")` 返回 `{action:"handled"}` 可吞掉输入、整个 run 不发起 LLM 调用；`{action:"transform"}` 可改写输入。`before_agent_start` 可改写系统提示/注入消息（无取消语义） | 【实测】实验4：阻断后无 `agent_start`、零 LLM 调用、exit=0 |
| ② 中间处理（工具调用前/后拦截、阻断、修改） | ✅ 完整支持 | `pi.on("tool_call")`：返回 `{block:true, reason}` 阻断；原地改 `event.input` 可改写入参。`pi.on("tool_result")`：返回 `{content, isError, ...}` 可改写送回模型的结果 | 【实测】实验1/2/3/8 |
| ③ 后置检查（任务/turn 完成时执行逻辑，拿最终输出，阻断/改写） | ✅ 支持，但"阻断"语义是间接的 | `message_end` 可整体替换 assistant 消息（改写最终输出）；`agent_end` 拿到本次 run 全部消息（只读通知）；`turn_end`/`agent_before_settle` 可追加 session 条目并 `continue:true` 强制模型再跑一轮（实现"打回重做"） | 改写【实测】实验5b；`continue` 语义【文档】 |
| hook 动态配置（按业务注入、互相隔离） | ✅ 支持，路径多 | `-e <path>` 按次注入（可叠加 `--no-extensions` 关闭自动发现）；环境变量传参；项目级 `.pi/extensions/`（无头需 `--approve`）；按业务 `PI_CODING_AGENT_DIR` + `settings.json` 的 `extensions` 数组；SDK `DefaultResourceLoader({extensionFactories})` 同进程内联注入 | 【实测】实验6a/6b/6c/7/9 |
| 无头嵌入配套 | ✅ 完善 | `pi -p`（最终文本）、`--mode json`（JSONL 事件流）、`--mode rpc`（长驻双向）、SDK（`createAgentSession`）、`--continue/--resume/--fork/--session-dir/--no-session` 会话管理。extension 在四种模式都会加载 | 【实测】+【文档】 |

**一句话结论**：pi 的 extension 事件系统完整覆盖"前置检查 / 工具调用拦截 / 后置检查"三类 hook，且全部可按次、按业务动态注入并隔离；配合 `-p` / JSON / RPC / SDK 四种无头接入方式，满足平台 hooks 机制的全部需求。最大的注意点是"阻断"的语义：hook 阻断的是**单次工具调用或输入**，不是直接终止 run（模型会看到阻断原因并继续）。

## 二、extension / hook API 详细说明

权威来源：安装包内 `dist/core/extensions/types.d.ts`（1432 行，ExtensionAPI 全部挂接点的类型定义）与 `docs/extensions.md`。extension 是 TypeScript 模块，默认导出工厂函数 `export default function (pi: ExtensionAPI) {}`，由 jiti 加载，**无需编译**。extension 在 interactive / RPC / JSON / print 四种模式都会加载（`ctx.mode` 可区分）。

### 2.1 与三类 hook 对应的事件挂接点

**① 前置检查**

| 事件 | 时机 | 返回值语义 |
|---|---|---|
| `input` | 用户输入进入 agent 处理之前 | `{action:"continue"}` 放行；`{action:"transform", text}` 改写输入；`{action:"handled"}` 吞掉输入（=阻断，不进入 agent 循环） |
| `before_agent_start` | 输入已接收、agent 循环启动前 | 可返回 `{message}` 注入消息、`{systemPrompt}` 整体替换本轮系统提示；**无取消语义** |
| `session_before_switch` / `session_before_fork` 等 | 会话切换/fork 前 | `{cancel:true}` 可取消（与会话管理相关，非任务输入检查） |

【实测】实验4：`input` 返回 `handled` 后，事件流只有 session header，无 `agent_start`，进程 exit=0。
注意：`handled` 阻断后 pi **正常退出且无报错**，平台侧要把"被前置拦截"与"空输出"区分开（hook 需自行把判定结果写到约定位置，如本 demo 的 JSONL 日志）。

**② 中间处理（工具调用）**

实测触发顺序（实验1的 hook 日志，单次 bash 调用）：

```
tool_execution_start  →  tool_call  →  [工具实际执行]  →  tool_result  →  tool_execution_end
   （args 为原始参数）     （可阻断/可改入参）              （可改写结果）      （isError 汇总）
```

- `pi.on("tool_call", handler)`：handler 签名 `(event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | void`。
  - `event` 含 `toolCallId`、`toolName`、`input`（内置工具有强类型：`BashToolCallEvent.input.command` 等；自定义工具为 `Record<string, unknown>`）。
  - **阻断**：返回 `{block: true, reason: "..."}`。阻断后工具不执行，`tool_execution_end.isError=true`，`reason` 作为错误结果送回模型（模型会看到并做出反应）。【实测】实验2
  - **改写入参**：原地修改 `event.input`（文档明确：修改后**不再做 schema 校验**，后续 handler 能看到前面的修改）。【实测】实验3：`echo REWRITE_ME` 被改写为 `echo rewritten-by-hook` 并真实执行。
  - **终止提示**：`{block:true, terminate:true}` 表示"本批次工具全部执行完后停止 agent"，且需批次内所有工具结果都同意才生效【文档，未实测】。
  - **fail-safe**：handler 抛错 = 阻断该工具，错误消息作为错误结果送回模型。【实测】实验8
- `pi.on("tool_result", handler)`：工具执行后、结果送回模型前。返回 `{content, details, isError, usage}` 改写结果；多个 handler 链式组合，后者看到前者的修改。【实测】实验1/3：追加的审计标记出现在 toolResult 消息里，且模型在后续回复中提到了该标记。

**③ 后置检查**

| 事件 | 时机 | 能力 |
|---|---|---|
| `message_end` | 每条消息（system/user/assistant/toolResult）定稿时 | 返回 `{message}` 整体替换该消息（**必须保持原 role**）。对 assistant 消息的替换会反映到 print 模式的最终 stdout——即"输出门禁改写"可行。【实测】实验5b |
| `turn_end` | 每个 turn（一次 assistant 响应+其工具调用）结束 | handler 拿到 `message`、`toolResults`、`outcome`（completed/aborted/error）；返回 `{entries, continue:true}` 可追加 session 条目并强制再请求一次模型（"打回重做"）。【文档，continue 未实测】 |
| `agent_end` | 一次 agent run 结束 | 拿到本次 run 生成的全部 `messages`；只读通知，无返回值语义。【实测】实验1 |
| `agent_before_settle` | 最终结算前最后一个可动作边界 | 同 `turn_end` 的 BoundaryResult：可追加条目、`continue:true` 请求一次续跑。【文档】 |
| `agent_settled` | 全部自动工作（重试/压缩/队列）结束 | 最终通知，无返回值语义。【实测】实验1 |

后置"阻断"的说明：pi 没有"最终输出审核不通过则拒绝退出"的直接语义。可行替代：
1. `message_end` 直接改写最终输出（实测可行）；
2. `turn_end`/`agent_before_settle` 返回 `continue:true` 并追加一条 custom 消息要求模型修正（文档语义，需防死循环——文档明确警告无条件 continue 会循环）；
3. 平台层在 `pi -p` 的 stdout 之外以 hook 日志/JSON 事件流为准做门禁判定，不通过则丢弃结果（推荐，与平台"业务生命周期层"职责一致）。

### 2.2 其他与审计相关的挂接点（供参考）

`context` / `context_with_system`（每次 LLM 调用前改写消息列表）、`before_provider_request` / `before_provider_headers` / `after_provider_response`（HTTP 层拦截）、`tool_execution_start/update/end`（执行生命周期观察）、`user_bash`（`!` 命令拦截）、`session_start` / `session_shutdown`（会话级初始化和清理）。完整清单见 `types.d.ts` 的 `ExtensionAPI.on` 重载（约 30 个事件）。

### 2.3 执行模型要点【文档】

- 同一事件的多个 handler 按扩展加载/注册顺序串行执行；`pi.on()` 返回取消注册函数。
- extension 运行在 pi 进程内，拥有相同 OS 权限，可读凭据——**只能加载可信来源**。
- hook 在关键路径上同步执行，耗时直接拖慢 run。

## 三、动态配置方案（按业务注入 hook）

平台场景"同一环境跑不同业务、各挂各的钩子"有 5 条可行路径，均已实测（除特别标注）：

**路径 1：`--extension/-e` 按次注入（推荐用于子进程模式）**

```bash
pi -p --no-extensions -e /hooks/business-a.ts --model ... "任务A"   # 业务A
pi -p --no-extensions -e /hooks/business-b.ts --model ... "任务B"   # 业务B
```

- `-e` 可多次使用；`--no-extensions` 关闭目录自动发现但显式 `-e` 仍生效【实测 实验6b】——两者组合即"白名单式加载"。
- 每次 run 一个进程，业务间天然进程级隔离。
- hook 的行为参数用环境变量传入（demo 的 `PI_HOOK_LOG`/`PI_HOOK_REWRITE_OUTPUT` 即此模式，实测生效）。

**路径 2：按业务 agent 目录 + settings.json 声明（推荐用于配置化部署）**

```bash
PI_CODING_AGENT_DIR=/etc/platform/business-a pi -p "任务A"   # 该目录 settings.json: {"extensions": ["/hooks/a.ts"]}
```

【实测 实验7】无 `-e` 时按 settings.json 加载成功。同时把模型、会话目录等都隔离在业务目录里。

**路径 3：项目级 `.pi/extensions/`**

扩展放在任务工作目录的 `.pi/extensions/` 下自动加载。无头模式需加 `--approve`（信任项目本地文件），否则不加载。【实测 实验6c】适合"任务目录自带钩子"的形态；注意 trust 模型意味着工作目录内容可执行代码，平台需控制该目录的写入方。

**路径 4：SDK 内联注入（同进程多业务，推荐用于长驻服务）**

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: getAgentDir(),
  extensionFactories: [businessAHook],   // 函数直接注入，连文件都不需要
});
const { session } = await createAgentSession({ resourceLoader, sessionManager: SessionManager.inMemory() });
```

【实测 实验9，见 `sdk-test/sdk-inline-hook.mjs`】tool_call 阻断在 SDK 模式同样生效。每个业务建自己的 `DefaultResourceLoader` + `createAgentSession`，同进程内业务间隔离。另有 `additionalExtensionPaths` 按文件路径注入。

**路径 5：SDK 完全自定义 `ResourceLoader`**（平台自管资源存储与发现时使用）。【文档】

## 四、无头嵌入配套

| 方式 | 命令/API | 输出 | 与 hooks 结合 |
|---|---|---|---|
| print | `pi -p "..."` | 最终 assistant 文本到 stdout；error/aborted 时 exit 非零 | 所有 hook 生效；`message_end` 改写直接反映在 stdout【实测】 |
| JSON | `pi --mode json "..."` | JSONL 事件流（session header + agent/turn/message/tool 事件），stdout 专用、诊断走 stderr | 所有 hook 生效；事件流含 `tool_execution_end.isError` 等，可用于平台侧审计【实测】 |
| RPC | `pi --mode rpc` | 长驻进程，stdin/stdout 双向 JSONL；Node 侧有 `RpcClient` | 扩展 UI（确认框等）可通过 RPC 子协议转发给平台侧应答【文档】 |
| SDK | `createAgentSession()` | 进程内事件订阅 `session.subscribe()` | hook 以内联 factory 注入【实测】 |

会话能力：`--continue` / `--resume` / `--session <path|id>` / `--session-id` / `--fork` / `--session-dir` / `--no-session`（本次实验均用 `--no-session` 免落盘）【实测可用】。

## 五、限制与风险

1. **阻断 ≠ 终止 run**（最重要）：`tool_call` 阻断只是把 reason 作为错误结果给模型，run 继续，模型可能换路径重试。要终止需 `terminate:true`（且需批次内全部工具同意）或 handler 里 `ctx.abort()`。同理 `input` 的 `handled` 是静默吞掉，exit=0 无报错。平台如需"阻断即失败"，必须在 hook 内自行落标记（如写文件/日志），平台侧读取判定。
2. **信任与安全**：extension 与 pi 同进程同权限，可读 `auth.json`、环境变量。项目级 `.pi/extensions` + `--approve` 等于执行工作目录里的代码，多租户平台慎用路径 3。
3. **入参改写无二次校验**：`tool_call` 里改 `event.input` 后不再做 schema 校验——hook 自己可以造出非法参数，需谨慎。
4. **死循环风险**：`turn_end`/`agent_before_settle` 的 `continue:true` 必须带守卫条件，文档明确警告无条件续跑会循环（本次未实测该路径）。
5. **无头模式无 UI**：print/JSON 模式 `ctx.hasUI=false`，`ctx.ui.confirm()` 等不可用，确认类逻辑必须做成自动策略；RPC 模式可转发部分对话框。
6. **性能**：handler 串行同步执行，重检查（如调外部服务）直接加在每次工具调用/LLM 调用的关键路径上。
7. **版本与发行渠道注意**：本机安装包名是 `@earendil-works/pi-coding-agent`（非任务背景中提到的 `@mariozechner/pi-coding-agent`），docs 内源码链接指向 `github.com/earendil-works/pi`。以本机安装版本的 `types.d.ts` 为准；升级时需重新核对 API。
8. 本地小模型实验的局限：hook 机制本身与模型无关，阻断/改写均为 harness 层行为，结论不依赖具体模型；但"模型被阻断后如何反应"属于模型行为，生产环境（更强模型）表现可能不同。

## 六、对平台选型的建议

1. **pi 满足 hooks 需求，可作为 agent 内核继续推进。** 三类 hook 全部有对应事件，中间层（工具拦截）能力最强（阻断/改入参/改结果/审计四合一），前置/后置检查语义齐全但需按上文"限制1"设计判定通道。
2. **两层 hooks 的落法**：业务生命周期层（平台自建）照旧在进程外做输入检查/输出门禁；run 内层用 extension。平台侧的门禁判定建议以 `--mode json` 事件流 + hook 自写的判定日志为准，而不是只看 stdout。
3. **注入方式**：子进程批量模式用"路径 1（`-e` + `--no-extensions` + 环境变量传参）+ `PI_CODING_AGENT_DIR` 隔离"；若未来做长驻驻留服务，用 SDK 内联 factory（路径 4），同进程按业务建 session。
4. **阻断策略设计**：安全类阻断在 hook 里写结构化判定记录（参考 demo 的 JSONL），并在需要终止时显式 `ctx.abort()`，不依赖模型"自觉"。

## 附：实验清单

| 实验 | 内容 | 结果 |
|---|---|---|
| 1 | 基础 hook 触发顺序 + tool_result 改写（JSON 模式真实工具调用） | ✅ 全部事件按序触发；审计标记进入 toolResult 并被模型看到 |
| 2 | tool_call 阻断 FORBIDDEN 命令 | ✅ 工具未执行，reason 作为错误结果给模型，run 继续，exit=0 |
| 3 | tool_call 原地改写命令入参 | ✅ 实际执行的是改写后的命令 |
| 4 | input 前置阻断 | ✅ 无 agent_start、零 LLM 调用、exit=0 |
| 5a/5b | print 模式输出改写（message_end 替换 assistant 消息） | ✅ 最终 stdout 含 hook 追加的标记 |
| 6a/6b | 不带 -e 对照；`--no-extensions` + 显式 `-e` | ✅ 对照无 hook；显式 -e 仍加载 |
| 6c | 项目级 `.pi/extensions` + `--approve` | ✅ 无头模式加载成功 |
| 7 | 业务级 `PI_CODING_AGENT_DIR` + settings.json `extensions` | ✅ 无 -e 时声明式加载成功 |
| 8 | tool_call handler 抛错 | ✅ fail-safe：工具被阻断，错误消息给模型 |
| 9 | SDK 内联 extension（`extensionFactories`） | ✅ 同进程编程式注入，阻断生效 |

复现：`bash scripts/run-all.sh`（前提见 README.md）。
