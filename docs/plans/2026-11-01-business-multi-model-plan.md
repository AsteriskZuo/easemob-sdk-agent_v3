# 业务多模型选择与枚举 实现计划（2026-11-01）

> 依据：`docs/specs/2026-11-01-business-multi-model-spec.md`（执行前必读，契约/错误码/迁移要求以它为准；含两轮 grilling 收敛结论）。
> 纪律：所有任务完成后统一提交一次（不做中间提交）；提交前更新本文件任务复选框并随代码一起提交。

## 任务清单

### T1 SDK：model 参数 + models() + 契约恒定 v2

- [x] `packages/sdk/src/sdk.ts`：`AgentCall` 新增 `model?: string`（注释写清：provider/id、缺省 = 默认模型、白名单约束、fresh 建议）；`sdk.agent()` 对 `model` 非空校验（空串抛错）；新增 `sdk.models(): Promise<ModelsInfo>`（op `"models"`）；**全部请求恒定 `contract_version: "v2"`**。
- [x] `packages/sdk/src/socket.ts`：请求版本改为恒定 `"v2"`；注释写清 v2 升级内容清单（spec §5 表格同款文字）。
- [x] `packages/sdk/src/index.ts`：导出 `ModelsInfo` 等类型。
- [x] `packages/sdk/tests/sdk.test.ts`：model 空串抛错、请求恒定 v2、`models()` 成功/失败传递与无配置空枚举。

### T2 agent-service：白名单 + models op + model_not_configured

- [x] 新增 `packages/agent-service/src/models-json.ts`：解析生效 `models.json` → `{ providers: [{name, models}], allowed: Set<string> }`（运行时宽松结构校验，失败抛错且错误文本不含文件内容；保持声明顺序）。
- [x] `packages/agent-service/src/index.ts`：`ValidatedAgentRequest` 新增 `model?`；`validateRequest` 接受 v1/v2（v1 带 model → invalid_request；其他版本 → invalid_request；注释写清 v2 升级清单）；`dispatch` 新增 `models` op（不计配额）；`AgentServiceDeps` 删 `pi_agent_dir`；`AgentServeContext.pi_agent_dir`/`model` 注释更新；`serve()` 时解析 models.json（无配置跳过；解析失败抛错）；`agent`/`compact` 在无配置时回 `model_not_configured`，`clear` 放行。
- [x] `packages/agent-service/src/pi-runner.ts`：`runAgentOp` 显式 model 白名单校验（`model_not_allowed: <model>`）；实际模型 = `req.model ?? ctx.model`；调用日志加 `model` 字段；`buildPiEnv` 删全局回退。
- [x] `packages/agent-service/src/pi-compact.ts`：跟随 `buildPiEnv` 签名与无配置拦截。
- [x] `packages/agent-service/tests/`：v1/v2 接受拒绝矩阵、白名单拒绝、无配置三分支、models op 输出与配额、`--model` 默认/覆盖传值、serve 解析失败、日志 model 字段。

### T3 app/server 去全局化 + HTTP 超时配置：config / bootstrap / self-check

- [x] `app/server/src/config.ts`：删除 `AGENT_PI_MODELS`、`AGENT_PI_AGENT_DIR` 解析与 `Config.pi_models`/`pi_agent_dir` 字段；**新增可选 `AGENT_HTTP_TIMEOUT_MS`**（默认 30000，范围 1000–300000，越界启动报错）。
- [x] `app/server/src/bootstrap.ts`：删 `preparePiModels`/`loadModelList`/`globalModels` 及装配传参（含 agent-service `deps.pi_agent_dir`、pi-config-service `globalModels`）；将 HTTP 超时传入 console-api server 与 webhook server 装配。
- [x] `app/server/src/self-check.ts`：删检查④（保留 ③）。
- [x] console-api server（`packages/console-api/src/server.ts`）与 webhook server（`packages/entry-adapters/src/webhook.ts`）应用超时：`requestTimeout`/socket `timeout` = 配置值，`headersTimeout` = 其一半。
- [x] 对应测试更新（`config.test.ts`、`self-check.test.ts`、`integration.test.ts`、webhook/server 超时测试）。

### T4 app/server：异步遍历验证 + 默认模型派生 + remove 新语义

- [x] `app/server/src/models.ts`：删全局三函数（`validatePiModelsConfig`/`preparePiModels`/`loadModelList`）；`validateBusinessPiModels` 收紧（每 provider 必须显式非空 `models`、provider 名禁纯整数形态 `^\d+$`、不再做单 model 归属校验）；新增 `enumerateModels(config): string[]`（声明顺序）与 `deriveDefaultModel(config): string`。
- [x] `app/server/src/pi-config-service.ts` 重构 validate 为异步：`validate(businessId, operatorId, config)` → 同步结构/掩码校验（失败 400）→ 派生默认模型 + 枚举 → 创建内存验证记录（status=running、total、候选目录一次写入）→ 后台串行探针（单模型超时**内部常量 30s**，注释注明暂定值；失败不中断）→ 返回 `{ validation_id, total }`；新增 `getValidation(businessId, validationId)` 返回 `PiValidationStatus`（running 带已完成前缀 / done 带 all_passed 与 default_model / failed；未知或过期 → 404 语义）；`confirm` 要求 status=done 且 all_passed（TTL 10 分钟从 done 起算）；每业务单验证、新验证取消在飞探针、重启失效、close 清理目录等语义沿用；`remove` payload 去 model；deps 去 `globalModels`。
- [x] `packages/console-api/src/routes-pi-config.ts`：validate 202 + 新增 `GET .../pi-config/validate/{validation_id}`（404 语义）；DELETE 不再读 body。
- [x] `packages/console-api/src/dto.ts`：`PiValidationStatus`、`PiModelValidationItem`、validate 202 响应等新类型。
- [x] `app/server/src/updates/handlers.ts`：`pi.remove` payload 改为 `{ business_id }`（落库 `pi_models=NULL, model=''`）。
- [x] 对应测试（`models.test.ts`、`pi-config-service.test.ts`、routes 测试、updates 测试）。

### T5 console-api：model 只读化 + /api/config 去 models

- [x] `packages/console-api/src/dto.ts`：`EffectiveConfigView` 删 `models`。
- [x] `packages/console-api/src/binding-validation.ts`：删 `model ∈ config.models` 校验及 `config.models` 依赖。
- [x] `packages/console-api/src/routes-businesses.ts`：create/patch 出现 `model` → 400（"model 由大模型配置派生，不可直接设置"）；删原自定义配置 409 分支（被新规则覆盖）；`EffectiveConfigView` 装配去 models。
- [x] 对应测试（businesses 路由、binding、console-api 集成）。

### T6 console：配置区重做置顶 + 页面跟进 + apiFetch 超时

- [x] `app/console/src/api/client.ts`：`apiFetch` 支持超时（默认 `AbortSignal.timeout(30000)`、可按调用覆盖、超时友好报错）。
- [x] `app/console/src/components/PiConfigSection.tsx` 重做：删模式切换/model 输入/globalModels 与 onIncludeModelChange props/外层 model 读写；未配置醒目警告 Alert；已配置回填 + "当前默认模型"说明行；「在线验证全部模型」→ 提交 202 后 2s 轮询 `GET validate/{id}`，**逐条实时渲染**结果列表（进行中/✓/✗ + 耗时 + 脱敏原因）；全绿才可「确认保存」；「删除配置」Popconfirm（无替代模型选择）；404 → 提示重新验证；保留掩码警告与 EffectivenessNote。
- [x] `app/console/src/components/PiProviderHelpDrawer.tsx`：deepseek/openai 模板改显式 models；补默认模型派生与全量验证说明。
- [x] `app/console/src/pages/BusinessEditPage.tsx`：删 model 表单项/models state/piIncludeModel；**PiConfigSection 上移到表单顶部**（业务名/agent 之后、总纲之前）；创建页与编辑页未配置警告；保存不再带 model。
- [x] `app/console/src/pages/BusinessesPage.tsx`："模型"列未配置时渲染黄色"未配置"标签。
- [x] `app/console/src/pages/SettingsPage.tsx`：删"可选大模型"行。
- [x] console 测试更新（client 超时、PiConfigSection、business-form、create-draft-env、pages-smoke 等）。

### T7 runtime 注释同步

- [x] `packages/runtime/src/context-loader.ts`：`RunContext.model`（`''` = 未配置）与 `pi_agent_dir`（唯一来源）注释更新；行为不变。

### T8 模板与文档

- [x] `templates/config.json.example`：删 `AGENT_PI_MODELS`、`AGENT_PI_AGENT_DIR` 条目；新增 `AGENT_HTTP_TIMEOUT_MS`（可选，默认 30000，说明用途与范围）。
- [x] `templates/agent-package/README.md`：`model` 参数 + `sdk.models()` 说明；链式兜底完整示例（枚举 → 逐模型尝试 → **异常处理与日志写法示范**）；配额提示。
- [x] `docs/designs/2026-09-14-skill-platform-spec-v3/design/console-design.md`：§2 追加帮助两级原则；核对模型选择段落（配置区位置、model 派生）。
- [x] 同步活文档（`docs/designs/2026-09-14-skill-platform-spec-v3/design/` 下命中 `AGENT_PI_MODELS`/`全局模型`/`models.json` 的：`lifecycle.md`、`scheduler-loop-contracts.md`、`glossary.md`、`asset-model.md`、`security.md`）：逐一核对同步契约 v2、业务配置唯一来源、去全局化、HTTP 超时配置；历史 T-spec 与旧 plan 保留原貌不动。
- [x] `docs/specs/2026-10-26-business-pi-configuration-spec.md`：文首加修订记录（指向新 spec，列被取代条目）。
- [x] `.agents/skills/platform-ops/SKILL.md`：核对模型排障路径按需更新。
- [x] dailylog 记录。

### T9 全仓验证

- [x] `yarn build` 全绿。
- [x] 全量测试通过。
- [x] prettier / eslint 干净。
- [x] 交付前自审：对照 spec §12/§15 核对 API 与文档同步无遗漏。

### T10 发布准备（用户执行发布）

- [x] `packages/sdk/package.json` 版本升 `0.3.0`（npm publish 由用户手工执行）。

## 任务依赖关系

- T1、T2 互不依赖（契约以 spec §5 为准对齐），可并行。
- T3 → T4（同在 app/server，T4 依赖 T3 删除后的 config/bootstrap 形态）。
- T5 依赖 T4 的 dto 形态（同在 packages/console-api，可与 T4 同批改动但顺序检查）。
- T6 依赖 T5（console 消费新 API 类型）。
- T7 独立，任何阶段可做。
- T8 依赖 T1–T7 完成（文档反映最终形态）。
- T9 依赖全部前置任务。
- T10 依赖 T9（验证通过后改版本号）。
