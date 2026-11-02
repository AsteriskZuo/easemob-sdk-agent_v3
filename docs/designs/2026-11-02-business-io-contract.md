# 业务契约与三段式程序结构设计

日期：2026-11-02
状态：**已确认**（2026-11-02 晚两轮拷问 Q1–Q15 全部按推荐接受，结论索引见决策文档 D8）；实施按 §11 波次推进
关联：`docs/decisions/2026-11-02-webhook-ingress-decisions.md` 决策 D5 / D7 / D8（背景出处；本文自包含，执行不依赖阅读原文）

## 1. 背景与问题

平台数据流原则：**上游的输出 = 下游的输入**。对任一业务，上游可能是入口适配器或上游业务，下游可能是出口工具或下游业务。因此每个业务必须：① 有入口检查（输入不合规即 fail-fast）；② 有出口校验（产出不合规不扇出）；③ 入口/出口的数据格式对配置者与上下游可见。

此前的断点与教训：

- 平台两侧（适配器 `eventDoc`、出口工具 `resultDoc`）有自描述，**业务包这一环没有契约**——下游想看上游产出形状只能翻源码；
- 入口检查/出口校验曾是业务代码内的**约定**（写不写靠自觉），疏漏无法被发现；
- 包模板单程序、检查与主流程混在一个文件里，工程结构与"前置检查 / 主流程 / 后置校验"的心智模型不对应。

## 2. 设计总览

一句话：**契约成为包内的一个文件（`contract.json`），检查成为包内的两个程序（`check-input` / `check-output`），平台负责强制与编排，业务负责声明与实现。**

```
业务包
├── contract.json          # 契约：输入检查 + 输出校验（唯一事实源，机读）
├── apps/                  # 可执行程序（每个 = agent-package.json programs 一个条目）
│   ├── check-input/       #   前置检查（平台编排第一阶段）
│   ├── main/              #   主流程（取数/脱敏 → 大模型 → 组装产出）
│   ├── check-output/      #   后置校验（平台编排第三阶段）
│   └── <tool>/            #   包内工具（如 jira-fetch；main 可 import 或 sdk.run 调用）
└── packages/              # 库代码，不可直接执行（类型、helper；通用契约校验器由 SDK 提供，见 §4.4）
```

平台运行编排（一次 run 内三个阶段）：

```
check-input  →  main  →  check-output
  失败即终         成功才继续      失败 = run 失败，产出不扇出
```

## 3. 已确认决策（2026-11-02 讨论收敛，逐条是本设计的基线）

1. **机制**：独立 check 程序，平台三段编排（check-input → main → check-output）——平台定规则、统一调用，业务实现内容；
2. **纯校验纪律**：check 程序只判过/不过——无副作用、不取数、不过大模型、**不做数据转换**（转换与解析归 main，check 过了 main 仍从原始信封自己解析）；
3. **双闸强制**：物化时校验 `contract.json` 存在且形状合法 + `programs` 含两个保留程序名；控制台绑定业务时缺项即拒绝；
4. **失败分类结构化**：`RunOutcome` 增 `failed_at`（check-input / main / check-output），报错文字前缀不再承担分类职责（此前一天的"入口检查未通过："前缀约定退役）；
5. **显式空声明**：无输入约束 / 无产出 = contract.json 对应节显式 `null`，不允许缺失（缺失分不清"忘了"和"没有"）；
6. **出口呈现原则**：业务产出 = 语义形状，面向所有消费者；呈现格式归出口侧（详见 §8）；
7. **结构即文件夹**：模板按 apps/packages 布局落地三大块（回应"工程化太复杂"的复盘——共享机制保留但不进默认路径）。

另确认一处取舍：**取消 check 程序的 usage 方法**——"平台拿到说明才能调用"的需求由"平台物化时直接读 contract.json 文件"覆盖：不执行程序就能拿到契约，零运行成本，也无"程序说的与做的版本漂移"。文件即说明。

2026-11-02 晚两轮拷问（Q1–Q15，全部按推荐接受）进一步收敛：schema 表达力冻结与版本号、null 非对称语义、通用校验器归属 SDK、逃生门同约束、workspace 只读约定、控制台只读范围与抽屉交互、run 详情最小呈现、软迁移口径、波次计划——结论索引见决策文档 D8，本文对应章节已按终稿写就。

## 4. 包结构与平台契约

### 4.1 目录布局

见 §2 总览。两条组织纪律：

- **apps/ 里的程序保持薄壳**：入口文件只做"读输入 → 调 packages/ 里的实现 → 汇报结果"；哪一块长大了，实现代码进 `packages/`，程序壳不变——平台契约（程序名集合）永远稳定，内部结构自由生长；
- **check 程序天然很短**（纯校验纪律保证），一个文件就够，不需要文件夹内的再拆分。

### 4.2 agent-package.json：保留程序名

```json
{
  "name": "my-package",
  "version": "0.1.0",
  "programs": {
    "main": "dist/apps/main/index.js",
    "check-input": "dist/apps/check-input/index.js",
    "check-output": "dist/apps/check-output/index.js"
  },
  "requires": { "tools": [], "skills": [] }
}
```

- `check-input` / `check-output` 是**平台编排的保留程序名**（runner 按名查找，见 §5）；
- 主流程入口仍可配（控制台 entry_program 从 programs 键里选，现状不变）；包内工具程序（如 `jira-fetch`）同表登记，名字自取；
- `requires` 的跨仓共享（工具/skill 资产绑定）保留为**进阶路径**，模板默认全空、不演示——第一版默认形态 = 单包自给自足。

### 4.3 contract.json（唯一事实源）

```json
{
  "version": 1,
  "input": {
    "fields": [
      { "path": "payload.issue_key", "type": "string", "required": true, "desc": "工单 key，会话标识与取数锚点" },
      { "path": "payload.event_type", "type": "string", "required": false, "desc": "jira:issue_created/updated 区分（延迟合并用）" }
    ]
  },
  "output": {
    "fields": [
      { "path": "content", "type": "string", "required": true, "desc": "消息正文" },
      { "path": "mentions", "type": "string[]", "required": false, "desc": "@ 的 userid 列表" }
    ]
  }
}
```

规则：

- **版本**：顶层必含 `"version": 1`；物化闸拒绝未知 version——这是 schema 自身演进的唯一通道（将来扩展词表/语义时升 version，平台按 version 分发解释）；
- **字段**：`path`（点分路径）、`type`（词表：`string` / `number` / `boolean` / `object` / `array` / `T[]`）、`required`（缺省 false）、`desc`（展示用说明）；
- **校验语义（刻意最小，v1 冻结）**：只检查 `required: true` 项的**存在 + 类型**；`T[]` 递归校验每个元素，`object` / `array` 不深入内部形状；可选项不检查（声明仅供展示与理解）。**v1 明确不支持**：枚举取值、数值范围、正则格式、嵌套字段深入、条件必填（如 create/update 事件不同必填集）——需要者走逃生门（§4.4）或在 main 自判；
- **路径基准**：`input` 的 path 从**事件信封根**解析——允许声明信封顶层字段（`type` / `id` / `timestamp` 等）与 `payload.*`；`output` 的 path 从 `sdk.return` 的产出根解析；
- **显式空（非对称语义）**：`"input": null` = 无入口约束 → runner **跳过** check-input 阶段（记 skip 日志）；`"output": null` = 声明无产出 → check-output 阶段**仍执行**，判定标准 = stdout 结果行的 `output` 键缺失或值为 null 即视为空产出（SDK 无参 return 时 JSON.stringify 丢弃 undefined 键），产出非空则出口校验失败——不许契约撒谎；
- **演进**：同一 version 内只加字段/加可选声明；改类型、删字段、改语义 = 破坏性变更，升包 `version`。

**三个消费者**（一个文件喂三方，契约不会与实现漂移的根本保证）：

1. **物化校验**：平台读文件验存在 + 形状（§6）；
2. **控制台展示**：字段表渲染给配置者（§7）；
3. **check 程序执行**：通用校验器在运行时解释它（§4.4）。

### 4.4 通用校验器与逃生门

**通用校验器由 SDK 提供**（`@asteriskzuo/agent-sdk` ≥0.3.0 导出，见 §11 波次 1），不在模板里逐包复制——校验器修 bug / 升级 = 业务升级依赖即得，无需所有包重新物化。check 程序**不需要业务写校验代码**，两个 check 程序是调 SDK 的薄壳：

```ts
// apps/check-input/index.ts（模板自带，业务零修改）
import { sdk, loadContract, checkFields } from "@asteriskzuo/agent-sdk";

const { event } = sdk.input();
const contract = loadContract(new URL("../../../contract.json", import.meta.url));
if (contract.input !== null) {
  const problems = checkFields(contract.input.fields, event);
  if (problems.length > 0) sdk.fail(problems.join("；"));
}
sdk.return({});
```

```ts
// apps/check-output/index.ts（模板自带，业务零修改）
import { sdk, loadContract, checkFields } from "@asteriskzuo/agent-sdk";

const { output } = sdk.input(); // RunInput.output = 主程序产出（SDK ≥0.3.0）
const contract = loadContract(new URL("../../../contract.json", import.meta.url));
if (contract.output !== null) {
  const problems = checkFields(contract.output.fields, output);
  if (problems.length > 0) sdk.fail(problems.join("；"));
} else if (output !== null && output !== undefined) {
  sdk.fail("契约声明无产出（output: null），实际产出了非空值");
}
sdk.return({});
```

校验器 API（SDK 导出）：

```ts
export interface ContractField { path: string; type: string; required?: boolean; desc?: string }
export interface ContractDoc {
  version: 1;
  input: { fields: ContractField[] } | null;
  output: { fields: ContractField[] } | null;
}
export function loadContract(fileUrl: URL): ContractDoc;           // 读文件 + 形状校验（坏契约 = 抛错，run 失败）
export function checkFields(fields: ContractField[], data: unknown): string[]; // 问题列表；空 = 通过
```

**逃生门**：需要超出"存在 + 类型"的校验（跨字段一致性、值域、条件必填等）时，业务自己写 check 程序替换薄壳——平台契约（程序存在、过/不过语义）不变，平台无感知。**逃生门同约束**：自写 check 程序与通用校验器受同样约束——最小注入（无 secrets / endpoint / programs / dataDir）、仅 node 运行时、60s 固定超时、纯本地判定；需要联网 / 查库 / 调上游的检查不属于 check 阶段，归 main。

## 5. 平台运行编排（runner 三段式）

一次 run = 三个阶段，共用同一 run_id / 工作区 / 业务日志文件 / 并发槽：

| 阶段 | 程序 | stdin 注入 | 超时 | 失败语义 |
|------|------|-----------|------|----------|
| 1 | `check-input` | **最小注入**：`contract_version` / `input`（事件信封）/ `workspace` / `config` | 60s（平台常量，v1 不开放配置） | run 失败，`failed_at="check-input"`，不进阶段 2 |
| 2 | entry_program（如 `main`） | 现状全量注入（+ `secrets` / `endpoint` / `programs` / `dataDir`） | run 超时（`quota.timeout_minutes`，现状不变） | 现状语义不变，`failed_at="main"` |
| 3 | `check-output` | 最小注入 + **`output`**（= 阶段 2 的产出） | 60s | run 失败，`failed_at="check-output"`，**产出不扇出**（下游与出口都收不到） |

要点：

- **最小注入是"纯校验纪律"的结构落实**：check 程序拿不到 secrets（不能取数）、endpoint（不能调大模型）、dataDir（不能写状态）、programs（不能 sdk.run）——想不纯也没有工具；
- **运行期跳过判定**：runner 在 run 开始时读工作区 `contract.json`——文件缺失或解析失败 = 旧 pin 资产路径，跳过两个 check 阶段（记 warn 日志）；`input === null` → 跳过阶段 1（记 skip 日志）；`output === null` → 阶段 3 仍执行（校验产出为 null）。程序名缺失（`programs` 无 check-input / check-output）同样跳过对应阶段；
- `StdinEnvelope` 增可选字段 `output`（仅阶段 3 注入）；SDK 侧 `RunInput` 增 `output?: unknown`（仅后置校验程序能读到）——均为向后兼容的增量（SDK 0.3.0）；
- `RunOutcome` 增 `failed_at?: "check-input" | "main" | "check-output"`；装配根映射进 run 记录与日志（结构化分类由此而来，控制台最小呈现见 §7）；
- 阶段 1/3 的 stdout 结果只取过/不过，其 `output` 内容平台忽略；
- 任一 check 阶段 spawn 失败/超时/结果缺失 = 该阶段失败（与 main 的 fail-closed 判定优先级一致）；
- **workspace 只读约定**：check 程序对工作区只读（文档约定，平台不强制隔离），写临时文件归 main。

**迁移兼容**：runner 找不到 check 程序或 contract.json 时**跳过对应阶段**（旧 pin 资产继续可跑）；强制只发生在"新登记/更新资产"的闸口（§6）。平台只有一个真实业务，迁移窗口很短。

## 6. 强制闸口（配置期拦截，运行期零兜底）

1. **物化闸**（`asset-registry` 清单校验扩展）：package 类资产必须满足——`contract.json` 存在于资产根且形状合法（含 **`version === 1`**，未知版本拒绝；其余按 §4.3 schema 机械校验）；`programs` 含 `check-input` / `check-output` 两个保留名（路径存在性沿用既有校验）。缺一 = 物化失败，错误消息列出缺项；
2. **绑定闸**（控制台业务保存）：绑定的包清单缺保留程序名或契约 → 拒绝保存并逐条列出。

## 7. 控制台联动

交互模型（已确认）：**选择事件的来源——入口适配器（匹配行 source 命中）或上游业务（internal 引导选中）——选择之后即可查看该来源的输出数据格式**，下游业务据此契约编写。

v1 范围纪律（D8）：控制台对契约**只读**——契约的编辑修改永远走业务仓 git 流程；不做在线编辑契约、不做模拟输入试跑；绑定界面**只展示不校验**上下游契约匹配（类型/字段对不上不拦截，靠人对照判断）。

- **契约展示 = 右侧抽屉**：复用 pi 配置的 `PiProviderHelpDrawer` 同款模式（antd Drawer），实现为 `ContractDrawer` 组件两处复用——
  - **资产详情**：放「查看契约」入口，抽屉内分「入口契约 / 出口契约」两节，各节先字段表（路径 / 类型 / 必填 / 说明）后原始 contract.json（带复制按钮）；页面主体不内联契约内容；
  - **业务编辑页（绑定界面）**：选定上游后放「查看上下游契约」入口，抽屉内上下两节并排展示「上游 output 字段表 vs 本业务 input 字段表」；
- 匹配行卡：`source=internal` 选中上游业务时可查看其 output 契约（抽屉）；任意 source 可查看本业务自己的 input 契约（自我声明核对）；
- 出口卡：勾选出口工具展示其 `resultDoc`（现状保留），可对照本业务 output 契约（抽屉）；
- **run 详情最小呈现**：run 失败时显示 `failed_at` 阶段徽标（入口检查 / 主程序 / 出口校验）+ reason 文本（校验错误列表 join，超长截断）；成功的 run 不显示阶段信息（与现状一致）；v1 不做三段时间线视图、不展示各阶段耗时；
- API：资产详情（`GET /api/assets/:id`）附带解析后的 contract JSON（无文件 = null）；
- 渲染：字段表用 antd Table/描述列表直出（contract.json 是结构化数据，不再需要 markdown 原文块——这是 contract.json 相对 CONTRACT.md 方案的关键优势）。

## 8. 出口呈现原则

- **原则（现在定）**：业务输出契约 = **语义形状**，面向所有消费者（下游业务、出口工具、日志）；呈现格式（markdown 排版、@ 列表）是出口侧关切，不进业务产出；
- **现状过渡**：jira-ticket-review 当前唯一消费方是企微出口，产出继续用 `{ content, mentions }` 形状，但在其 contract.json 的 `desc` 注明"面向企微呈现的过渡态"；
- **重启条件**（出现其一即立项做呈现下沉）：结构化下游首次启用（internal 链真实消费）、或第二个异格式出口出现。**首选方案 = 格式化业务**（纯组合、零新机制）：业务 A 产出语义 JSON → 格式化业务 B（纯程序，可不过大模型）订阅 `A.completed`，渲染成 `{ content, mentions }` 后 return，企微出口绑在 B 上。B 的入口检查校验的就是 A 的输出契约，出口校验校验的就是企微 resultDoc 形状——契约机制在此闭环；
- **v1 不实现格式化业务示例代码**（D8-Q14）：触发条件出现前只做文档约定，不提前写无用户代码；
- **纪律（现在生效）**：mention 名单的 userid 映射（人 → 企微 userid）是运营数据，不进业务包代码，走绑定配置或业务环境变量。

## 9. 与 D5"机验后置"的关系（修订说明）

D5 原定"文档先行、机器校验（JSON Schema 级）后置"。本设计把其中**最小声明式校验**（存在 + 类型）提前——因为它由业务声明驱动、平台依然不理解业务语义，且 contract.json 同时解决了展示问题；**完整内容级机验**（枚举、嵌套、跨字段、JSON Schema）**继续后置**，重启条件不变（出现第二个消费方再评估；届时经 contract.json 顶层 version 升 schema，见 §4.3）。

## 10. 兼容性与迁移

- 信封契约：不动（`contract_version` 恒 v1，无字段增删）；`StdinEnvelope` 增可选 `output` 属向后兼容；
- 旧包（无 contract.json / 无 check 程序的已 pin 资产）：runner 跳过校验阶段，行为与现状完全一致；
- 新登记/更新资产：双闸强制（§6）；
- **旧资产软迁移（D8-Q12 口径）**：不设硬迁移截止；控制台对旧结构资产显示「待迁移」标记；资产一旦重钉 commit 触发重新物化即过物化闸（须已是新结构）。平台现存唯一业务在波次 2 即迁移，软标记防的是未来新资产走旧路；
- **迁移窗口（D8）**：波次 2 重钉资产选低峰操作；接受 in-flight run 的小概率失败（失败后重新触发即可——工单审查业务天然幂等可重入，延迟合并队列本身有重试语义）；
- jira-ticket-review 迁移（T5d）：拆 apps/ 布局、补 contract.json、inline 检查逻辑迁入 check 程序（延迟合并等主流程逻辑留在 main 不动）。

## 11. 落地步骤与波次计划

| # | 内容 | 范围 | 波次 |
|---|------|------|------|
| T3 | **入口开关互斥兜底**（D2：双 true → webhook 优先 + error 日志 + 继续运行） | 平台 bootstrap | 1 |
| T5a | **模板重构**：apps/packages 布局 + contract.json + 三程序薄壳 + 测试/README；**SDK 0.3.0 additive 发版**（`RunInput.output` + `loadContract` / `checkFields` / 类型导出） | `templates/agent-package/` + `packages/sdk/` | 1 |
| T5b | **平台编排与闸口**：runner 三段式 + `failed_at` + 最小注入 + `output` 注入 + null 跳过；asset-registry 物化闸（含 version 校验） | workflow-runner / asset-registry / 装配根 | 2 |
| T5d | **业务迁移**：jira-ticket-review 拆结构 + 补 contract.json + 资产重钉 | 业务仓 | 2（与 T5b 同波次，否则闸口拦既有业务） |
| T5c | **控制台联动**：资产详情 API 带 contract；ContractDrawer 抽屉展示；绑定闸；run 详情 `failed_at` 徽标 | console-api / console | 3 |
| T6 | **文档收尾**：business-workflow.md / asset-model.md 等基础设计文档对齐新架构；docs/README.md 目录名与实际目录修正 | docs/ | 4 |

波次外的验证任务：**T4（webhook 真实接入验证）完整验证放在波次 2 之后**——验证对象是新结构业务包，避免验证两遍；波次 1 完成后可随时先冒烟（依赖 T2 push + 资产重钉 + D6 手工项）。

## 附录 A：jira-ticket-review 的 contract.json（迁移示例）

```json
{
  "version": 1,
  "input": {
    "fields": [
      { "path": "payload.issue_key", "type": "string", "required": true, "desc": "工单 key" },
      { "path": "payload.event_type", "type": "string", "required": false, "desc": "webhook 来源有（jira:issue_created/updated）；polling 来源无" },
      { "path": "payload.time", "type": "string", "required": false, "desc": "webhook 事件时间（RFC3339）" },
      { "path": "payload.updated", "type": "string", "required": false, "desc": "polling 来源的工单更新时间" }
    ]
  },
  "output": {
    "fields": [
      { "path": "content", "type": "string", "required": true, "desc": "企微 markdown 正文（过渡态：面向企微呈现，见 §8）" },
      { "path": "mentions", "type": "string[]", "required": false, "desc": "@ 的 userid（映射走环境变量，不进代码）" }
    ]
  }
}
```

说明：`input` 只把 `issue_key` 标 required——polling 与 webhook 两来源都必有；`event_type`/`time`/`updated` 各来源有无不一，声明为可选（展示用），校验器不查。这正体现了"required 才校验、可选仅声明"的最小语义。
