# T10 workflow-runner + 业务 SDK spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/business-workflow.md`（§2 子进程契约、§3 SDK API 面、§6 稳定性边界、§7 沙箱纪律）。

## 1. 目标

一次产出两个包：

1. **`@easemob/agent-workflow-runner`**（`packages/workflow-runner/`）：平台侧的**流程执行器**——spawn 业务流程程序（子进程）、stdin 注入上下文、stdout 收唯一结果、stderr 采集业务日志、超时强杀、输出上限。它是 T8 `EntryDriver.execute` 的实现基石（装配根 T12 组合）。
2. **`@easemob/agent-sdk`**（`packages/sdk/`）：业务侧的唯一编程面——业务用户只 import 它，不碰进程管理/stdin/stdout 协议/socket 通信。

两者是同一条子进程契约的两端，放一个任务保证契约一致。

## 2. 背景知识（执行所需的最小上下文）

- **一入一出**：平台对业务流程程序的唯一约束。stdin 一段 JSON（输入+注入上下文）、stdout 一段 JSON（唯一结果，只认一次）、进程退出 = run 结束；exit code 非零或超时 = 失败（fail-closed）。
- **业务上下文业务自己管理**：流程中间数据（如脱敏 kv）是程序内变量，平台不持有、不传递。
- **四道机械防线**（本任务落实其中三道半）：子进程隔离、超时强杀（wall-clock）、输出大小上限 + 结果 schema 校验；agent 调用配额由 AgentService（T11）在 socket 服务端强制，不在本任务。
- **agent 调用只能经 AgentService**：模型凭据平台持有，不进入业务进程。SDK 的 `agent()`/`session.*` 经 per-run unix socket + token 调用；socket 服务端由 T11 实现，**wire 协议由本 spec §5.4 唯一定义**，T11 照此实现。
- **业务日志**：SDK 的 `log()` 写 stderr 结构化行；runner 捕获 stderr 追加到该 run 的业务日志文件（路径三维与 channel_id 对齐：`logs/businesses/{source}/{session_id}/{business_id}/{run_id}.log`）。结构化行解析、非结构化行原样透传、**日志管道自身永不失败**。
- 运行时形态：业务上传 TS 源码包，平台上传时已转译 JS（转译归 T13 管理 API，不在本任务）；runner 拿到的 `program` 就是可执行 JS 入口文件的绝对路径。
- 依赖规则：runner 是上下文注入类（第 3 类），不读 `process.env`、不用全局单例（logger 外观除外）；SDK 面向业务进程，单例形态是刻意的（一个业务进程 = 一次 run）。

### 2.1 消费的上游包（真实签名，以此为准）

`@easemob/agent-contracts`：`EventEnvelope`、`newUlid()`、`assertSafeSegment(segment: string): void`（非法段抛 ChannelIdError）。

`@easemob/agent-logger`：`createFileLogger(path: string, options?: { level?, enabled?, secrets?: readonly string[] }): ConsoleLike`（底层单文件写口，ConsoleLike = `error/warn/info/debug(...args)`，JSONL 落盘、自带脱敏与写盘降级）；`logger.addSecrets(values)`（全局外观的 append-only 脱敏登记，装配根已 initLogger 时可用——runner 调用它时**必须 try/catch 容错**，未初始化场景静默跳过）。

## 3. 范围与不做清单

**本任务做**：子进程契约（stdin/stdout wire 格式）、WorkflowRunner、业务 SDK（含 socket 客户端）、socket 协议定义。

**本任务不做**：

- AgentService（socket 服务端、pi spawn、配额强制、会话恢复）→ T11；
- BusinessContext 组装 / Lifecycle / EntryDriver 组合 → T12；
- 业务包上传与 esbuild 转译 → T13；
- 沙箱 → 第二阶段（本任务的子进程隔离 + 显式资源声明必须不挡路）。

## 4. 包结构

```text
packages/workflow-runner/
├── package.json            # @easemob/agent-workflow-runner
├── tsconfig.json
│   ├── src/
│   │   ├── index.ts        # 导出清单见 §8
│   │   ├── runner.ts       # createWorkflowRunner
│   │   └── contract.ts     # 子进程契约编解码（stdin 写入 / stdout 解析 / stderr 行分类）
└── tests/
    ├── runner.test.ts
    └── fixtures/           # 测试用业务程序（plain JS，node 直接跑）
packages/sdk/
├── package.json            # @easemob/agent-sdk
├── tsconfig.json
│   ├── src/
│   │   ├── index.ts        # 导出清单（sdk 单例 + 类型），纯 re-export
│   │   ├── sdk.ts          # sdk 单例对象装配
│   │   ├── stdin.ts        # stdin 读取与解析（同步，读一次缓存）
│   │   ├── result.ts       # return/fail 的 stdout 写出
│   │   ├── log.ts          # stderr 结构化日志行
│   │   ├── socket.ts       # agent/session 的 unix socket 客户端
│   │   └── run.ts          # sdk.run 子程序 spawn
└── tests/
    ├── sdk.test.ts
    └── fixtures/
```

工程约定同 T0 spec §4。runner `dependencies`：`@easemob/agent-contracts`、`@easemob/agent-logger`。**SDK 依赖规则（业务发布物的边界）**：允许依赖**零依赖纯包**（`@easemob/agent-contracts` 的类型/校验、logger 的纯函数层如格式化/脱敏）；**禁止**依赖读 `process.env` 的包、全局单例外观（initLogger 是平台装配根的事，业务进程里没有）、平台内部包（queue/registry/scheduler 等）。**发布形态**：平台在上传转译时把 sdk 连同其依赖 esbuild bundle 注入 run 环境——业务零安装、只 import sdk，依赖是构建期的事、运行期无感（bundle 归 T13，本任务只保证依赖关系合法）。devDependencies 各自自声明工具链。

## 5. 详细规格

### 5.1 子进程契约（两端共用，runner/contract.ts 与 sdk 各自实现同一份格式）

**stdin（一段 JSON，写完即关）**：

```ts
/** 平台 → 业务流程程序，或 sdk.run → 子程序，同一个信封 */
interface StdinEnvelope {
  contract_version: 'v1';
  /** 平台→流程：入口事件信封（EventEnvelope 形状）；sdk.run→子程序：args.input 原样 */
  input: unknown;
  workspace?: string;                    // run 工作目录（平台→流程必填；sdk.run 继承父级）
  config?: Record<string, string>;       // 业务非机密配置（控制台登记）
  secrets?: Record<string, string>;      // 业务安全变量（仅平台→流程；sdk.run 不传）
  endpoint?: { socket_path: string; token: string }; // agent 服务端点（仅平台→流程）
}
```

**stdout（唯一结果，只认第一个合法结果对象；其后内容忽略但仍计入大小上限）**：

```ts
type StdoutResult =
  | { contract_version: 'v1'; ok: true; output: unknown }
  | { contract_version: 'v1'; ok: false; reason: string };
```

**判定优先级（runner 侧，fail-closed）**：① 第一个合法 StdoutResult → 采信（ok=false → failed）；② 无合法结果 → exit code 非零 = failed、超时 = timeout、exit 0 但无结果 = failed（reason `missing result`）。

**stderr（业务日志行）**：SDK 写出的结构化行 = 单行 JSON 且含 `"__biz_log": 1` 标记字段；其余行 = 非结构化（异常堆栈、库杂讯），原样透传。

### 5.2 WorkflowRunner（runner.ts，平台侧）

```ts
/** run 请求：装配根（T12）把 BusinessContext 拍平成它 */
export interface RunRequest {
  program: string;                       // 流程程序入口 JS 的绝对路径（上传时已转译）
  event: EventEnvelope;                  // 触发信封（取 source/session_id 用于目录与日志键）
  business_id: string;
  config: Record<string, string>;        // 业务非机密配置（可空对象）
  secrets: Record<string, string>;       // 业务安全变量（可空对象）
  endpoint: { socket_path: string; token: string }; // AgentService 开的 per-run 端点（T11）
  quota: { timeout_minutes: number };    // wall-clock 超时；agent 调用次数配额归 T11 服务端
  run_id?: string;                       // 可选（T17 起）：调用方指定 run_id，缺省内部生成 `run_${ulid}`；
                                         // workspace 与业务日志路径按它派生（规则不变）。
                                         // 传入值须匹配 /^run_[0-9A-HJKMNP-TV-Z]{26}$/，不符 → 抛错（平台自身错误类）
}

/** run 结果。与 scheduler 的 ExecutionResult 的映射归装配根，本包不依赖 scheduler */
export interface RunOutcome {
  status: 'success' | 'failed' | 'timeout';
  output: unknown;                       // 仅 success 有值（业务产出原样）
  reason?: string;                       // failed/timeout 的原因（日志用）
}

export interface WorkflowRunner {
  /** 执行一次 run：建目录 → spawn → 注入 → 收结果 → 打标。分钟级长调用。
   *  业务失败/异常/超时都返回 RunOutcome，不向调用方抛业务错误；
   *  只有平台自身错误（目录不可建、program 不存在）才抛错 */
  run(req: RunRequest): Promise<RunOutcome>;
}

export interface WorkflowRunnerOptions {
  workspaceRoot: string;                 // 平台工作目录（{workspace}，其下建 runs/ 与 logs/）
  maxOutputBytes?: number;               // stdout 上限，默认 1_048_576（1MB），超限 = failed('output too large')
  killGraceMs?: number;                  // SIGTERM 后 SIGKILL 的宽限，默认 5000
  nodePath?: string;                     // 缺省 process.execPath
}
export function createWorkflowRunner(opts: WorkflowRunnerOptions): WorkflowRunner;
```

实现要点（逐条可测）：

1. **run_id**：`'run_' + newUlid()`；**目录**（数据分类布局，背景出处 console-design §6）：source/session_id/business_id 三段先过 `assertSafeSegment`（防路径穿越），三维键 = `[source, session_id, business_id]`；工作区 = `{workspaceRoot}/runs/{三维键}/{run_id}/`（业务执行产生的临时数据，TTL 清理），业务日志 = `{workspaceRoot}/logs/businesses/{三维键}/{run_id}.log`（日志类，轮转可删），均 `mkdirSync recursive`；
2. **spawn**：`nodePath`（缺省 `process.execPath`）+ `[program]`，`cwd` = 工作区，**`env: {}`（环境变量清空——平台环境不泄漏给业务进程，secrets 只走 stdin）**；
3. **stdin**：按 §5.1 写入（含 endpoint、secrets）后立即 end；
4. **stdout**：累积计数字节，超 maxOutputBytes 即杀进程判 failed（不等结果）；按行/按流扫描第一个合法 StdoutResult——**只认一次**；
5. **stderr**：逐行读：以 `{` 开头且 JSON.parse 成功且含 `__biz_log` → 结构化（level/message/fields），经 `createFileLogger(日志路径, { secrets: Object.values(req.secrets) })` 按级别写入；其余行 → 原样经该 logger 的 info 写入（透传）。**写日志的一切异常吞掉**（管道永不失败）；
6. **脱敏**：run 开始时 `logger.addSecrets(Object.values(req.secrets))`（try/catch 容错）；业务日志文件写口自带 secrets 脱敏（createFileLogger 内建）；
7. **超时**：wall-clock = `quota.timeout_minutes` 分钟，到点 SIGTERM，grace 后 SIGKILL，判 timeout；
8. **进程收尾**：await 进程退出后才返回（不留僵尸）；结果映射见 §5.1 判定优先级；
9. **埋点**：返回前测 duration_ms，失败原因都进 reason（exit code / 信号 / 超限 / 缺结果）。

### 5.3 业务 SDK（packages/sdk/，业务侧）

**形态：导出单例对象 `sdk`**（`return` 是保留字，且设计示例就是 `sdk.xxx` 用法）。业务程序 `import { sdk } from '@easemob/agent-sdk'`。

```ts
/** input() 的返回：入口信封 + 平台注入的运行上下文 */
export interface RunInput {
  event: EventEnvelope;  // 触发信封（import 自 @easemob/agent-contracts，bundle 时内联）
  workspace: string;     // 本 run 的隔离工作目录（spawn 时的 cwd）
}

export interface AgentCall {
  skills: string[];                        // 本次调用注入的 skill 名（可多个、可跨程序包，服务端逐个 --skill 注入）；均须在绑定程序包的 skills 内（服务端白名单校验）；空数组本地直接抛错
  input: unknown;                        // 给大模型的内容（业务保证已脱敏）
  mode?: 'channel' | 'fresh';            // 缺省 'channel'：沿用/恢复当前通道会话；'fresh'：独立会话不写映射
}

export const sdk: {
  /** 读入口：stdin 信封的 input 作为 event + workspace。平台注入场景外（本地调试）可读 mock */
  input(): RunInput;

  /** 子程序侧读口：sdk.run 注入的 input 与 config（契约递归同构） */
  runInput(): { input: unknown; config: Record<string, string> };

  /** 读本业务的控制台登记配置（非机密）；无配置返回空对象 */
  config(): Record<string, string>;

  /** 读本业务安全变量（平台注入）；未注入该名 → 抛错 */
  secret(name: string): string;

  /** 调大模型服务（unix socket 到 AgentService；配额在服务端强制）。失败抛错 */
  agent(call: AgentCall): Promise<unknown>;

  /** 当前通道的 agent 会话操作（多轮业务的 /compact、/clear 类命令用；识别命令归业务） */
  session: {
    compact(): Promise<void>;  // 压缩当前通道会话上下文
    clear(): Promise<void>;    // 清空映射，之后 agent 调用用全新会话
  };

  /** 调子程序：spawn 独立程序，同一子进程契约。对端 ok=false / 异常退出 / 超时 → 抛错 */
  run(program: string, args: {
    input: unknown;
    config?: Record<string, string>;
    timeout_ms?: number;       // 缺省 300_000
  }): Promise<unknown>;        // 返回对端结果 output

  /** 写业务日志：结构化行写 stderr，平台采集进该 run 的业务日志。永不抛错 */
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, fields?: Record<string, unknown>): void;

  /** 唯一出口：成功返回结果。写 stdout 结果后进程 exit(0)。只生效一次（重复调 = 抛错后 exit 1） */
  return(result: unknown): never;

  /** 唯一出口：失败。写 stdout 结果后进程 exit(1) */
  fail(reason: string): never;
};
```

实现要点：

1. **stdin 读取**：`readFileSync(0, 'utf8')` 一次性同步读（runner 写完即关，EOF 立达），解析缓存，全部读口共享；解析失败 → `input()`/`config()` 等抛带原因的错；
2. **return/fail**：`process.stdout.write(JSON.stringify(result) + '\n')` 后 `process.exit(0/1)`；二者都先置 settled 标志，重复调用任何出口 → 写错误日志行并 exit(1)；
3. **log**：stderr 单行 `{"__biz_log":1,"level","message","fields"?, "ts"}`；try/catch 全吞；
4. **socket 客户端**：node:net 连 endpoint.socket_path，**一次调用一条连接**：发送一行 JSON 请求，读到一行 JSON 响应（服务端回完即关）；无 endpoint（未注入）→ 抛错；响应 ok=false → 抛错（带 error）；
5. **sdk.run**：`process.execPath` spawn 子程序，cwd = `input().workspace`，stdin = `{ contract_version:'v1', input, config, workspace }`，stdout 按同一契约收唯一结果，timeout_ms 到点 SIGTERM+SIGKILL；ok=true → 返回 output，其余一律抛错（reason 进 message）；
6. **离线调试**：stdin 无数据（TTY）时 `input()` 抛「无注入输入」——业务本地调试用管道喂 mock JSON 即可（`echo '...' | node program.js`）。

### 5.4 socket wire 协议（SDK 客户端 ↔ T11 服务端，唯一定义处）

unix socket，**一行一条 JSON（`\n` 结尾），一次调用一条连接，服务端回完即关**：

```ts
// 请求
interface ServiceRequest {
  contract_version: 'v1';
  token: string;                          // per-run 一次性 token，run 结束失效
  op: 'agent' | 'compact' | 'clear';
  skills?: string[];                      // op='agent' 必填（可多个、可跨程序包；服务端逐个白名单校验 + --skill 注入）
  input?: unknown;                        // op='agent' 必填
  mode?: 'channel' | 'fresh';             // op='agent' 可选，缺省 'channel'
}
// 响应
type ServiceResponse =
  | { contract_version: 'v1'; ok: true; output: unknown }   // compact/clear 的 output 为 null
  | { contract_version: 'v1'; ok: false; error: string };   // 配额超限、白名单拒绝、agent 异常等
```

非法 JSON / 版本不符 / token 无效 → 服务端回 ok:false（fail-closed），不静默断连。

## 6. 测试清单

通用：fixtures 用 plain JS 小程序（不经编译，node 直接跑）；需要 SDK 的 fixture 用相对路径 import SDK 的源码入口或构建产物均可（写明选择并保持一致）。logger 外观相关用 initLogger 到临时目录 + resetForTests。

**runner.test.ts**（fixtures 在 tests/fixtures/）：

1. 成功：fixture `sdk.input()` 回显 + `sdk.return({...})` → outcome success、output 一致、工作区目录按三维路径创建、cwd 是工作区（fixture 回显 process.cwd() 断言）；
2. stdin 注入：config/secrets/endpoint 经 `sdk.config()/secret()` 回显一致；
3. 业务失败：fixture `sdk.fail('门禁未通过')` → outcome failed、reason 含原因；
4. 异常退出：fixture 抛异常（exit 非零、无合法结果）→ failed、reason 含 exit code；
5. 超时：fixture sleep 长于 quota（注入 0.001 分钟级小值或直接用秒级构造）→ timeout、进程已被杀（无残留）；
6. 输出上限：fixture 写超大 stdout（maxOutputBytes 注入小值如 1024）→ failed('output too large')；
7. exit 0 无结果：fixture 直接退出 → failed('missing result')；
8. 业务日志：fixture `sdk.log('info',' masked ',{k:1})` + 一行非结构化 stderr → 日志文件含结构化行（level/message/fields）与原样行；**secrets 值不出现在日志文件**（fixture 打印一次 secret 值，断言文件中被替换为 `***`）；
9. 路径安全：event.session_id 含 `/` → run 抛错（不进目录创建）；
10. 只认一次：fixture return 两次/return 后再写垃圾 stdout → 采信第一个结果。

**sdk.test.ts**：

1. input/runInput/config/secret：管道喂 stdin JSON，各读口正确；secret 未注入名 → 抛错；无 stdin（空输入）→ 抛错；
2. return → stdout 是合法 StdoutResult(ok:true) 且进程 exit 0；fail → ok:false + exit 1；重复出口 → exit 1；
3. log → stderr 单行 JSON 含 `__biz_log`；fields 合入；
4. agent：测试起假 unix socket 服务端（node:net），断言收到请求行字段完整（token/op/skills/input/mode），回 ok:true → agent 返回 output；回 ok:false → agent 抛错；skills 空数组 → 本地直接抛错（不发 socket 请求）；
5. session.compact/clear：请求 op 正确，ok:true 正常返回；
6. run：子程序 fixture（收 input/config、回 output）→ 返回 output；子程序 ok:false → 抛错含 reason；子程序超时（timeout_ms 小值）→ 抛错；
7. 无 endpoint 调 agent → 抛错。

## 7. 验收标准

1. 两包各自 `build`/`test` 与根级六项检查全绿；
2. §6 清单全覆盖；runner 测试结束后无残留子进程（ps 校验或 detectOpenHandles 无异常）；
3. 导出签名与 §5 一致；SDK 依赖符合 §4 边界（只允许零依赖纯包，禁止 env 读取/全局外观/平台内部包）；runner 只依赖 §4 列出的包；
4. runner 全包无 `process.env` 读取（`process.execPath` 除外，它是运行时路径非环境配置）。

## 8. 导出清单

**`@easemob/agent-workflow-runner`**：值 `createWorkflowRunner`；类型 `WorkflowRunner`、`RunRequest`、`RunOutcome`、`WorkflowRunnerOptions`、`StdinEnvelope`、`StdoutResult`。

**`@easemob/agent-sdk`**：值 `sdk`；类型 `RunInput`、`AgentCall`。

## 9. 本规格的裁决点（设计文档未覆盖，主 agent 已定）

- **A. 新增 `sdk.runInput()`**：设计 RunInput 只覆盖流程入口（event+workspace）；子程序经 sdk.run 被调时读口是 input+config——契约递归同构需要这个读口，属真实需求驱动的最小新增。
- **B. SDK 形态 = 单例对象 + 允许依赖零依赖纯包**：`return` 是保留字无法做独立导出函数；`sdk.return()` 属性调用合法且与设计示例一致。一个业务进程 = 一次 run，单例无状态共享问题。SDK 位于 `packages/sdk/`（位置不等于发布边界）；可依赖 contracts 类型与 logger 纯函数层（如脱敏/格式化——`sdk.log` 是平台管控的日志控制点，业务密钥在源头脱敏、将来注入 run 级关联字段都一处生效），发布形态为平台 esbuild bundle 注入，业务零安装不变。
- **C. 子进程 `env: {}`**：平台环境变量（含平台自身密钥）不泄漏给业务进程；node 用 `process.execPath` 绝对路径启动，不依赖 PATH。secrets 只走 stdin。
- **D. socket 一次调用一条连接**：协议最简（无多路复用、无粘包问题），agent 调用是分钟级低频操作，连接开销可忽略。
- **E. stdout 只认第一个合法结果 + 全程字节上限**：协议污染与垃圾输出的机械边界（防线三）。
- **F. RunOutcome 独立于 scheduler.ExecutionResult**：runner 不依赖 scheduler 包（防循环、保层次），两者映射（含 usage）归装配根。
- **G. `secrets` 只随平台→流程注入**：sdk.run 不向子程序传 secrets（子程序需要的凭据由流程程序显式放进 args.config——业务自觉，平台不替它扩散密钥）。
