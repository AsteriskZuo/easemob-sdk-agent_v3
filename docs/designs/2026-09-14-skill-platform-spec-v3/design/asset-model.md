# 资产模型

> 机制文档 + 作者指南。术语定义见 `design/glossary.md`。
> 本文是资产作者与业务创建者的完整依据：**读完本文即可写出合格的资产并完成业务组合**。前身是程序包模型（package-model.md）——资产单元从单一「程序包」演进为三族：**包、工具、skill**。

## 1. 总览：三族资产

| 资产 | 本质 | 共享 | 消费方 |
|------|------|------|--------|
| **包（package）** | 业务代码单位：流程程序入口 + 胶水代码（依赖业务 SDK），**能独立完成一个任务** | 不共享 | 平台 spawn 流程程序；`sdk.run` 同包程序 |
| **工具（tool）** | 可复用代码组件（jira-fetch、脱敏、还原…），**不能独立完成业务任务** | 创建时定、不可改 | `sdk.run` 白名单 |
| **skill** | 可复用提示词组件（SKILL.md 式公开规范），给大模型的能力单元 | 创建时定、不可改 | `sdk.agent` 白名单 |

组合公式（概念组成，**不是封闭枚举**——故带「等」）：**业务 = 包 + 配置 + 工作区（运行时平台注入）等**；**包 = 胶水代码 + 独立工具 + skill + 总纲提示词 + sdk 等**。机制上：工具与 skill 的绑定关系挂在业务上（业务 → 包 / 工具 / skill 三类绑定），包与工具/skill 之间没有自动牵引，只有清单里的名字级声明（§5.1 requires）；总纲提示词是**业务资料字段**（控制台登记，`design/console-design.md` §3），平台在每次 agent 调用时自动注入；工作区是 run 级暂存目录（§7.3）。

**总纲提示词不共享、不是资产**：它向大模型说明这个业务是什么——规则、边界、要求、不可做，是业务的灵魂之一，完全属于该业务（没有共享场景），故不进资产三族、无共享标记。

**用不用、用什么，自由在包**：是否用独立工具、是否写总纲、是否挂 skill，全由包按自己的实际业务决定——它为完成一个任务而存在，用什么它自己说了算。典型业务都会挂 skill：没有 skill 的业务自己写个脚本就够了，不必上平台（纯机械流水线也能吃平台的接入/串行/扇出/日志托管，设计上不禁止，但大模型能力才是多数业务的核心理由）。

三族资产物理上各自独立管理（各自可以是不同仓库），**使用的时候组合**：业务创建时绑定，平台物化闭包、按名解析（§6/§9）。

### 1.1 背景：为什么是三族

**skill 没有消失，是归位了**——它是"给大模型用的能力"，依然重要；**工具也没有消失**——它是"不给大模型用的机械能力"（拉取/脱敏/门禁零 token、零延迟、行为确定）。以单轮审查工单为例：监控 jira webhook → 拉取工单 → 脱敏 → 大模型审查 → 还原 → 门禁检查 → 企微通知。这条链里只有"审查"一环需要大模型。

| 维度 | skill | 工具 / 包内程序 |
|------|-------|-----------------|
| 本质 | 给 LLM 的能力说明书（活在会话内） | 可执行程序（进程） |
| 被谁调用 | LLM（不确定、按 token 计费） | 平台/流程程序（确定、零 LLM 成本） |
| 测试 | 难（行为在模型侧） | 普通单元测试 |

**复用性决定资产分族**：包是业务单位，通常唯一、不共享（复用胶水代码走 git 本身：fork / 拷贝 / 各自登记 URL）；工具和 skill 是组件，复用是常态——A 业务和 B 业务用同一个 ticket-review、同一个 jira-fetch，而且都不需要维护它。所以工具和 skill 有共享标记，包没有。

**对开发者的直接收益**：

1. **写普通程序，不学编排**：没有 DSL、没有 UI 拖动——分支循环就是 if/for；
2. **机械环节不过大模型**：敏感信息物理上不进 LLM 上下文；
3. **重复工作平台全包**：事件接收、排队、同会话串行、多轮上下文、结果扇出、投递重试、日志采集——业务代码里一行都没有；
4. **约束极简**：子程序契约四条（§7），skill 一个 SKILL.md（§5.2）——约定极简、能力完整。

### 1.2 开发者的工作重心：打磨 skill，不是写程序

工程载体是包，但**开发者的工作量不在程序上**。流程程序是模板提供的薄骨架（取数 → 脱敏 → `sdk.agent` → 还原 → 门禁 → 返回，一次成型、很少改动）；真正决定业务质量、需要反复打磨的是 **skill**——提示词的规则与边界、schema 的准确。分工一句话：**模板承担程序，平台承担运行，开发者专注 skill。**

## 2. 属主与共享

- **属主**：每个资产有且只有一个属主账号（创建者）；属主管理它（登记新版本、下架）；
- **共享标记**：工具与 skill 在**登记时**决定 `shared: true | false`，**设置后不可修改**——共享改私有会使他人业务里的已有绑定瞬间悬空，这一类问题直接消灭在出生前；想改 = 重新登记一个资产；
- **绑定规则**：能绑定 = **自己的全部资产 + 他人标记共享的资产**；
- **admin**：管理通用配置与人员；对全部资产**只读**；**不持有任何资产**。创建者停用后，其共享资产继续可用（资产行只是 git 指针，仓库还在、物化还在）；接手 = fork 仓库、登记新资产并共享——不需要 admin 代管；
- **包不共享**：业务代码天然按属主隔离；想用别人的包，登记同一个 git URL 为自己的资产即可（资产只是指针，无文件拷贝）。

## 3. 来源与唯一标识：git 三元组

**资产唯一来源 = git 仓库**（GitHub / 内网 git 均可）。没有上传模式、没有本地内容 hash、没有母本存储——代码的托管与分发是 git 的天然职责，平台不重复造。

- **资产身份 = (url, commit, 子路径) 三元组**：一个仓库根、或仓库内一个子路径（monorepo 里每个工具/skill 集合一个资产行）；
- **登记时钉版本**：可给分支/tag/commit，平台登记时用 `git ls-remote` 把分支/tag **解析成 commit 存定**——分支会移动，存 commit 才是钉版本。**更新 = 登记新 commit = 新资产行**，更新不打断使用旧版本的业务；
- **asset_id** = (属主 + 三元组) 的紧凑编码（短 hash），仅作 db 主键与目录名；唯一性按属主维度——同一三元组不同属主 = 不同资产行，各自管理；同（属主+三元组）重复登记 = 幂等返回已有；
- **平台元数据**（登记时附加，不改写仓库内容）：asset_id、kind（`'package' | 'tool' | 'skill'`）、owner_id、shared、创建时间。登记记录入库（状态），内容物化在 `cache/assets/{asset_id}/`（缓存，可清可重拉）。

### 3.1 托管平台与私有仓库凭据

- **托管平台无关**：GitHub / Gitee / 内网 git 一视同仁——登记与物化只走 git 协议（ls-remote / clone / checkout），平台不认识、也不需要认识任何托管平台的 API。PR 创建等托管平台特有操作是**工具资产的职责**（github 工具；将来需要时再封装 gitee 工具），与平台资产管理无关；
- **私有仓库凭据**：公开仓库零凭据；私有仓库在登记时声明 `is_private: true` + `credential_key`（一个 key 的**名字**，指向安全桶里的访问 token）。**资产行只存名字不存值**；
- **凭据按操作者维度解析**：谁触发物化（登记 / 业务初始化 / 运行时补拉），就用**谁的安全桶**里 `credential_key` 对应的值，临时注入 git 进程（不落盘、不进日志、不出现在错误信息里）。使用者之间完全独立、互不相干——一个仓库可以有多个维护成员，各自凭各自的权限；权限不够 = git 报错，失败自解释；
- **共享资产建议用公开仓库**（零凭据最干净）。非要共享私有仓库：每个使用者自己的安全桶里都要有同名 `credential_key`，且该凭据对仓库有读权限——平台不做跨账号的凭据转借；
- **平台不建读写权限模型**：包的写操作（push / 开 PR）由包内程序用业务 secrets 里的用户 token 发起，token 的权限范围用户自负——权限不对操作自然失败，错误信息即提示。平台再加 read/write 属性既拦不住什么，又会与 token 实际权限脱节，不做。

## 4. 权限模型小结

权限只有读 / 写两类（资产由生命周期执行，不构成独立权限）：读 = 查看、绑定进业务（规则见 §2）；写 = 属主推新版本、下架。admin 对全部资产只读（运维兜底视角），不写。

## 5. 清单契约

### 5.1 包与工具：agent-package.json

包与工具共用同一份清单契约（同一文件、同一套字段校验），只有一处差异：**`requires` 是 package 专属字段**——工具是叶子组件（机械能力、零 token），需要组合时由包的胶水代码编排，工具不声明依赖。资产根目录的清单文件，**平台唯一解析的包内文件**：

```jsonc
{
  "name": "jira-tools",                 // 包名
  "version": "1.2.0",                   // 推荐字段
  "programs": {                         // 子程序名 → 入口文件（相对资产根，转译后的 JS）
    "jira-fetch": "dist/programs/jira-fetch.js",
    "restore": "dist/programs/restore.js"
  },
  "requires": {                         // 可选（仅 package 可有；tool 出现此字段即校验失败）：名字级依赖声明（不钉版本）
    "tools": ["masking"],               //   本包代码 sdk.run 引用的外部工具名
    "skills": ["ticket-review"]         //   本包代码 sdk.agent 引用的 skill 名
  }
}
```

**机械校验**（物化时执行，校验不过 = 物化失败）：清单存在且合法 JSON；`name` 非空；`programs` 每条路径是相对路径、不含 `..` 段、扩展名 `.js`（形状规则，构建前校验）；`requires`（若有）是字符串数组；**tool 清单出现 `requires` 字段即校验失败**（防误配：静默忽略会让作者误以为依赖声明生效）。`programs` 指向的是物化构建产物，**存在性在构建后校验**（每条路径必须真实存在且是文件，缺一即失败并列出缺失清单，见 §9）。

**requires 的角色**（仅 package）：声明依赖的**身份**（名字），版本钉在**业务绑定**里——名字与版本分离，升一次 skill 版本只需控制台重绑，不逼着包仓库改代码。控制台在业务绑定配置期机械校验 requires 的名字是否都被绑定覆盖，缺绑 = 配置期报错（fail-fast 在配置期，不是运行时），并按名自动建议可绑资产。requires 同时是包作者的自文档：读清单即知此包要什么。

### 5.2 skill 集合

skill 资产 = 一个 **skill 集合**：约定**资产根下每个含 SKILL.md 的直接子目录是一个 skill，技能名 = 目录名**（机械可扫，无清单文件）。SKILL.md 遵循公开 skill 规范（frontmatter + 正文），**不为本平台做任何适配**。校验：资产根下至少一个合法 skill 目录。

最低形态示例：

```markdown
---
name: ticket-review
description: 审查 jira 工单并给出通过/驳回结论与理由
---
你是工单审查员。按以下规则审查……（规则与边界、输出 schema）
```

## 6. 绑定与名解析

业务绑定：**恰好 1 个包**（流程程序入口的唯一来源，控制台从它的 programs 里选入口）+ **任意多工具** + **任意多 skill 集合**。

- `sdk.run('jira-fetch')` → 解析范围 = 本包 programs ∪ 绑定工具的 programs；
- `sdk.agent({ skills: ['ticket-review', 'output-format'] })` → 白名单 = 绑定 skill 集合的技能并集，逐个校验、逐个注入（可一次多个、可跨集合）；
- **名唯一性由配置期保证**：绑定时机械查重（同业务的绑定集合里程序名不重复、技能名不重复），**重复即拒绝**（控制台校验 + 管理 API 兜底，不做隐式首命中）——运行时解析因此无需优先级、无需限定写法，按名唯一命中；找不到 = 运行时报错（绑定在运行后被改或物化异常）。

**程序名解析机制**：平台物化闭包后产出 **程序名 → 物化绝对路径** 的全量映射（本包 programs ∪ 绑定工具 programs），spawn 流程程序时经 stdin 信封注入（§7.1 `programs` 字段），`sdk.run('名')` 按名查表得绝对路径后 spawn 子进程。**业务按名使用、从不配置路径**——资产的物理位置是平台内部计算结果（`cache/assets/{asset_id}/`，业务无从预知），对外暴露的只有 git 引用（url + commit + 子路径）与程序名。平台给业务的是绝对路径的**使用权**，不是**管理权**。

**包内程序与共享工具的分工**：

| 形态 | 调用方式 | 典型场景 |
|------|---------|---------|
| 包内程序（包仓库的 programs） | 同仓库路径可知：**可直接 import 进程内调用**，也可 `sdk.run` 走子进程隔离——包按需要自己决定 | 本业务专用环节（如该业务的门禁校验） |
| 共享工具（独立工具资产） | **只能 `sdk.run` 按名调用**（跨仓库，物理位置只有平台知道） | 跨业务复用的机械能力（jira-fetch、脱敏、还原） |

工具资产的主场景是**共享复用**；包内自用的程序不必登记成工具资产——登记成资产是为了被别人绑定。

**skill 获取规则**：`sdk.agent` 用到的 skill 一律来自绑定的 skill 资产，**包内不内嵌 skill**。想单仓开发：同一仓库注册两次（根 = 包、`skills/` 子路径 = skill 集合），同 commit 两行资产，单仓自洽；将来要复用共享，把该目录拆成独立仓库即可——**业务代码零改动**（代码引用的是名字，不是路径）。

## 7. 子程序契约（作者必读：输入什么、输出什么、边界在哪）

平台对子程序的**全部**要求就四条：**子进程契约、机械边界、SDK 辅助、日志通道**。包与工具的程序同契约。

### 7.1 输入：stdin 一段 JSON（平台写完即关）

```jsonc
{
  "contract_version": "v1",
  "input": "<上游事件信封 或 sdk.run 的 args.input>",  // 必有。流程程序拿到的是事件信封（EventEnvelope）
  "workspace": "<run 工作目录绝对路径>",              // 平台注入；也是进程 cwd
  "config": { "jira_site": "..." },                  // 控制台登记的业务非机密配置；无则缺省
  "secrets": { "jira_token": "..." },                // 业务安全变量；仅平台→流程程序注入，sdk.run 不向子程序传
  "endpoint": { "socket_path": "...", "token": "..." }, // agent 服务端点；sdk.agent()/session.* 使用
  "programs": { "jira-fetch": "/abs/.../jira-fetch.js" }, // 程序名→物化绝对路径映射（本包 ∪ 绑定工具，§6）；
                                                          // 仅平台→流程程序注入，sdk.run 不向子程序传
  "dataDir": "/abs/.../data/{source}/{session_id}/{business_id}/" // 业务级持久目录（跨 run 状态落点，run 启动时已建）；
                                                          // 仅平台→流程程序注入，sdk.run 不向子程序传
}
```

读法（SDK）：`sdk.input()` → `{ event, workspace }`；`sdk.config()` / `sdk.secret(name)`；子程序被 `sdk.run` 调用时用 `sdk.runInput()` → `{ input, config }`；`programs` 映射业务代码不直接读——由 SDK 内部的 `sdk.run` 按名查表消费。**本地离线调试**：`echo '{"contract_version":"v1","input":{...},"workspace":"/tmp/x"}' | node dist/programs/xxx.js`——工具的「可独立运行」就是这个含义：dist 自包含、node 直接跑，输入走 stdin 契约。

**平台→流程程序 与 sdk.run→子程序的注入差异**（机制强制，不是约定）：

- sdk.run 的子程序**拿不到 `secrets`、`endpoint`、`programs` 映射和 `dataDir`**——物理上调不了 `sdk.agent`（无 endpoint 直接抛错）、摸不到业务安全桶、也不能再按名 `sdk.run` 别的程序（工具是叶子，组合编排只发生在包的胶水代码里），且无业务级持久状态落点（叶子无状态语义；子程序确需持久由流程程序把路径经 input 传入）。「工具不碰大模型、机械零 token、不嵌套组合」由此物理成立，不靠自觉；
- 工具需要的 token / 参数由**调用方显式传递**：包的胶水代码 `sdk.secret('jira_token')` 读出后放进 `sdk.run` 的 `config`——显式传递是刻意的：共享工具会被很多业务用，自动灌入全部 secrets 泄漏面就失控了，给什么由包作者决定；
- **依赖的两个层面**：代码级依赖（npm 包、多文件）工具自己解决——repo 内声明 package.json + lockfile，物化流程统一 `npm ci` 安装 + 初始化脚本构建产物（§9.2/§9.3），运行时 node 直接跑产物；平台资产级引用（按名字引用别的工具/skill）只有包能声明（§5.1 requires），工具不能。

**路径纪律（业务开发与维护者注意）**：跨资产引用**禁止相对路径**——资产物理上不在一起（各自 git 仓库、各自物化目录），跨资产一律按名字经平台解析（`sdk.run` / `sdk.agent`），平台解析返回绝对路径；资产**内部**的相对路径可以使用但**不得越出资产根**（清单校验机械强制，见 §5.1）；平台注入的路径参数（workspace 等）一律是绝对路径，业务代码拼接路径以它们为锚。

### 7.2 输出：stdout 一段 JSON（只认第一个合法结果）

```jsonc
{ "contract_version": "v1", "ok": true,  "output": "<业务产出，派生事件的 payload，出口投递的就是它>" }
{ "contract_version": "v1", "ok": false, "reason": "<失败原因>" }
```

写法（SDK）：`sdk.return(output)` / `sdk.fail(reason)`——写出结果并退出进程，二者只生效一次。不用 SDK 的语言：手写这段 JSON 到 stdout 然后退出。

### 7.3 失败与边界（机械、fail-closed、无需声明）

| 项 | 规则 |
|----|------|
| 失败判定 | exit code 非零 / 超时 / 无合法结果 / stdout 超限 → failed（程序内任一步失败 = 整体失败，**不重跑**） |
| 超时 | wall-clock 默认 60 分钟（业务可配），到点 SIGTERM → SIGKILL |
| 输出上限 | stdout 累计 1MB，超限即杀即判 |
| 环境变量 | **清空注入**（`env: {}`）——平台环境不泄漏；凭据只走 stdin 的 secrets |
| 工作目录 | cwd = run 工作区（`runs/{source}/{session_id}/{business_id}/{run_id}/`，run 结束按 TTL 清理） |
| 持久目录 | `dataDir`（`data/{source}/{session_id}/{business_id}/`，业务级持久，平台不做 TTL；同通道 run 串行 ⇒ 读写状态文件无需自锁） |
| 日志 | stderr（用 `sdk.log`，见 §7.4）；stdout 只承载结果 |

### 7.4 日志与审计

- `sdk.log(level, message, fields?)`：写 stderr 结构化行，平台采集进该 run 的业务日志（`logs/businesses/{三维键}/{run_id}.log`）；**这是平台管控通道**——统一格式、secrets 源头脱敏、将来注入 run 级关联字段都在这一处生效，业务不要绕过它直接写 stderr（写了也会被原样采集，但不受管控）；
- agent 调用的真实 LLM 请求体由平台侧落盘审计（`before_provider_request`），业务无需也无法干预。

### 7.5 平台提供什么（依赖清单）

| 提供物 | 形态 | 用途 |
|--------|------|------|
| 入口事件 | stdin `input`（信封：source/session_id/event_type/payload/…） | 触发与上下文 |
| 业务配置 / 安全变量 | stdin `config` / `secrets` | 业务参数与凭据（不碰环境变量） |
| 业务级持久目录 | stdin `dataDir`（`sdk.dataDir()`） | 跨 run 状态落点（如审查去重记录）；区别于 workspace（per-run 临时） |
| agent 调用 | `sdk.agent({skills, input, mode})`（模型凭据平台持有，不进业务进程；skills 可多个、可跨集合） | 大模型推理；`mode:'channel'` 多轮连续 / `'fresh'` 独立 |
| 会话操作 | `sdk.session.compact()/clear()` | 多轮业务的上下文压缩/清空 |
| 子程序组合 | `sdk.run(program, {input, config?, timeout_ms?})`——program 是**程序名**，SDK 从 stdin 注入的 `programs` 映射查绝对路径后 spawn（§6）；包内程序也可直接 import 进程内调用，包自由掌握 | 调用本包或绑定工具的程序（同一契约） |
| 业务日志 | `sdk.log` | 排查追踪 |
| 结果扇出与投递 | 平台负责：`sdk.return` 的 output 自动派生事件 → 下游业务 + 出口绑定（企微/邮件/webhook…） | 业务不写任何通知代码 |

### 7.6 为什么经 SDK 调大模型，而不是自己直连

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
| 换模型/换厂商/升级 agent 内核，每个业务都要改代码 | **切换在平台侧完成**，业务零改动（模型选择是业务资料，不是代码） |
| 直连完全绕过平台通道：配额、白名单、审计全部失效 | **守卫只能挂在平台通道上**：审计 extension（`-e` 注入）在 LLM 请求边界强制落盘，业务摘不掉 |
| 业务自己起 agent 进程，绕过平台并发闸门，机器被打爆 | pi 子进程百 MB 级，**业务闸门总量控制**（`task_concurrency`） |
| 日志/埋点与事件链断裂（无法按 event_id 回溯一次联动） | 关联键全链一致（event_id/correlation_id/channel_id），问题可回溯 |

一句话：直连不是"更自由"，是把平台已经做对的事（会话、凭据、配额、审计、埋点、注入）重新做一遍，还大概率做不对。

## 8. 包结构与工程模板

平台提供**模板包**（`templates/agent-package/`，拷贝即用），内置与平台一致的完整工具链，作者只写 `src/` 里的业务代码：

```
my-package/
├── agent-package.json      # 清单（§5.1）
├── agent.materialize.mjs   # 业务初始化脚本（必带，§9）：平台物化时执行，默认 esbuild 转译 src/ → dist/
├── package.json            # dependencies: @asterisk/agent-sdk（普通 npm 依赖）；
│                           # devDependencies 与脚本封装好：build(tsc) / test(jest+esbuild) /
│                           # lint(eslint) / format(prettier) / circular(dpdm)——与平台同构
├── tsconfig.json           # ESM NodeNext（相对导入带 .js 后缀）
├── eslint.config.js / .prettierrc
├── src/
│   └── programs/
│       └── main.ts         # 流程程序入口骨架
└── tests/                  # jest 单测（jest+esbuild 编译态，与平台同约定）
```

流程程序入口骨架（模板内置，直接在上面改）：

```ts
import { sdk } from "@asterisk/agent-sdk";

const { event, workspace } = sdk.input();          // 入口信封 + 工作区
sdk.log("info", "run started", { event_id: (event as any).event_id });

// 1. 检查：输入不合规 = 直接失败（不扇出、下游不触发）
// 2. 取数/脱敏：sdk.run('jira-fetch', { input: ..., config: { token: sdk.secret('jira_token') } })
//    —— 'jira-fetch' 来自业务绑定的工具资产（requires 声明、控制台配置期校验）
// 3. 大模型：const review = await sdk.agent({ skills: ['ticket-review'], input: masked });
//    —— 'ticket-review' 来自业务绑定的 skill 集合
// 4. 还原/门禁：不合格 → sdk.fail('门禁未通过')
// 5. 唯一出口：结果由平台扇出（下游关注 + 出口绑定投递）
sdk.return({ summary: "…" });
```

**规则**：模板的 lint/test/format/circular 配置与平台同构同版本——包在作者本地就能跑全检查，提交前即合格；**`@asterisk/agent-sdk` 是普通 npm 依赖**（从 npm registry 安装进包内 node_modules，开发与运行时用同一份代码；平台不做任何注入/bundle；未发布时的离线兜底是 `file:` 引用，见模板 README）。工具资产的结构与包完全相同（同一清单契约），只是消费路径只有 `sdk.run`。

## 9. 物化与业务初始化

**业务初始化**（创建/变更业务时执行）：物化该业务绑定的全部资产（包 + 工具 + skill 集合）到 `cache/assets/{asset_id}/`。初始化物化失败（拉取失败/清单校验不过/构建失败）→ **业务创建/变更失败**（fail-fast，控制台可见）。运行时兜底：执行前发现物化缓存缺失（被清理）→ 先补物化再执行；补拉失败 → 本次 run failed，不影响平台与其他业务。

### 9.1 两个脚本

- **平台物化脚本**：asset-registry 提供的独立可执行入口（编译产物 `dist/materialize-cli.js`），与 `AssetRegistry.materialize()` 内部走同一实现，**可脱离平台独立 CLI 执行**（`node packages/asset-registry/dist/materialize-cli.js --url <url> --commit <commit> [--subpath <p>] --target <dir>`；私有仓库凭据经环境变量 `AGENT_ASSET_CREDENTIAL`、npm registry 经 `AGENT_NPM_REGISTRY`）——绑定失败时管理员手动跑同一条命令即可复现完整输出，不用翻日志猜；
- **业务初始化脚本**：`agent.materialize.mjs`（资产根，subpath 之后）。**package/tool 资产必带**，缺失 = 物化失败（错误消息明确提示缺这个文件）；skill 资产（纯文档）不需要。为什么必带：仓库内容不限语言、初始化方式各不相同（转译、装环境、git 操作、调项目自己的脚本），平台不可能枚举；模板自带默认实现（esbuild 转译 `src/` → `dist/`，与模板 `npm run build` 同产物布局），新仓库拷贝模板即零负担。

### 9.2 物化固定流程

kind ∈ {package, tool}（skill 维持原流程不构建）：

```text
clone → validateAssetShape（清单形状校验，§5.1）
  → npm ci（§9.3，资产根含 package.json 时）
  → 执行业务初始化脚本 agent.materialize.mjs（§9.4）
  → 产物校验（清单 programs 每个路径必须真实存在，缺一即失败并列出缺失清单）
  → 去 .git → 写 .materialized-ok → 原子 rename
```

任何一步失败：清理临时目录、不落 marker、抛错（消息含阶段名与 stderr 尾部最后 30 行）。

### 9.3 npm ci

- 同步执行（绑定校验本就同步阻塞），cwd = 资产根（含 subpath），timeout 10 分钟；
- 资产根含 `package.json` 时必须同时含 `package-lock.json`，缺失 → 失败并明确提示「v1 只支持 npm + package-lock.json」；
- 构建子进程 env = `{ PATH, HOME, NPM_CONFIG_REGISTRY? }`（registry 地址来自平台配置 `AGENT_NPM_REGISTRY`，默认官方 registry），不继承平台进程其他环境变量；
- 平台不直接执行业务仓的 npm scripts（构建动作一律经 agent.materialize.mjs 表达）；依赖包自身的 postinstall 属固有代价。

### 9.4 业务初始化脚本契约（agent.materialize.mjs）

- 执行：`node agent.materialize.mjs`，cwd = 资产根，env 同 §9.3，timeout 10 分钟，exit≠0 = 物化失败（stderr 尾部透传）；
- 职责：完成本仓库的一切初始化——TS 转译、其他语言产物的构建/安装、codegen、资源下载、git 操作等。平台不传参、不理解过程，**只验收产物**：脚本跑完后清单 programs 声明的每个产物文件必须存在；
- **语言边界**：仓库内容不限语言，但**所有 program 入口必须是 node 可执行的 JS**（runner 与 sdk.run 均以 `node <program>` 拉起）。其他语言的接入方式 = 薄 JS wrapper + child_process 调用（wrapper 接信封、spawn 目标语言、回传结果），目标语言的产物/环境由初始化脚本准备；
- **环境边界**：平台宿主只保证 node 24 + npm + git + pi（自检）；python/rust/go 等其他语言环境平台不提供、不检查——谁用谁装，缺失会在 bind 期被初始化脚本明确暴露（如 `python3: command not found` 进绑定错误）。

### 9.5 缓存与治理

- 构建产物进缓存：产物目录与 node_modules 随资产缓存目录（`cache/assets/{asset_id}/`）同生共死，资产下架（`remove()`）连带清理；
- **缓存清理入口**：控制台设置页「清理资产缓存」按钮（admin；管理 API `POST /api/cache/clear`）清空 `cache/assets/`——登记行不动，清理后已创建业务下次 run 时触发重新物化 + 构建（懒重建，可能耗时分钟级）；
- 已知脆弱性：缓存清理后重建依赖 npm registry 状态（依赖 unpublish 则老版本重建失败）；缓解 = 锁文件钉死 + 保守清理；
- v1 不加并发锁：并发物化同一资产接受竞态（临时目录 + 原子 rename 兜底，最坏情况是重复构建）。

## 10. skill 在会话内的角色（注入机制与审计）

**注入机制（pi 实证）**：`sdk.agent({ skills: ['名', ...] })` 时，平台把每个 skill 名解析为物化后的资产内路径（§6 名解析，可多个、可跨集合），起 pi 子进程时一律带 `--no-skills`（关闭 cwd/用户目录的 skill 自动发现）+ 逐个 `--skill <路径>` 白名单注入（pi 的 `--skill` 可多次指定，路径各自独立）——与 extension 的 `-e` + `--no-extensions` 同一条纪律。`--no-skills` 不可省：pi 子进程 cwd 是 run 工作区，不关闭自动发现，业务往工作区丢 skill 目录即绕过白名单。skill 内容由 pi 自行渐进加载，**按需注入为默认**（不占满上下文窗口）。

业务侧**没有 `sdk.skill` 注册接口**：skill 是静态资产（登记在册、初始化物化、路径平台已知），按名引用即可；运行时动态注册 skill 会绕过校验与白名单，不支持。

- **skill 不可附带 pi extension**（业务侧无会话内代码）：脱敏/还原/门禁等守卫全部在会话外的流程程序内（`design/business-workflow.md` §5），执行顺序由业务代码显式控制——这比会话内 hook 更直观、可测、可调试；会话内只有平台注入的审计 extension（`-e` 白名单，业务不可摘除）。将来出现真实的会话内守卫需求再开放，装配清单多一类 `-e` 而已；
- 会话内注入物（本版仅平台审计 extension）遵守 hooks 三条纪律（fail-closed、判定自写结构化日志、`before_provider_request` 落盘审计）——唯一定义处：`design/business-workflow.md` §4；
- **工具调用预算**：按任务设置调用次数/费用上限，防模型死循环调工具。

## 11. MCP

**不支持，后续是否支持待定，不预留接口。** 理由：各家大模型对 MCP 的支持程度与配置方式差异明显，远没有 skill 规范统一、标准。
