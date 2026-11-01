# 业务多模型选择与枚举 spec（2026-11-01）

> 本 spec 自包含：执行所需的契约、字段语义、错误码、迁移要求全部内联。
> 背景出处（非必读）：`docs/specs/2026-10-26-business-pi-configuration-spec.md`（业务自定义 Pi 配置初版）。
> 本文已经过两轮设计拷问（grilling）收敛，全部决策见 §4。

## 1. 背景

当前一个 run 内所有 `sdk.agent()` 调用被钉死在同一个模型上（`profile.model`），socket 协议没有模型字段。业务包希望用程序实现**链式兜底**（如：云端模型失败 → 换本地模型再试），需要平台提供两个能力：

1. 按次指定本次 agent 调用使用哪个模型；
2. 枚举本业务当前生效配置里有哪些 provider / 模型可用。

同时确认两个方向性变化：

- **业务大模型配置成为模型的唯一来源，全局大模型配置（AGENT_PI_MODELS / AGENT_PI_AGENT_DIR）即日起退出**——平台未上线过任何版本，无兼容负担。没配置大模型的业务在控制台创建/保存时给出警告，运行期 agent 调用失败。
- **HTTP 超时收紧**：平台 HTTP 服务（console-api server）此前未设置任何超时（裸 `createServer`，依赖 Node 默认），console 的 `apiFetch` 也不支持超时。引入全局可选配置项 `AGENT_HTTP_TIMEOUT_MS`（默认 30 秒），server 与 client 双侧收紧。该约束决定了在线验证必须改为异步轮询（§10）。

重试策略、尝试次数、采纳逻辑全部归业务包代码，平台零参与。

## 2. 目标 / 非目标

### 2.1 目标

- `sdk.agent()` 支持可选 `model` 参数（provider/id），缺省用业务默认模型。
- 新增 `sdk.models()`：返回本 run 生效配置中的 provider/模型枚举（绝不含敏感字段）。
- agent-service 对显式 `model` 做白名单校验（fail-fast），并支持 `models` op。
- 业务大模型配置 = 唯一模型来源；全局 `AGENT_PI_MODELS` / `AGENT_PI_AGENT_DIR` 启动配置及其派生 models.json、自检、设置页展示全部移除。
- 控制台大模型配置区重做并提升布局权重：只有一个 models.json 编辑器，置于编辑表单顶部；在线验证 = 异步提交 + 轮询进度，遍历全部 provider/model 逐个真实探针，全过才允许保存；默认模型 = 第一个 provider 的第一个模型（派生，无独立输入项）。
- HTTP 超时硬化：新增可选配置 `AGENT_HTTP_TIMEOUT_MS`（默认 30000），console-api server 与 webhook server 应用；console `apiFetch` 支持超时（默认 30s）。
- socket 契约升级 v2，升级内容在代码注释与本 spec §5 写清。

### 2.2 非目标

- 平台不做自动重试、不做输出采纳策略（归业务包代码）。
- 不做配置热生效（仍走更新队列闲时生效，语义不变）。
- 不做探针并发（串行）、不做探针超时配置项（内部常量 30s，待真实数据校准；per-model 差异化超时为已知后续优化点）。
- 业务包（jira-ticket-review）的链式兜底实现不在本 spec 范围（业务仓独立演进）。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| provider/id | 模型寻址形式：`provider名/模型id`，如 `qwen/qwen3-max`、`ollama/qwen3:8b` |
| 生效配置 | 本 run 实际使用的 models.json：业务自定义配置经派生生成（`businesses/{bid}/cache/pi/agent/models.json`）；无其他来源 |
| 默认模型 | 业务资料 `model` 字段，保存自定义配置时由服务端从配置派生：JSON 中第一个 provider 的第一个 model id |
| 白名单 | agent-service 从生效配置枚举出的 `provider/id` 全集，显式 `model` 参数必须命中 |

## 4. 已确认决策（与用户对齐记录，含 grilling 两轮结论）

1. per-call model 覆盖 + `sdk.models()` 枚举；重试逻辑永远在业务包，平台不提供内部重试。
2. 默认模型不加独立输入项，**就是第一个 provider 的第一个 model**；保存时由服务端派生写入业务资料 `model` 字段（配置与 model 仍是同一次不可拆分写操作）。provider 名**禁止纯整数形态**（JS 对象整数键会被重排到最前，破坏"第一个"语义；结构校验拒绝 `^\d+$`）。
3. **全局大模型配置即日起退出**：业务必须使用自己的配置；无配置业务在控制台创建/保存时给警告（不阻断保存），运行期 agent 调用失败 `model_not_configured`。无配置是合法中间态（纯程序业务不调 agent，run 正常），平台不加入口侧跳过/自动停用等策略。
4. socket 契约升 **恒定 v2**（SDK 所有请求发 v2；服务端同时收 v1/v2；v1 请求携带 model 字段 → 拒绝），无兼容性负担；升级内容必须写进代码注释与 spec（§5）。
5. 遍历验证**串行**执行（不并发，避免触发 provider 限流）；**任一失败不中断**，全部验完返回完整清单；全部通过才允许保存。
6. 探针超时 = **内部常量 30s**（本地模型冷启动友好；非配置项，待真实数据校准；代码注释注明）。
7. **HTTP 超时硬化**：新增可选配置 `AGENT_HTTP_TIMEOUT_MS`（默认 30000，范围 1000–300000），console-api server 与 entry webhook server 应用；console `apiFetch` 支持超时（默认 30s）。
8. 在线验证因第 5+6+7 条约束改为**异步提交 + 轮询**（§10）；验证结果逐条实时渲染（替代静态预估文案）。
9. `sdk.models()` 对无配置业务返回**空枚举**（`{ default: "", providers: [] }`），不抛错——枚举是纯查询；运行期 agent 调用仍会被 `model_not_configured` 拦截，错误暴露时点不变。业务包由用户实现、平台只能模板引导：模板 README 的链式兜底示例必须示范完整的异常处理与日志写法。
10. 控制台大模型配置区**提升布局权重**：移到编辑表单顶部（业务名/agent 之后、总纲之前）；列表页"模型"列对未配置业务显示警告标签；不做独立页签。
11. 控制台删除"模型（provider/id）"独立输入项，只留 models.json 编辑器；保留"厂商配置帮助"右侧抽屉。
12. 控制台帮助两级原则固化到 `console-design.md`：简单说明用行内问号 Tooltip；复杂内容（模板/多步骤/厂商差异）用右侧 Drawer。

## 5. socket 契约 v2（升级说明）

业务进程 ↔ agent-service 的 unix socket 协议从 v1 升级为**恒定 v2**。**升级内容清单**（同样的文字进入 `packages/sdk/src/sdk.ts`、`packages/sdk/src/socket.ts` 与 `packages/agent-service/src/index.ts` 的协议注释）：

| 变更 | v1 | v2 |
| --- | --- | --- |
| `agent` 请求字段 | `contract_version, token, op, skills, input, mode` | 新增可选 `model: string`（provider/id） |
| 新 op | 无 | `"models"`：查询生效配置的 provider/模型枚举 |
| 错误码 | `invalid_request, quota_exceeded, service_closed, input_too_large, skill_not_allowed, skill_missing, agent_failed, agent_empty_output` | 新增 `model_not_allowed: <model>`、`model_not_configured` |

版本协商规则（恒定 v2）：

- **SDK 所有请求一律发 `contract_version: "v2"`**（含无 model 的 agent、compact、clear、models）。
- 服务端同时接受 `"v1"` 与 `"v2"`；其他值 → `invalid_request`。
- **v1 请求携带 `model` 字段 → `invalid_request`**（防御规则：防手工构造的客户端误以为静默生效）。
- 兼容性结论：老业务包（老 SDK，发 v1）对新平台照常工作；新 SDK 对老平台被清晰拒绝（`invalid_request`，fail-fast 不静默）。
- 响应 envelope 形状不变：`{ contract_version: "v1", ok, output? | error? }`（响应的 contract_version 恒为 `"v1"`，仅作 envelope 版本标识——与现状一致，不改）。

`models` op 请求/响应：

```jsonc
// 请求
{ "contract_version": "v2", "token": "...", "op": "models" }
// 响应（已配置）
{ "contract_version": "v1", "ok": true, "output": {
    "default": "qwen/qwen3-max",
    "providers": [
      { "name": "qwen",   "models": ["qwen3-max", "qwen-plus"] },
      { "name": "ollama", "models": ["qwen3:8b"] }
    ] } }
// 响应（业务未配置大模型）
{ "contract_version": "v1", "ok": true, "output": { "default": "", "providers": [] } }
```

- 响应只含 provider 名与模型 id（按配置声明顺序），**绝不含 apiKey/baseUrl** 等任何其他配置字段。
- `models` op 是元数据查询，**不计 agent 配额**。

## 6. SDK 变更（`@asteriskzuo/agent-sdk`，发布时升 0.3.0）

```ts
/** agent() 的调用参数 */
export interface AgentCall {
  skills: string[];   // 不变
  input: unknown;     // 不变
  mode?: "channel" | "fresh"; // 不变
  /** 本次调用使用的模型（provider/id）。缺省 = 业务默认模型（生效配置第一个 provider 的第一个模型）。
   *  必须在本业务生效配置的枚举集合内，否则服务端回 model_not_allowed。
   *  链式重试建议配 mode: "fresh"（每次独立会话，互不串味）。 */
  model?: string;
}

/** sdk.models() 返回的生效配置枚举（只读视图；绝不包含 apiKey/baseUrl） */
export interface ModelsInfo {
  /** 业务默认模型（provider/id）；未配置大模型 = "" */
  default: string;
  /** 按配置声明顺序排列；未配置大模型 = 空数组 */
  providers: Array<{
    name: string;       // provider 名
    models: string[];   // 该 provider 的模型 id 列表（按声明顺序）
  }>;
}

// sdk.models(): Promise<ModelsInfo>
// - socket op "models"（contract v2）；服务端失败（service_closed 等）抛错，与 sdk.agent 同风格。
// - 与 sdk.agent 一样仅流程主程序可调（子程序无 endpoint 注入 → 抛错）。
```

- `sdk.agent(call)`：`call.model` 非 `undefined` 时必须是非空字符串（客户端先校验，空串直接抛错不发请求）。
- SDK 全部请求恒定 `contract_version: "v2"`（§5）。
- `sdk.models()` 是 SDK 新能力的主入口，业务据此自行组织链式兜底（尝试几轮、什么顺序、失败换谁，平台全部不管）。

## 7. agent-service 变更

### 7.1 生效配置解析（新模块 `models-json.ts`）

- `serve()` 时若 `ctx.pi_agent_dir` 存在，**立即解析**其下 `models.json`，产出：
  - `providers: [{ name, models: string[] }]`（保持声明顺序，供 `models` op 原样返回）；
  - `allowed: Set<string>`（全部 `provider/id`，供白名单校验）。
- 结构要求（运行时宽松版，只保证可枚举）：`providers` 为非空 object；每个 provider 的 `models` 为非空数组，每项为含非空字符串 `id` 的对象。**解析失败 → serve 抛错、run 失败**（fail-fast；保存期已严格校验，运行期失败 = 文件被篡改或手写）。解析错误文本不得携带文件内容（含敏感字段）。
- `ctx.pi_agent_dir === undefined`（业务未配置）：不解析；`agent`/`compact` op 回 `model_not_configured`；`models` op 回空枚举；`clear` op 不需要 pi，放行。

### 7.2 agent op

- 请求带 `model`：必须命中白名单，否则 `model_not_allowed: <model>`（fail-fast，不 spawn pi）。
- 实际使用模型 = `req.model ?? ctx.model`；`ctx.model === ""`（未配置）时 agent op 必已在 §7.1 拦截，不会走到这里。
- `--model <实际模型>` 传给 pi；其余命令行形态不变（含 `--append-system-prompt` skill 注入、审计 extension）。
- 调用日志（`agent 服务调用` / `agent 服务调用失败`）新增 `model` 字段（实际使用值），便于事后看清哪次尝试被采纳。
- 配额语义不变：每次 `agent` 请求计 1（不论成败）；`models` op 不计。

### 7.3 依赖瘦身

- `AgentServiceDeps` 删除 `pi_agent_dir` 字段（全局目录概念消失）；`buildPiEnv` 的 `PI_CODING_AGENT_DIR` 只取 `ctx.pi_agent_dir`。
- `AgentServeContext.pi_agent_dir` 注释更新：业务自定义配置的派生目录，是模型的唯一来源；`undefined` = 业务未配置大模型。
- `AgentServeContext.model` 注释更新：`""` = 未配置（此时 agent/compact 被拒绝）。

### 7.4 会话与 model 的关系（仅文档提示，不做强制）

`channel` 模式换模型续会话：pi 每次调用都带 `--model`，技术上可行但上下文历史是上一个模型产出的，语义混杂，文档建议链式重试一律 `mode: "fresh"`。

## 8. 平台变更（app/server）

| 现状 | 改为 |
| --- | --- |
| `config.ts`：`AGENT_PI_MODELS`（必填 object）、`AGENT_PI_AGENT_DIR`（全局 models.json 目录） | **两个配置项删除**；`Config.pi_models`/`pi_agent_dir` 字段删除。config.json 解析对未知键宽松，存量文件残留旧键不报错，但文档与模板标注已移除 |
| `config.ts`：无 HTTP 超时配置 | **新增可选 `AGENT_HTTP_TIMEOUT_MS`**（默认 30000；合法范围 1000–300000，越界启动报错 fail-fast） |
| `bootstrap.ts`：`preparePiModels`（生成全局 models.json）、`loadModelList`、`globalModels` | 全部删除；不再生成全局派生目录 |
| `self-check.ts` 检查④（pi_agent_dir 与 models.json 可用） | 删除；保留 ③（`pi_cli_path` 可执行） |
| `models.ts`：`validatePiModelsConfig`/`preparePiModels`/`loadModelList`（全局专用） | 删除；`prepareBusinessPiModels` 保留 |
| agent-service 装配：`deps.pi_agent_dir = config.pi_agent_dir` | 删除该传参 |
| console-api server：裸 `createServer`（无超时） | 应用 `AGENT_HTTP_TIMEOUT_MS`：`requestTimeout` 与 socket `timeout` 设为该值，`headersTimeout` 取其一半（满足 Node headersTimeout < requestTimeout 约束） |
| entry webhook server：裸 `createServer` | 应用同一 `AGENT_HTTP_TIMEOUT_MS`（快路径，无冲突；平台 HTTP 服务统一策略） |
| `/api/config`：`models` 字段（全局可选模型列表） | 删除（`agents` 等其他字段保留） |
| `pi-config-service` deps `globalModels`；`remove()` 要求回退全局模型 | 删除该 deps；`remove` 语义见 §9.4 |

console `apiFetch`（`app/console/src/api/client.ts`）：新增超时能力——默认 `AbortSignal.timeout(30000)`，支持按调用覆盖；超时抛出友好错误（"请求超时，请检查服务可达性"类文案），不再无声挂死。

## 9. 业务大模型配置语义变更

### 9.1 唯一来源与默认模型派生

- 业务自定义配置是模型的**唯一来源**；无配置 = 无模型。
- 默认模型派生规则：**配置 JSON 中第一个 provider 键的第一个 models 数组元素 id**（JS `JSON.parse` 保持字符串键插入序；纯整数形态键会破坏该顺序，故 §9.2 拒绝）。
- 派生时机：`validate` 提交时派生并写入验证记录；`confirm` 时随配置经 `pi.set` 更新命令同一写操作落库（`registry.setPiModels(config, model)` 签名不变）。运行时 `context-loader` 不变（仍读 `profile.model`）。
- 用户调整 JSON 顺序后重新验证保存 → 派生默认模型随更新队列生效。

### 9.2 结构校验收紧（`validateBusinessPiModels`）

在原规则上收紧为：

1. 顶层非数组 object；`providers` 为非空 object；provider 名非空、配置为 object。
2. **provider 名不得为纯整数形态**（`^\d+$` 拒绝；保护"第一个 provider"派生语义）。
3. `baseUrl`/`api`/`apiKey` 如出现必须为字符串。
4. **`models` 必须出现**、为非空数组；每项为 object 且含非空 `id`；同 provider 内 id 不重复。（变化点：不再允许省略 `models` 的简写形态。）
5. 未知顶层/provider/model 字段全部保留（不重建、不深合并、不自动修正）。
6. 不再校验单个 model 归属（归属概念被"全量枚举+逐个验证"取代，见 §10）。

### 9.3 无配置业务的行为

- **控制台**：创建页与编辑页在大模型配置区显示警告（不阻断保存）："未配置大模型：该业务无法使用大模型推理（`sdk.agent` 调用将失败）。请在编辑页完成配置并在线验证。"配置区位于编辑表单顶部（§11）。
- **运行期**：`agent`/`compact` op → `model_not_configured`；`sdk.models()` → `{ default: "", providers: [] }`；不调 agent 的业务（纯程序流程）不受影响，run 正常。平台不为此加入口侧跳过/自动停用等策略（失败在 run 日志与监控可见，轮询类业务有 `on_failure` 策略兜底）。
- **存量业务**（有 `model` 值但无 `pi_models`）：升级后即落入本条款；`model` 存量值不再有任何作用，无需清洗（重新保存配置时自然覆盖）。

### 9.4 删除自定义配置（pi.remove）

- 不再需要提供替代模型：payload 变为 `{ business_id }`（仍经更新队列、单业务屏障）。
- 生效后 `pi_models = NULL`、`model = ''`，业务回到"未配置"状态（§9.3）。
- HTTP `DELETE /api/businesses/:id/pi-config`：不再需要请求体。

### 9.5 model 字段只读化

- 业务创建（POST）与资料更新（PATCH）**禁止携带 `model` 字段**，出现即 `400 invalid_input`（"model 由大模型配置派生，不可直接设置"）。
- `binding-validation.ts` 中 `model ∈ config.models` 校验删除（`config.models` 本身随 /api/config 删除）。
- 业务资料读面（GET businesses 等）仍返回 `model`（派生值或 `''`），供展示。

## 10. 在线验证：异步遍历验证

短 HTTP 超时（≤30s，§8）与长串行验证（N 模型 × 30s 探针）不能共存于一个同步请求，故验证拆为**提交 + 轮询**。

### 10.1 流程

1. `POST .../pi-config/validate { config }`：**同步**做结构校验（§9.2）+ 掩码占位符拒绝（沿用 `findPiMaskPlaceholder`），失败 → 400（只含字段路径）；通过 → 派生默认模型、枚举全部 `provider/id`、创建内存验证记录、候选配置**整体一次**原子写入 `cache/pi/validations/{validation_id}/agent/models.json`（0700/0600 沿用）、后台开始**串行**探针，**立即返回 202** `{ validation_id, total }`。
2. 后台串行探针：每个模型一次真实探针调用（`probePiModel`，单模型超时 = **内部常量 30s**，代码注释注明"暂定值，待真实数据校准；未来可能按模型差异化"）；任一失败**不中断**，全部验完。
3. 前端以约 2s 间隔轮询 `GET .../pi-config/validate/{validation_id}`，逐条渲染已完成结果（✓/✗ + 耗时 + 脱敏原因），直至 `done`。
4. **全部通过** → 记录标记可确认（含派生的默认模型），TTL 10 分钟从 done 起算；存在失败项 → `all_passed: false`，无确认资格，用户删除/修好不可用项后重新提交验证。
5. `confirm` 不变（凭 `validation_id` 确认服务端保存的同一份记录；要求 status=done 且 all_passed；TTL 内）。

### 10.2 状态机与响应结构

```ts
/** 单个模型的验证结果（错误详情已脱敏） */
interface PiModelValidationItem {
  model: string;          // provider/id
  ok: boolean;
  duration_ms: number;    // 到首个真实生成事件的耗时；失败为到失败的耗时
  error?: string;         // 失败原因（脱敏；含 failure_kind 语义）
}

/** GET .../pi-config/validate/{validation_id} 的 200 响应 */
type PiValidationStatus =
  | { status: "running"; total: number; results: PiModelValidationItem[] } // results 为已完成前缀（声明顺序）
  | { status: "done"; all_passed: boolean; results: PiModelValidationItem[]; default_model?: string }
  | { status: "failed"; error: string };  // 探针进程级故障（非单模型失败），脱敏
```

- `POST validate` 202 响应：`{ validation_id: string; total: number }`。
- GET 404：validation_id 未知/过期/服务重启后——前端提示"验证已失效，请重新验证"。
- 验证记录保持内存形态：每业务同时一个（新提交取消在飞探针并取代旧记录）、重启失效、关闭时清理目录；done 后 10 分钟 TTL。
- 确认凭据就是 `validation_id`（done 且 all_passed 时才具备确认资格）。

## 11. 控制台变更

### 11.1 PiConfigSection（重做，并上移到表单顶部）

- **删除**：平台默认/自定义模式切换 Radio、"模型（provider/id）"独立输入项、"恢复平台默认"中的全局模型选择、`globalModels`/`onIncludeModelChange` props、对外层 Form `model` 字段的读写。
- **布局**：在编辑页表单中**移到最顶部**（业务名/agent 之后、总纲之前），体现大模型配置的核心地位；不做独立页签。
- **形态**（仅编辑页渲染）：
  - 未配置：醒目警告 Alert（§9.3 文案）+ 空 JSON 编辑器。
  - 已配置：脱敏 JSON 回填编辑器；下方展示"当前默认模型：`<model>`（取第一个 provider 的第一个模型）"。
  - 一个 models.json 编辑器（TextArea，等宽字体，占位提示指向帮助抽屉）+「厂商配置帮助」按钮（保留，右侧 Drawer）+「在线验证全部模型」+「确认保存」（仅验证全过后可用）+「删除配置」（Popconfirm；无需选替代模型；经更新队列生效）。
  - 验证为异步（§10）：点击后进入轮询态，**逐条实时渲染**结果列表（每个 `provider/id` 一行：进行中/✓/✗ + 耗时 + 失败原因脱敏）；任何编辑使验证失效（沿用）。
  - 掩码占位警告、`EffectivenessNote`（下次运行生效说明）沿用。
- 帮助抽屉 `PiProviderHelpDrawer` **保留**，模板更新：deepseek/openai 改为显式 `models` 写法（如 `{ "deepseek": { "apiKey": "...", "models": [{ "id": "deepseek-chat" }] } }`，内置 provider 的 baseUrl/元数据由 pi 合并继承）；千问模板保持；补充两点说明：①默认模型 = 第一个 provider 的第一个模型，排最前的放主用模型；②列出的每个模型保存前都会真实验证。

### 11.2 BusinessEditPage

- 删除：`model` Form.Item/Select、`models` state、`/api/config` 的 `models` 消费、`piIncludeModel` 逻辑；保存 PATCH 不再携带 `model`。
- 创建页：大模型配置区显示警告（创建后在编辑页配置；业务不存在时 pi-config API 不可用，创建页不提供编辑）；**创建不再要求选模型**。
- 编辑页：渲染重做并置顶后的 `PiConfigSection`；`profile.model === ''` 时显示未配置警告。

### 11.3 BusinessesPage

- "模型"列：已配置显示派生默认模型；未配置显示黄色"未配置"标签（与警告语义一致）。

### 11.4 SettingsPage

- 删除"可选大模型（AGENT_PI_MODELS 驱动）"展示行（全局配置概念消失）。

### 11.5 设计原则固化（console-design.md）

在 `docs/designs/2026-09-14-skill-platform-spec-v3/design/console-design.md` §2（易用性）追加：帮助信息两级制——**简单说明用行内问号 Tooltip；复杂内容（配置模板、多步骤指引、厂商差异）用右侧 Drawer**。本次 PiConfigSection 为参考实现。

## 12. HTTP API 变更汇总

| 端点 | 变更 |
| --- | --- |
| `GET /api/config` | 响应删除 `models` 字段 |
| `POST /api/businesses` | body 禁止 `model`（400） |
| `PATCH /api/businesses/:id` | body 禁止 `model`（400；取代原"自定义配置业务 409"规则——现在任何业务都不可直接改 model） |
| `GET /api/businesses/:id/pi-config` | 不变（`{ configured, model, config? }`，model 为派生默认） |
| `POST .../pi-config/validate` | body 删除 `model`，只收 `{ config }`；同步结构/掩码校验失败 400；通过 → **202 `{ validation_id, total }`**（后台串行探针） |
| `GET .../pi-config/validate/{validation_id}` | **新增**：200 返回 `PiValidationStatus`（§10.2）；未知/过期/重启 → 404 |
| `POST .../pi-config/confirm` | 不变（要求 done 且 all_passed；TTL 10 分钟从 done 起算） |
| `DELETE .../pi-config` | 不再需要 body |

## 13. 安全与脱敏

- socket 上的 `model` 参数与 `models` op 响应只含 provider 名与模型 id；apiKey/baseUrl 不出 models.json 文件。
- 验证失败详情沿用 `maskPiText` + `collectPiModelsSecrets` 脱敏管线；验证期向日志门面注册秘密、关闭时清理等语义不变。
- 派生目录、验证目录权限（0700/0600）、原子写入不变。
- agent-service 解析 models.json 失败的错误文本不得携带文件内容。

## 14. 配额、会话与审计

- 配额：`agent` op 每次计 1（不论成败）不变；链式兜底每次尝试 = 1 次调用，业务 `max_agent_calls` 需 ≥ 链长（模板 README 加一句说明）。
- `models` op 不计配额。
- 审计：每次尝试是独立 pi 进程，审计 jsonl 逐条记录（含各自 `--model`）；agent-service 调用日志新增 `model` 字段。
- 建议（文档）：链式重试 `mode: "fresh"`。

## 15. 模板与文档同步清单

| 文件 | 动作 |
| --- | --- |
| `templates/config.json.example` | 删除 `AGENT_PI_MODELS`、`AGENT_PI_AGENT_DIR` 条目；**新增 `AGENT_HTTP_TIMEOUT_MS`**（可选，默认 30000，说明用途与范围） |
| `templates/agent-package/README.md` | 新增 `sdk.agent` 的 `model` 参数与 `sdk.models()` 说明；链式兜底完整示例（枚举 → 逐模型尝试 → **异常处理与日志写法示范**——业务包由用户实现，平台只能模板引导健壮写法）；配额提示 |
| `docs/designs/2026-09-14-skill-platform-spec-v3/design/console-design.md` | §2 追加帮助两级原则；检查模型选择相关段落同步（配置区位置、model 派生） |
| `docs/designs/2026-09-14-skill-platform-spec-v3/design/` 下活文档（`lifecycle.md`、`scheduler-loop-contracts.md`、`glossary.md`、`asset-model.md`、`security.md`） | 同步 socket 契约 v2、业务配置唯一来源、去全局化、HTTP 超时配置（这些文件命中 `AGENT_PI_MODELS`/`全局模型`/`models.json`；历史 T-spec 与旧 plan 保留原貌不动） |
| `docs/specs/2026-10-26-business-pi-configuration-spec.md` | 文首加"修订记录"：指向本 spec，列出被取代条目（全局兜底、单模型同步验证、简写 provider、remove 需替代模型、独立 model 输入项、无 HTTP 超时） |
| `.agents/skills/platform-ops/SKILL.md` | 核对模型排障路径（全局回退已消失）按需更新 |
| `docs/dailylog`（按现有惯例） | 记录本次变更 |

## 16. 迁移与兼容

- 平台未上线，无对外兼容负担；socket 契约 v2 已做防御（v1 带 model → 拒绝）。
- 部署侧：`.easemob-agent-workspace/platform/config.json` 中 `AGENT_PI_MODELS`、`AGENT_PI_AGENT_DIR` 两键成为无效键（解析宽松不报错），建议删除；`AGENT_HTTP_TIMEOUT_MS` 为可选新增（缺省 30000，无需动作）；全局派生 models.json 残留目录不再被读取，可手工清理。
- 数据侧：`businesses.model` 列保持不变（`''` = 未配置）；无迁移 SQL。
- 业务包侧：老 SDK（发 v1）对新平台完全可用；新 SDK（恒定 v2）对老平台被清晰拒绝。

## 17. 测试策略

- sdk：`model` 校验（空串抛错）；全部请求恒定 v2；`models()` 解析与错误传递；无配置返回空枚举。
- agent-service：v1/v2 接受与拒绝矩阵；v1 带 model → invalid_request；`model_not_allowed`；`model_not_configured`（agent/compact 拒绝、models 空枚举、clear 放行）；models op 不计配额；serve 解析失败 → run 失败（错误文本不含文件内容）；`--model` 实际传值（默认/覆盖）；日志含 model 字段。
- app/server：config 无两项全局配置、`AGENT_HTTP_TIMEOUT_MS` 解析（默认/合法值/越界拒绝）；server 超时应用（requestTimeout/headersTimeout 关系）；self-check 无 ④；validate 异步全流程（提交 202/轮询 running→done/全过发凭据/部分失败无凭据/结构非法 400/掩码拒绝 400/串行顺序/失败不中断/404 语义）；派生默认模型（含顺序调整）；confirm/remove 新语义；create/patch 禁 model。
- console：apiFetch 超时（默认 30s/可覆盖/友好报错）；PiConfigSection 渲染（未配置警告/已配置回填/轮询进度列表/确认按钮门控/编辑失效）；BusinessEditPage 无 model 字段、配置区置顶与警告；BusinessesPage 未配置标签；SettingsPage 无 models 行。
- 全仓构建 + 全量测试 + prettier/eslint。

## 18. 发布

- `@asteriskzuo/agent-sdk` 升 **0.3.0**（新能力：AgentCall.model、sdk.models()；契约恒定 v2）；发布由用户手工执行（同以往惯例）。
- 业务包升级 SDK 后可使用链式兜底；不升级不受影响（老 SDK 发 v1，新平台兼容）。
