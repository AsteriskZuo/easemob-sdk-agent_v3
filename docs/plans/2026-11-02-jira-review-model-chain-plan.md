# jira-ticket-review 业务包多模型链式兜底 实现计划（2026-11-02）

> 依据：`docs/specs/2026-11-02-jira-review-model-chain-spec.md`（执行前必读，链式算法/成功判定/边界语义以它为准）。
> 纪律：所有任务完成后统一提交一次（不做中间提交）；提交前更新本文件任务复选框并随代码一起提交。
> 工作目录：`business/jira-ticket-review/`（独立于平台 workspace，用 npm 非 yarn）。

## 任务清单

### T1 依赖升级：@asteriskzuo/agent-sdk ^0.3.0

- [x] `business/jira-ticket-review/package/package.json`：`dependencies["@asteriskzuo/agent-sdk"]` 改为 `^0.3.0`；`npm install`（在 `package/` 目录）更新 `package-lock.json`。
- [x] 验证 `node_modules/@asteriskzuo/agent-sdk/package.json` 实际安装版本 ≥ 0.3.0，且 `ModelsInfo` 类型可从包导出（`dist/index.d.ts` 含 `ModelsInfo`）。

### T2 review-flow：链式兜底核心

- [x] `package/src/review-flow.ts` `ReviewFlowDeps`：`agent` 的 call 参数新增 `model?: string`（注释：provider/id，链式兜底用）；新增 `models: () => Promise<ModelsInfo>`（注释：枚举生效配置，未配置返回空枚举不抛错）；`ModelsInfo` 从 `@asteriskzuo/agent-sdk` import type。
- [x] 新增私有函数 `runAgentReviewWithFallback(deps, issueKey, input)`：按 spec §4.1 实现——枚举 → 扁平化（`provider/model` 声明顺序）→ 逐个 `deps.agent({ skills: ["jira-ticket-review"], input, mode: "fresh", model })`；抛错 warn 下一个；原始输出先 info 落日志（带 `model`）再 `parseReviewOutput`；解析失败 warn 下一个；首个合法 `ReviewOutput` 返回 `{ review, model, outputText }`；全部失败 error 日志后返回 `undefined`。
- [x] `runReviewFlow` 步骤 6–7 替换：`deps.models()` 枚举为空 → `{ type: "fail", reason: "业务未配置大模型配置" }`（不调 agent、不写记录）；`deps.models()` 抛错 → 向上抛；`runAgentReviewWithFallback` 返回 `undefined` → `{ type: "fail", reason: "全部模型审查失败：<model>: <原因>；…" }`（汇总各尝试）；成功则取 `review` 继续步骤 8–10（不变）。
- [x] 日志：原「审查结果」info 日志并入「模型审查成功」（带 `model` + decision/classification/scenarios/skillVersion），不重复记两行；文件头注释补一段链式兜底语义说明。

### T3 main 接线

- [x] `package/src/programs/main.ts`：deps 增加 `models: sdk.models`。

### T4 测试适配与链式用例

- [x] `package/tests/review-flow.test.ts` `makeDeps`：补 `models` 默认 mock（返回 `{ default: "mock/mock-model", providers: [{ name: "mock", models: ["mock-model"] }] }`），保持既有用例语义等价；既有 `agent` 调用次数断言按需适配。
- [x] 新增 spec §6 全部 8 个用例：首模型成功（恰 1 次调用、model 传参正确）；首个抛错第二个成功；首个解析失败第二个成功；全部失败（reason 汇总、恰 2 次、不写记录）；空枚举 fail 且不调 agent；models() 抛错 fail 且不调 agent；链顺序与 model/mode 传参逐次断言（`a/m1, a/m2, b/m1`，每次 `mode:"fresh"`）；skip 命中即停。

### T5 文档与验证

- [x] `平台配置指南.md`：补配额提醒——`max_agent_calls` 必须 ≥ 大模型配置模型总数（建议留 1–2 余量），否则兜底链未走完即被配额强杀。
- [x] `cd business/jira-ticket-review/package && npm run lint && npm run format:check && npm test` 全绿。
- [x] 交付前自审：对照 spec §5 改动点清单核对无遗漏；`git status` 改动仅限 `business/jira-ticket-review/` 与 `docs/`。

## 任务依赖关系

- T1 → T2（`ModelsInfo` 类型与 `model` 参数来自 0.3.0，编译依赖）。
- T2 → T3（deps 形状定了 main 才能接线）。
- T2、T3 → T4（测试 mock 跟随最终 deps 形状）。
- T4 → T5（验证在全部改动之后）。
