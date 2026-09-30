# 业务工作流：代码即流程

> 日期：2026-09-27
> 状态：定稿
> 定位：业务执行模型的**唯一定义处**——业务流程程序、业务 SDK、agent 调用服务、子程序契约、稳定性边界。术语定义见 `design/glossary.md`；选型理由见 `docs/decisions/2026-09-27-business-workflow-code-as-workflow.md`；agent 内核与沙箱分期见 `docs/decisions/2026-09-27-agent-kernel-and-execution-mode.md`。

---

## 1. 定位：业务 = 业务流程程序 + 业务资料

**业务流程程序**是业务侧编写的独立可执行程序（TypeScript + 业务 SDK），承载业务的全部流程逻辑：分支、循环、多次大模型调用、检查/获取/脱敏/还原/门禁等环节，都是程序里的普通代码。**平台不做流程编排，不认识业务内容**——平台对业务的全部认知就是：一个可以被 spawn 的程序、一份控制台登记的业务资料。

业务资料（控制台管理，见 `design/console-design.md` §4）：提示词总纲、包/工具/skill 绑定、agent、大模型、入口、出口、key-value 配置。资料是**资源声明**，流程程序是**使用资源的方式**。

**为什么不是流程语言/编排引擎**：见决策记录。一句话——DSL 表达力不够时最终都要逃逸到程序，不如程序从一开始就是一等公民。

## 2. 执行模型：一入一出

平台对业务流程程序的关键约束只有一个：**一个入口，一个出口**。

```
平台（WorkflowRunner）
   │  spawn 业务流程程序（独立子进程）
   │  stdin  ← 入口信封 + 注入上下文（JSON，SDK 读取）
   │  stdout → 唯一结果（JSON，SDK 写入，只认一次）
   │  进程退出 = 本次 run 结束
```

- **子进程契约**：stdin 一段 JSON（输入）、stdout 一段 JSON（结果）、exit code 非零或超时 = 失败（fail-closed）。这是平台与业务之间唯一的线；契约带 `contract_version: 'v1'`（版本纪律同事件契约，`design/event-contract.md` §2）；
- **业务上下文业务自己管理**：流程中的中间数据（如脱敏 kv）就是程序内的变量，平台不持有、不传递；
- **平台注入的额外上下文**：入口信封、业务环境配置与安全变量、run 工作目录、agent 服务端点——经 stdin 与环境变量在启动时一次性注入；
- **结果校验**：平台只对 stdout 结果做 schema 校验与大小上限（大产物走引用，见 `design/event-contract.md`），不解析内容。

**运行时形态**：业务流程程序来自业务绑定的**包**（`design/asset-model.md`：git 仓库登记，初始化时物化/转译就绪——TS 源码经 esbuild 转译存 JS，平台运行时零编译，类型检查是业务开发期的事）；业务 SDK 由平台注入 run 环境的依赖解析路径（sdk 连同其零依赖纯包依赖 esbuild bundle 注入），业务零安装、只 import；`WorkflowRunner.run({program})` 的 `program` = 绑定包中选定入口程序的物化产物文件。

**无挂起/恢复**：多轮交互的连续性由通道模块承接（`design/channel-model.md`），流程程序本身跨 run 无状态。

## 3. 业务 SDK：业务侧的唯一编程面

业务用户不直接接触进程管理、stdin/stdout 协议、socket 通信——这些全部封在 SDK 内。**SDK 的 API 表面积就是业务侧需要学习的全部**。

```ts
/** 业务 SDK v1（发布物，业务程序的唯一依赖；本节是 SDK API 面的唯一定义处——
 *  最小设计：业务侧需要的全部接口就这些，新增 API 由真实需求驱动） */
interface Sdk {
  /** 读入口：入口信封 + 平台注入上下文 */
  input(): RunInput;

  /** 读控制台为本业务登记的配置（非机密） */
  config(): Record<string, string>;

  /** 读本业务安全变量（平台注入，业务不碰环境变量） */
  secret(name: string): string;

  /** 调大模型服务（经 socket 到平台 agent 调用服务执行；配额在此强制）。
   *  skills 为本次注入的 skill 名（可多个、可跨 skill 集合，服务端逐个 --skill 注入）；
   *  每个都必须在业务绑定的 skill 集合内（平台校验）；提示词总纲与模型由平台按业务资料注入。
   *  mode 默认 'channel'：沿用/恢复当前通道的 agent 会话（多轮业务的每轮调用都是它）；
   *  'fresh'：独立会话、不写通道映射（单 run 内初审→复审这类额外调用，上下文不串味） */
  agent(call: { skills: string[]; input: unknown; mode?: 'channel' | 'fresh' }): Promise<unknown>;

  /** 当前通道的 agent 会话操作：多轮业务处理 /compact、/clear 类用户命令用。
   *  命令的识别归业务（用户消息原样到达流程程序，平台不识别不翻译），平台只提供通用会话能力 */
  session: {
    /** 压缩当前通道的 agent 会话上下文（由 pi 执行） */
    compact(): Promise<void>;
    /** 清空映射：之后的 agent 调用使用全新会话（通道标识不变，历史按时间追溯） */
    clear(): Promise<void>;
  };

  /** 调子程序：spawn 独立程序，同一子进程契约（§2），超时与编解码全封装 */
  run(program: string, args: { input: unknown; config?: Record<string, string>; timeout_ms?: number }): Promise<unknown>;

  /** 写业务日志：结构化行写 stderr，平台采集进该 run 的业务日志（design/logging.md §1）。
   *  这是平台管控的日志通道（控制点）：统一格式、源头脱敏、将来注入 run 级关联字段
   *  （run_id/event_id/correlation_id）都在此处一处生效——业务不要绕过它直接写 stderr */
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, fields?: Record<string, unknown>): void;

  /** 唯一出口：成功返回结果。只生效一次，之后进程退出 */
  return(result: unknown): never;

  /** 唯一出口：失败。只生效一次，之后进程以失败退出 */
  fail(reason: string): never;
}

/** input() 的返回：入口信封 + 平台注入的运行上下文。
 *  信封自带 source / session_id / channel 相关字段——业务据此获得当前执行的足够上下文 */
interface RunInput {
  event: Event;        // 触发信封（design/event-contract.md v1）
  workspace: string;   // 本 run 的隔离工作目录（cwd）
}
```

纪律：

- **SDK 是约定层，不是封锁层**——它让正路最好走，但物理上封不死业务进程绕过它；真边界在系统层（沙箱分期，见 §7）；
- SDK 版本化发布，业务程序钉版本（与契约优先原则一致）；
- 业务因此可以**离线开发调试**：本地喂 mock 输入即可跑通整条流程（实证形态见 `docs/researches/jira-review-masking-hooks/run-all.sh`）。

**示例：单轮审查工单业务（伪代码，对应 §8 验收链路与 `design/validation.md` B.2）**

```ts
// 业务的全部流程逻辑就长这样——平台只看到一次 spawn、若干次 agent 调用、一个最终结果
const { event, workspace } = sdk.input();           // webhook 信封：只含工单号，不含内容
const key = (event.payload as any).ticket_key;

// 检查环节：输入不合规 = 直接失败（不扇出、下游不触发）
if (!key) return sdk.fail('输入未就绪：缺工单号');

// 子程序环节：拉取工单（jira 凭据由业务持有，不过大模型）
sdk.log('info', 'fetch ticket', { key });
const ticket = await sdk.run('jira-fetch', {
  input: { key },
  config: { site: sdk.config().jira_site, token: sdk.secret('jira_token') },
});

// 子程序环节：脱敏。kv 是本程序的局部变量——业务上下文业务自己管理，平台不持有
const { masked, kv } = await sdk.run('masking', { input: ticket });

// 大模型审查：总纲由平台注入；skills 须在业务绑定的 skill 集合内（可多个、可跨集合）；全程只接触脱敏内容
const review = await sdk.agent({ skills: ['ticket-review'], input: masked });

// 子程序环节：按 kv 还原
const restored = await sdk.run('restore', { input: { text: review, kv } });

// 门禁环节：机械校验结果，不合格 = 失败（不重做）
if (!gateCheck(restored)) return sdk.fail('门禁未通过：结果不合规');

// 唯一出口：结果经平台扇出（下游关注 + 企微群 webhook 出口）
sdk.return(restored);
```

## 4. agent 调用服务（Agent Service）

`sdk.agent()` 的另一端，平台侧模块。**大模型调用只能经此服务发生**——模型凭据由平台持有，不进入业务进程。

| 环节 | 约定 |
|------|------|
| 通道 | 每个 run 一个本地 unix socket + 一次性 token，启动时注入；token 随 run 结束失效；socket 协议同样带 `contract_version` |
| 执行 | 平台 spawn pi 子进程（决策已定，pi 是唯一内核）；cwd = run 工作目录 |
| 提示词总纲 | 平台按业务资料自动注入，业务代码无需传入 |
| skill 与审计 | `skills` 可多个、可跨 skill 集合；每个都必须在业务绑定的 skill 集合内（白名单校验），按名解析为物化路径后经 `--no-skills` + 逐个 `--skill` 注入；平台审计 extension 经 `-e` + `--no-extensions` 注入（不支持业务 extension，机制见 `design/asset-model.md` §10） |
| 会话连续性 | 平台按通道映射恢复/绑定 agent 会话（`design/channel-model.md`），业务代码无感；单 run 多次调用时，`mode: 'channel'` 的调用共享通道会话，`'fresh'` 各自独立 |
| 配额 | 按 run 计：agent 调用次数上限 + wall-clock 超时（默认 60 分钟，业务可配）——超限强杀，防失控循环 |
| 埋点 | token 用量、耗时、成本统一上报控制台 |
| 审计 | `before_provider_request` 落盘真实 LLM 请求体——「敏感内容不出边界」的唯一直接证据 |

**hooks 三条纪律**（依据实测调研；本版业务侧无 extension，直接约束平台注入的审计 extension）：

1. **fail-closed**：hook 解析/执行异常 = 阻断，不是放行；
2. **判定自写日志**：hook 阻断不反映在进程退出码（exit 0），判定以 hook 自写的结构化判定日志为准；
3. **边界审计**：每次调用落盘 LLM 请求体，审计闭环。

## 5. 子程序与业务环节

业务内部的**检查、数据获取、脱敏、还原、门禁**等环节，两种实现形态，业务自择：

- **函数**：纯逻辑（如正则判断），直接写在流程程序内；
- **子程序**：需要隔离、需要别的语言、需要跨业务复用时，写成独立程序，经 `sdk.run()` 组合。

**子程序的提供与约束**：子程序由**包或工具资产**提供（清单 `programs` 声明入口，名解析规则见 `design/asset-model.md` §6）；约束 = 子进程契约（§2）+ 机械边界（§6）+ 日志走 stderr——完整四条见 `design/asset-model.md` §7。Node/TS 程序用业务 SDK 即天然合规；其他语言按契约自行实现。

子程序与业务流程程序遵守**同一个子进程契约**（§2）——契约递归同构：一个环节程序今天被某业务的流程调用，明天可以被别的业务复用，无需修改。

**门禁由此重新定位**（唯一定义仍在 `design/glossary.md`）：门禁/检查不再是平台概念，没有平台挂接点、没有平台契约——它们是业务流程程序内部的环节，由业务代码实现（机械程序优先；需要语义判断时经 skill/大模型）。平台的对应物只有内容无关的机械边界（§6）。

## 6. 失败语义与稳定性边界

**失败语义**：run 内任何一步失败 = 整个 run 失败——流程程序 `sdk.fail()` 或异常退出，平台打标 failed + error 日志。**不重跑、不断点续跑**；扇出规则不变（默认不扇出，`on_failure` 例外，见 `design/processing-chain.md` §2）。

**稳定性是一等设计目标**：平台是可依赖的基础组件，业务是不可信的租户代码。**任何业务错误不得影响平台与其他业务**。四道机械防线：

| 防线 | 防什么 |
|------|--------|
| 子进程隔离 | 业务崩溃、`process.exit`、异常不带住平台进程 |
| 超时强杀（wall-clock） | 死循环、挂起 |
| 输出大小上限 + schema 校验 | 垃圾输出、协议污染（业务 stdout 由 SDK 写入，协议错误在 SDK 层被挡） |
| agent 调用配额 | 失控循环烧钱 |

业务之间互不可见：进程隔离 + 每 run 独立 socket/token + 环境配置按业务注入（`design/console-design.md` §9）。

## 7. 沙箱兼容纪律

第一阶段不实现沙箱（依据与分期见 agent 内核决策记录），但现在的设计必须不挡路：

- 业务流程程序从第一天起就是子进程——沙箱隔离的单位天然到位；
- 每个 run 的资源需求**显式声明**：可写工作目录、注入凭据、只读仓库——这些声明就是第二阶段沙箱 profile/容器配置的直接输入，零桥接；
- 裸跑期警惕代码产生越界隐性依赖，可用沙箱模式冒烟及早暴露。

## 8. 验收锚点：单轮审查工单

平台实现完成后，以**单轮审查工单**业务全链做端到端验收（对应 `design/validation.md` B.2）：

```
webhook 入口（工单号，不含内容）
  → 检查环节（输入是否合规）
  → 子程序：拉取工单内容
  → 子程序：脱敏（产出 kv，存程序内变量）
  → sdk.agent()：大模型审查（只接触脱敏内容；jira 凭据不过大模型）
  → 子程序：按 kv 还原
  → 门禁环节（结果是否合规，不合格 = fail，不重做）
  → sdk.return() → 派生事件扇出 → 企微群 webhook 出口
```

该链路的子程序已有实验产物（`docs/researches/jira-review-masking-hooks/`：jira 工具、脱敏、还原），是现成的试金石。
