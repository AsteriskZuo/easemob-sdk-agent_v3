# 程序包模型

> 机制文档 + 作者指南。术语定义见 `design/glossary.md`。
> 本文是程序包作者的完整依据：**读完本文即可写出合格的程序包**。前身是 skill 包模型——资产单元从 skill 更正为**程序包**（skill 是包内的一种内容，不再是独立资产）。

## 1. 定位：资产单元 = 程序包

**程序包（package）是平台管理的唯一资产单元**：一个 git 仓库或上传包，内含子程序、skill、以及包自己需要的任何内容。平台不认识包的内容，只做三件事：登记（引用或上传母本 + 元数据）、校验（清单机械校验）、吊起执行（子进程，契约约束）。

包内可含：**多个子程序**（可执行入口）、**多个 skill**（给大模型的能力单元，SKILL.md 式公开规范、不为本平台适配）、其他资源（脚本、数据、文档，平台不解析）。

### 1.1 背景：为什么是程序包，不是 skill

**skill 没有消失，是归位了**——它是程序包内"给大模型用的能力"，依然重要。但业务的完整链路不是一个 skill 能承载的。以单轮审查工单为例：监控 jira webhook → 拉取工单 → 脱敏 → 大模型审查 → 还原 → 门禁检查 → 企微通知。这条链里只有"审查"一环需要大模型，其余全是机械环节和控制流。

| 维度 | skill | 子程序（程序包） |
|------|-------|-----------------|
| 本质 | 给 LLM 的能力说明书（活在会话内） | 可执行程序（进程） |
| 表达力 | "模型能调用什么" | 分支、循环、组合、多次调用大模型——完整控制流 |
| 机械环节（拉取/脱敏/门禁/还原） | 无法承载 | 普通代码 |
| 被谁调用 | LLM（不确定、按 token 计费） | 平台/流程程序（确定、零 LLM 成本） |
| 测试 | 难（行为在模型侧） | 普通单元测试 |
| 复用 | 被引用进会话 | `sdk.run` 被任何业务组合，契约递归同构 |

**对开发者的直接收益**：

1. **写普通程序，不学编排**：没有 DSL、没有 UI 拖动、没有"图和代码的映射层"——分支循环就是 if/for；
2. **机械环节不过大模型**：拉取/脱敏/门禁零 token、零延迟、行为确定；敏感信息物理上不进 LLM 上下文；
3. **重复工作平台全包**：事件接收、排队、同会话串行、多轮上下文、结果扇出、投递重试、日志采集——业务代码里一行都没有；
4. **离线可开发调试**：本地管道喂 mock 输入即可跑通整条流程（§5.1）；
5. **约束只有四条**（§5）：stdin 一段 JSON 进、stdout 一段 JSON 出、失败语义机械、日志走 stderr——和"一个 SKILL.md 说清楚自己"同一哲学：约定极简、能力完整。

### 1.2 开发者的工作重心：打磨 skill，不是写程序

工程载体是程序包，但**开发者的工作量不在程序上**。实际使用中，流程程序是模板提供的薄骨架（取数 → 脱敏 → `sdk.agent` → 还原 → 门禁 → 返回，一次成型、很少改动）；真正决定业务质量、需要反复打磨的是 **skill**——提示词的规则与边界、schema 的准确。审查工单审得好不好，取决于 skill 写得有多好，不取决于骨架代码。

分工一句话：**模板承担程序，平台承担运行，开发者专注 skill。**

### 1.3 为什么不是编排引擎

编排引擎（DSL / UI 拖动工作流）的本质是用受限语言模拟程序，表达力不够时最终都逃逸回代码；UI 与代码之间的映射层只会引入 bug 和维护成本。不如程序从一开始就是一等公民。

## 2. 可见性：三级

| 级别 | 语义 | 母本存放（上传模式） |
|------|------|---------------------|
| **公共** | 全平台业务可绑定；内置包随平台发布、首启登记，与用户上传的同规则 | `content/public/packages/` |
| **账号** | 归属创建者账号：该账号创建的所有业务可绑定 | `content/accounts/{账号id}/packages/` |
| **业务** | 只一个业务可绑定（业务自调试的私有包不进账号空间） | `content/businesses/{business_id}/packages/` |

**权限模型只有读 / 写两类**（包由生命周期执行，不构成独立权限）：读 = 查看、绑定进业务；写 = 推新版本、下架。三级均为「创建者或 admin 可写；读按可见性范围」。admin 兜底防创建者离线导致资产无人可管。**更新 = 同名登记新版本**：asset_id 内容变即变（§4），更新不打断使用旧版本的业务。

## 3. 提供方式：引用 / 上传 双模

| 模式 | 适用 | 内容本体 | 删除语义 |
|------|------|---------|---------|
| **引用**（推荐） | 大资产（带依赖的包、工具集） | 登记 git 地址（URL + commit/tag + 子路径），按需物化到 `cache/packages/{asset_id}/` | 物化是缓存，随时可清可重拉 |
| **上传** | 小资产（单个脚本包等） | 字节直接交平台，存 `content/` 对应可见性目录 | 母本，永不自动删 |

模式由提供者选，不按大小机械判定。

## 4. 平台元数据与 asset_id

登记时在包外附加元数据（不改写包内容）：

| 元数据 | 用途 |
|--------|------|
| **asset_id** | 内部编号：**引用模式 = 引用描述符 hash**（url + ref + 子路径，不下载即得）；**上传模式 = 整包内容 hash**。同包同 id 天然去重、内容变即 id 变（钉版本语义） |
| 可见性 / 创建者（owner_id） | 读写权限判定（§2） |
| 创建时间 / 修改时间 | 管理与审计 |

## 5. 子程序契约（作者必读：输入什么、输出什么、边界在哪）

平台对子程序的**全部**要求就四条：**子进程契约、机械边界、SDK 辅助、日志通道**。以下是完整字段级定义。

### 5.1 输入：stdin 一段 JSON（平台写完即关）

```jsonc
{
  "contract_version": "v1",
  "input": "<上游事件信封 或 sdk.run 的 args.input>",  // 必有。流程程序拿到的是事件信封（EventEnvelope）
  "workspace": "<run 工作目录绝对路径>",              // 平台注入；也是进程 cwd
  "config": { "jira_site": "..." },                  // 控制台登记的业务非机密配置；无则缺省
  "secrets": { "jira_token": "..." },                // 业务安全变量；仅平台→流程程序注入，sdk.run 不向子程序传
  "endpoint": { "socket_path": "...", "token": "..." } // agent 服务端点；sdk.agent()/session.* 使用
}
```

读法（SDK）：`sdk.input()` → `{ event, workspace }`；`sdk.config()` / `sdk.secret(name)`；子程序被 `sdk.run` 调用时用 `sdk.runInput()` → `{ input, config }`。**本地离线调试**：`echo '{"contract_version":"v1","input":{...},"workspace":"/tmp/x"}' | node dist/programs/xxx.js`。

### 5.2 输出：stdout 一段 JSON（只认第一个合法结果）

```jsonc
{ "contract_version": "v1", "ok": true,  "output": "<业务产出，派生事件的 payload，出口投递的就是它>" }
{ "contract_version": "v1", "ok": false, "reason": "<失败原因>" }
```

写法（SDK）：`sdk.return(output)` / `sdk.fail(reason)`——写出结果并退出进程，二者只生效一次。不用 SDK 的语言：手写这段 JSON 到 stdout 然后退出。

### 5.3 失败与边界（机械、fail-closed、无需声明）

| 项 | 规则 |
|----|------|
| 失败判定 | exit code 非零 / 超时 / 无合法结果 / stdout 超限 → failed（程序内任一步失败 = 整体失败，**不重跑**） |
| 超时 | wall-clock 默认 60 分钟（业务可配），到点 SIGTERM → SIGKILL |
| 输出上限 | stdout 累计 1MB，超限即杀即判 |
| 环境变量 | **清空注入**（`env: {}`）——平台环境不泄漏；凭据只走 stdin 的 secrets |
| 工作目录 | cwd = run 工作区（`runs/{source}/{session_id}/{business_id}/{run_id}/`，run 结束按 TTL 清理） |
| 日志 | stderr（用 `sdk.log`，见 §5.4）；stdout 只承载结果 |

### 5.4 日志与审计

- `sdk.log(level, message, fields?)`：写 stderr 结构化行，平台采集进该 run 的业务日志（`logs/businesses/{三维键}/{run_id}.log`）；**这是平台管控通道**——统一格式、secrets 源头脱敏、将来注入 run 级关联字段都在这一处生效，业务不要绕过它直接写 stderr（写了也会被原样采集，但不受管控）；
- agent 调用的真实 LLM 请求体由平台侧落盘审计（`before_provider_request`），业务无需也无法干预。

### 5.5 平台提供什么（依赖清单）

| 提供物 | 形态 | 用途 |
|--------|------|------|
| 入口事件 | stdin `input`（信封：source/session_id/event_type/payload/…） | 触发与上下文 |
| 业务配置 / 安全变量 | stdin `config` / `secrets` | 业务参数与凭据（不碰环境变量） |
| agent 调用 | `sdk.agent({skills, input, mode})`（模型凭据平台持有，不进业务进程；skills 可多个、可跨包） | 大模型推理；`mode:'channel'` 多轮连续 / `'fresh'` 独立 |
| 会话操作 | `sdk.session.compact()/clear()` | 多轮业务的上下文压缩/清空 |
| 子程序组合 | `sdk.run(program, {input, config?, timeout_ms?})` | 调用绑定包内的其他程序（同一契约） |
| 业务日志 | `sdk.log` | 排查追踪 |
| 结果扇出与投递 | 平台负责：`sdk.return` 的 output 自动派生事件 → 下游业务 + 出口绑定（企微/邮件/webhook…） | 业务不写任何通知代码 |

### 5.6 为什么经 SDK 调大模型，而不是自己直连

业务程序里**不允许也不值得**自己直接调大模型（HTTP 直连或自带 agent 框架），一律走 `sdk.agent()`。原因：

| 直连的代价 | SDK 的对应物 |
|-----------|-------------|
| 自带 agent 框架要准备运行环境（CLI、依赖、配置目录），云端运行环境不保证有 | **开箱即用**：不装任何东西，调用即得 |
| 模型 HTTP API 是无会话的，多轮对话要自己存消息、拼上下文、管窗口 | **会话连续性平台托管**：通道 ↔ 会话映射自动恢复/绑定（`mode:'channel'`），`compact/clear` 一句话 |
| 模型凭据进业务进程 = 泄漏面（日志、崩溃转储、依赖包都碰得到） | **凭据不出平台**：模型 key 由平台持有，业务进程里物理上不存在 |
| 失控循环烧钱无人拦 | **配额机械防线**：run 级调用次数上限 + wall-clock 超时，超限强杀 |
| 无审计：敏感内容是否进了 LLM 请求无法自证 | **请求体落盘审计**（`before_provider_request`），「敏感内容不出边界」的直接证据 |
| 用量、耗时、成本自己埋点 | **统一埋点上报控制台** |
| 提示词总纲、skill 白名单都要自己接线 | 平台按业务资料自动注入，白名单校验 |

一句话：直连不是"更自由"，是把平台已经做对的六件事（会话、凭据、配额、审计、埋点、注入）重新做一遍，还大概率做不对。

补充几条同样重要的：

| 直连的代价 | SDK 的对应物 |
|-----------|-------------|
| 换模型/换厂商/升级 agent 内核，每个业务都要改代码 | **切换在平台侧完成**，业务零改动（模型选择是业务资料，不是代码） |
| 直连完全绕过平台通道：配额、白名单、审计全部失效 | **守卫只能挂在平台通道上**：审计 extension（`-e` 注入）在 LLM 请求边界强制落盘，业务摘不掉 |
| 厂商 429/超时/限流各自为政 | **失败策略统一**（第二阶段的重试预算、失败分类一处生效） |
| 业务自己起 agent 进程，绕过平台并发闸门，机器被打爆 | pi 子进程百 MB 级，**业务闸门总量控制**（`task_concurrency`） |
| 日志/埋点与事件链断裂（无法按 event_id 回溯一次联动） | 关联键全链一致（event_id/correlation_id/channel_id），问题可回溯 |

## 6. 清单契约（agent-package.json）

包根目录的清单文件，**平台唯一解析的包内文件**：

```jsonc
{
  "name": "jira-tools",                 // 包名（限定名解析用）
  "version": "1.2.0",                   // 推荐字段
  "programs": {                         // 子程序名 → 入口文件（相对包根，转译后的 JS）
    "jira-fetch": "dist/programs/jira-fetch.js",
    "restore": "dist/programs/restore.js"
  },
  "skills": ["skills/ticket-review"]    // 包内 skill 路径（可选）
}
```

登记/初始化时的机械校验：清单存在且合法 JSON；programs/skills 的每条路径在包内真实存在。校验不过 = 登记/初始化失败。

**skill 获取规则（包自洽原则）**：包用到的 skill **自带在包内**（`skills/` 目录，随包版本化）；用别包的能力 = 业务绑定那个包（平台初始化时物化），不允许程序运行时够包外的路径。平台侧：业务初始化按绑定物化全部包（先公共、再账号、再业务级），`sdk.agent` 的 skill 白名单 = 绑定包清单的 skills 并集。

## 7. 绑定与名解析

业务绑定**多个**程序包。包内资源名的解析范围 = 该业务绑定的全部包：

- `sdk.run('jira-fetch')` → 在绑定包的 programs 中解析；
- `sdk.agent({ skills: ['ticket-review', 'output-format'] })` → 白名单 = 绑定包的 skills 并集，逐个校验、逐个注入（可一次多个、可跨包）；
- **同名冲突**：按可见性优先级 **业务级 > 账号级 > 公共** 首个命中；也支持 `包名/资源名` 限定写法消除歧义。

## 8. 包结构与工程模板

平台提供**模板包**（`templates/agent-package/`，拷贝即用），内置与平台一致的完整工具链，作者只写 `src/` 里的业务代码：

```
my-package/
├── agent-package.json      # 清单（§6）
├── package.json            # dependencies: @easemob/agent-sdk；
│                           # devDependencies 与脚本封装好：build(tsc) / test(jest+esbuild) /
│                           # lint(eslint) / format(prettier) / circular(dpdm)——与平台同构
├── tsconfig.json           # ESM NodeNext（相对导入带 .js 后缀）
├── eslint.config.js / .prettierrc
├── src/
│   └── programs/
│       └── main.ts         # 流程程序入口骨架（见下）
├── skills/
│   └── example/SKILL.md    # 示例 skill
└── tests/                  # jest 单测（jest+esbuild 编译态，与平台同约定）
```

流程程序入口骨架（模板内置，直接在上面改）：

```ts
import { sdk } from "@easemob/agent-sdk";

const { event, workspace } = sdk.input();          // 入口信封 + 工作区
sdk.log("info", "run started", { event_id: (event as any).event_id });

// 1. 检查：输入不合规 = 直接失败（不扇出、下游不触发）
// 2. 取数/脱敏：sdk.run('jira-fetch', { input: ..., config: { token: sdk.secret('jira_token') } })
// 3. 大模型：const review = await sdk.agent({ skills: ['ticket-review'], input: masked });
// 4. 还原/门禁：不合格 → sdk.fail('门禁未通过')
// 5. 唯一出口：结果由平台扇出（下游关注 + 出口绑定投递）
sdk.return({ summary: "…" });
```

**规则**：模板的 lint/test/format/circular 配置与平台同构同版本——包在作者本地就能跑全检查，提交前即合格；`@easemob/agent-sdk` 由平台发布（业务零安装、运行时由平台注入解析路径），本地开发期经 npm 或 file: 引用安装。

## 9. 物化与业务初始化

**业务初始化**（创建/变更业务时执行）：按序物化该业务绑定的全部程序包——**先公共、再账号、再业务级**（顺序即覆盖优先级）。初始化物化失败（拉取失败/清单校验不过）→ **业务创建/变更失败**（fail-fast，控制台可见）。运行时兜底：执行前发现物化缓存缺失（被清理）→ 先补物化再执行；补拉失败 → 本次 run failed，不影响平台与其他业务。

## 10. skill 在包内的角色（注入机制与审计）

**注入机制（pi 实证）**：`sdk.agent({ skills: ['名', ...] })` 时，平台把每个 skill 名解析为物化后的包内路径（§7 名解析，可多个、可跨包），起 pi 子进程时一律带 `--no-skills`（关闭 cwd/用户目录的 skill 自动发现）+ 逐个 `--skill <路径>` 白名单注入（pi 的 `--skill` 可多次指定，路径各自独立）——与 extension 的 `-e` + `--no-extensions` 同一条纪律。`--no-skills` 不可省：pi 子进程 cwd 是 run 工作区，不关闭自动发现，业务往工作区丢 skill 目录即绕过白名单。skill 内容由 pi 自行渐进加载，**按需注入为默认**（不占满上下文窗口）。

业务侧**没有 `sdk.skill` 注册接口**：skill 是包内静态资产（清单声明、初始化物化、路径平台已知），按名引用即可；运行时动态注册 skill 会绕过清单校验与白名单，不支持。

- **skill 不可附带 pi extension**（业务侧无会话内代码）：脱敏/还原/门禁等守卫全部在会话外的流程程序内（`design/business-workflow.md` §5），执行顺序由业务代码显式控制——这比会话内 hook 更直观、可测、可调试；会话内只有平台注入的审计 extension（`-e` 白名单，业务不可摘除）。将来出现真实的会话内守卫需求再开放，装配清单多一类 `-e` 而已；
- 会话内注入物（本版仅平台审计 extension）遵守 hooks 三条纪律（fail-closed、判定自写结构化日志、`before_provider_request` 落盘审计）——唯一定义处：`design/business-workflow.md` §4；
- **工具调用预算**：按任务设置调用次数/费用上限，防模型死循环调工具。

## 11. MCP

**不支持，后续是否支持待定，不预留接口。** 理由：各家大模型对 MCP 的支持程度与配置方式差异明显，远没有 skill 规范统一、标准。
