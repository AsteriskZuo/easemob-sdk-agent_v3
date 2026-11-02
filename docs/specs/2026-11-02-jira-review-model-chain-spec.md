# jira-ticket-review 业务包多模型链式兜底 spec（2026-11-02）

> 本 spec 自包含：执行所需的契约、字段语义、现状事实、测试要求全部内联。
> 背景出处（非必读）：`docs/specs/2026-11-01-business-multi-model-spec.md`（平台侧 `sdk.agent` 的 `model` 参数与 `sdk.models()` 枚举的定义来源，已实现并随 `@asteriskzuo/agent-sdk@0.3.0` 发布）。
> 本文设计已获用户确认（2026-11-02）。

## 1. 背景

平台已支持业务程序按次指定模型（`sdk.agent(..., { model })`）并枚举本业务生效配置（`sdk.models()`），`@asteriskzuo/agent-sdk@0.3.0` 已发布。

jira-ticket-review 业务包当前只做**单次**大模型审查：模型调用抛错或输出无法解析即整体失败。线上已出现过"模型不按 schema 输出"的真实事故形态（HIM-24051 复审输出缺 summary 字段）。本次让业务包用上平台新能力：**枚举生效配置里的全部 provider/model，按声明顺序链式尝试，第一个产出合法审查结果的模型即采纳，其余不再调用**——同一工单审查用多模型兜底，降低单模型故障/失常导致的失败率。

重试策略归业务包代码（平台零参与），本 spec 是该策略在 jira-ticket-review 的落地。

## 2. 目标 / 非目标

### 2.1 目标

- `sdk` 依赖从 `^0.2.0` 升到 `^0.3.0`（含 lockfile 更新）。
- 审查调用改为链式兜底：枚举 → 扁平化 → 逐个尝试（每次显式带 `model`，`mode: "fresh"`）→ 首个"成功"即停。
- 每次尝试、命中、失败都有带 `model` 字段的业务日志。
- 测试覆盖链式语义全部分支。

### 2.2 非目标

- 不改审查 prompt、skill、输出 schema、通知消息体（通知里**不加**模型信息——模型归属运维细节，看日志）。
- 不改去重、终态短路、Bug 过滤、人员标签、审查记录（`ReviewRecordStore` 的数据结构不变）。
- 不改平台侧任何代码；不改 `agent-package.json`（入口、skills 绑定不变）。
- 不实现"部分模型失败仍成功但要降标记"之类的质量分级——成功判定是二值的（见 §4.2）。

## 3. 现状事实（执行前核对，如有出入以代码为准并上报）

仓库：`business/jira-ticket-review/`（独立于平台 workspace，用 npm 非 yarn）。

- `package/package.json`：`dependencies["@asteriskzuo/agent-sdk"] = "^0.2.0"`；有 `package-lock.json`。
- `package/src/review-flow.ts`：主编排 `runReviewFlow(event, deps)`。
  - `ReviewFlowDeps.agent` 当前签名：`(call: { skills: string[]; input: unknown; mode?: "channel" | "fresh" }) => Promise<unknown>`（无 `model`）；无 `models` 字段。
  - 步骤 6（约 line 170）：单次 `deps.agent({ skills: ["jira-ticket-review"], input: buildAgentInput(...), mode: "fresh" })`。
  - 步骤 7：`outputText = typeof agentOutput === "string" ? agentOutput : JSON.stringify(agentOutput)` → `deps.log("info", "大模型原始输出", ...)` → `parseReviewOutput(outputText)`（来自 `./review-output.js`，返回 `ReviewOutput | undefined`）→ 解析失败 `return { type: "fail", reason: "审查输出解析失败" }`。
  - 后续步骤（8 写记录 / 9 skip 不通知 / 10 组装通知）保持不变。
- `package/src/programs/main.ts`：薄入口，把 `sdk.run/sdk.agent/sdk.config/sdk.secret/sdk.log` 接进 `runReviewFlow`，`sdk.models` 尚未接线。
- `package/tests/review-flow.test.ts`：`makeDeps(overrides)` 工厂产出全 mock 的 `ReviewFlowDeps`（`agent` 默认返回合法 pass JSON 字符串）；现有用例多处断言 `deps.agent` 调用次数（如 `toHaveBeenCalledTimes(1)`、未调用）。
- SDK 侧事实（0.3.0，来自 `packages/sdk/src/sdk.ts`）：
  - `AgentCall.model?: string`——provider/id，缺省 = 业务默认模型；必须在生效配置枚举内，否则服务端 `model_not_allowed`（抛错到业务侧）。
  - `sdk.models(): Promise<ModelsInfo>`；`ModelsInfo = { default: string; providers: Array<{ name: string; models: string[] }> }`；未配置大模型返回 `{ default: "", providers: [] }`（**不抛错**）。
  - 未配置大模型时调 `sdk.agent`/`sdk.compact` 会被服务端拒绝（`model_not_configured`，抛错）。

## 4. 设计

### 4.1 链式算法（review-flow.ts 内置私有函数）

```
async function runAgentReviewWithFallback(deps, input): Promise<{ review, model, outputText } | undefined>
  const modelsInfo = await deps.models()          // 抛错 → 向上抛（整体 fail，见 4.3）
  const chain = modelsInfo.providers.flatMap(p => p.models.map(m => `${p.name}/${m}`))
  if (chain.length === 0) return undefined 的特例：直接整体 fail「业务未配置大模型配置」（见 4.3）
  const failures: string[] = []
  for (const model of chain):
    let outputText: string
    try:
      const output = await deps.agent({ skills: ["jira-ticket-review"], input, mode: "fresh", model })
      outputText = typeof output === "string" ? output : JSON.stringify(output)
    catch (e):
      const msg = e instanceof Error ? e.message : String(e)
      deps.log("warn", "模型调用失败，尝试下一个", { issueKey, model, errorMessage: msg })
      failures.push(`${model}: 调用失败 ${msg}`); continue
    deps.log("info", "大模型原始输出", { issueKey, model, output: outputText })  // 保持"先落日志再解析"纪律
    const review = parseReviewOutput(outputText)
    if (review !== undefined):
      deps.log("info", "模型审查成功", { issueKey, model, decision: review.decision, ...现有字段 })
      return { review, model, outputText }
    deps.log("warn", "模型输出解析失败，尝试下一个", { issueKey, model })
    failures.push(`${model}: 输出解析失败`)
  deps.log("error", "全部模型审查失败", { issueKey, attempts: failures.length })
  return undefined
```

调用方（原步骤 6/7 的位置）：

```
const result = await runAgentReviewWithFallback(deps, buildAgentInput(issueKey, ticket, tags))
if (!result) return { type: "fail", reason: `全部模型审查失败（${failures 摘要}）` }   // 摘要形式见 4.4
const review = result.review
// 后续步骤 8/9/10 完全不变
```

链的顺序 = 配置声明顺序（第一个 provider 的第一个模型 = 平台默认模型，天然最先尝试）。

### 4.2 "成功"判定（二值）

| 情形 | 判定 | 动作 |
| --- | --- | --- |
| `deps.agent` 抛错（传输/配额/模型不可用/model_not_allowed/pi 崩溃/超时） | 失败 | warn 日志 → 下一个 |
| 返回但 `parseReviewOutput` 得到 `undefined`（模型未按 schema 输出） | 失败 | warn 日志 → 下一个 |
| `parseReviewOutput` 返回合法 `ReviewOutput`（decision 为 pass/fail/skip 任一） | 成功 | 停止链，采纳该结果 |

**模型判出 skip 也算成功**（skip 是合法审查结论，不是失败）——命中即停，后续模型不再调用。

### 4.3 边界与失败语义

- 枚举为空（`providers: []`，业务未配置大模型）：**不调 agent**，直接 `{ type: "fail", reason: "业务未配置大模型配置" }`（省一次必败的配额消耗；此时不调 `store.markReviewed`，工单下次事件还会重试——与现有"审查失败不写记录"语义一致）。
- `deps.models()` 本身抛错：通道级故障，不再硬试，向上抛由 main 映射为 fail（reason 含原始错误信息）。
- 全部模型失败：`{ type: "fail", reason: "全部模型审查失败：<model1>: <原因1>；<model2>: <原因2>…" }`（汇总全部尝试，便于一次日志看清）。
- 每个尝试都是独立 `mode: "fresh"` 会话（平台建议的链式用法，防上下文串味）。
- 去重/短路/过滤逻辑（步骤 1–5）在链式调用之前，不受影响；链式只替换步骤 6–7。

### 4.4 deps 与接线变化

```ts
// ReviewFlowDeps 两处变化：
agent: (call: {
  skills: string[];
  input: unknown;
  mode?: "channel" | "fresh";
  model?: string;            // 新增（注释：provider/id；链式兜底用）
}) => Promise<unknown>;
models: () => Promise<ModelsInfo>;  // 新增（注释：枚举生效配置；未配置返回空枚举不抛错）
```

`ModelsInfo` 类型从 `@asteriskzuo/agent-sdk` import（`export type { ModelsInfo }`，已随 0.3.0 导出）。

`main.ts` 接线加一行 `models: sdk.models`。

### 4.5 日志纪律（沿用现有，仅加 model 维度）

- 每次尝试：warn（失败原因，带 `model`）。
- 每次拿到原始输出：info「大模型原始输出」（带 `model`，先于解析——解析失败时第一现场已在日志）。
- 命中：info「模型审查成功」（带 `model` + 现有 decision/classification/scenarios/skillVersion 字段；原「审查结果」日志的字段并入本条，不重复记两行）。
- 全部失败：error「全部模型审查失败」（带 `attempts` 总数）。
- 通知消息体不变（不含模型信息）。

### 4.6 配额提醒（文档，不改代码）

每次 `deps.agent` 调用计 1 次平台配额，链长 = 生效配置模型总数。`平台配置指南.md` 补一句：控制台业务资料的 `max_agent_calls` 必须 ≥ 大模型配置里的模型总数（建议留 1–2 余量），否则兜底链未走完即被配额强杀。

## 5. 改动点清单

| 文件 | 改动 |
| --- | --- |
| `package/package.json` | `@asteriskzuo/agent-sdk` → `^0.3.0`；`npm install` 更新 `package-lock.json` |
| `package/src/review-flow.ts` | `ReviewFlowDeps.agent` 加 `model?`；新增 `models` 字段；步骤 6–7 替换为 `runAgentReviewWithFallback`（§4.1）；原「审查结果」日志并入「模型审查成功」；文件头注释补链式语义 |
| `package/src/programs/main.ts` | 接线 `models: sdk.models` |
| `package/tests/review-flow.test.ts` | `makeDeps` 补 `models` 默认 mock（单 provider 单模型，保持既有用例语义）；`agent` mock 断言适配；新增链式用例（§6） |
| `平台配置指南.md` | 补 `max_agent_calls` ≥ 模型总数的配额提醒（§4.6） |

## 6. 测试要求（review-flow.test.ts）

既有用例适配后必须全绿（默认 mock = 单模型链，行为与旧"单次调用"等价），新增：

1. **首模型成功**：链有 2 个模型，第一个即返回合法输出 → `agent` 恰调 1 次，且调用参数 `model` = 链首（`provider/id` 形式）。
2. **首个抛错、第二个成功**：`agent` 调 2 次（第 1 次 reject、第 2 次 resolve 合法输出）→ 流程成功；warn 日志被记录（可用 mock log 断言）。
3. **首个输出解析失败、第二个成功**：第 1 次返回非 JSON 垃圾 → 调 2 次 → 成功。
4. **全部失败（混合）**：链 2 个模型，一个抛错一个输出垃圾 → 整体 `fail`，reason 含两个模型名与各自原因；`agent` 恰调 2 次；不写审查记录（沿用现有失败语义断言）。
5. **空枚举**：`models()` 返回 `{ default: "", providers: [] }` → `fail`（reason 含"未配置"），`agent` 一次不调。
6. **models() 抛错**：→ `fail`，`agent` 一次不调。
7. **链顺序与 model 传参**：链 = `a/m1, a/m2, b/m1`（两个 provider），依次失败时断言第 n 次调用的 `model` 参数严格等于链中第 n 个；且每次调用 `mode === "fresh"`。
8. **skip 命中即停**：首个模型返回合法 `decision:"skip"` 输出 → 只调 1 次，流程 `return null`（沿用 skip 语义）。

## 7. 验证

- `cd business/jira-ticket-review/package && npm run lint && npm run format:check && npm test` 全绿。
- 全仓侧不受影响（business/ 不在平台 workspace），无需平台回归；但 `git status` 仅限本目录与 docs。

## 8. 提交纪律

所有改动一次提交（不中间提交）；提交前勾选 plan 复选框并随代码一起提交。
