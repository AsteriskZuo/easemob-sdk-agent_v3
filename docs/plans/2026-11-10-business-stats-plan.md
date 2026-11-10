# 业务包运行统计（第一期）实施计划

> 日期：2026-11-10
> Spec：`docs/specs/2026-11-10-business-stats-spec.md`（自包含，执行只读 spec + 本计划）
> 范围：一期（llm_calls 落库 + 按日统计 API + 控制台二维表）。二期（业务 metrics 契约）不在本计划，单独立项。
> 执行方式：子代理分波执行；所有任务完成后主代理统一验收、更新本文件复选框、单次提交。

## 全局纪律

- 子代理**不执行 git commit**，代码留在工作区由主代理统一提交；
- 代码注释风格对齐所在包现状（中文 docstring 为主）；
- 触碰 spec 未覆盖的既有契约时停下来上报，不自行变更；
- 并行波次的子代理只跑自己模块的测试，不跑全量 build；最终全量检查由主代理在收尾任务执行；
- 统计落库 fail-open 纪律：任何写库路径异常必须消化（warn 日志），不得抛回影响 run。

## 关键跨任务契约（避免并行分叉，双方严格按此签名实现）

### 契约 A：`LlmCallSink`（T1 实现、T2 定义接口并调用）

接口**定义在 agent-service 包内**（T2），runtime 的实现（T1）结构兼容、不 import agent-service（与 AgentSessionMapping 同纪律）。形状以 spec §5.1 为准，一字不差：

```ts
export interface LlmCallSink {
  record(call: {
    run_id: string; business_id: string; ts: string;
    op: "agent"; model: string; skills: string[]; mode: "channel" | "fresh";
    ok: boolean; error?: string; duration_ms: number;
    usage?: {
      input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_write_tokens: number;
      total_tokens: number; cost_total: number;
    };
  }): void;
}
```

### 契约 B：聚合读口（T1 实现、T3 消费）

挂在 runtime 包两个 store 上（console-api 不裸写 SQL）：

```ts
// LifecycleStore 新增：
export interface DailyRunAggregate {
  date: string;            // YYYY-MM-DD（本地时区，date(created_at,'localtime')）
  total: number;           // 当日 run 总数（含 running）
  success: number; failed: number; timeout: number; running: number;
  failed_phase: { "check-input": number; main: number; "check-output": number; unknown: number }; // failed_at NULL 归 unknown
  avg_duration_ms: number | null;  // 当日已完结 run（success/failed/timeout 全含）平均耗时；无已完结 run 为 null
}
dailyRuns(business_id: string, from: string, to: string): DailyRunAggregate[];
// from/to 为 YYYY-MM-DD 闭区间，按本地日历日过滤；返回按 date 升序

// LlmCallStore（含 sink 与聚合读口）：
export interface DailyLlmAggregate {
  date: string;
  calls: number;                    // 含失败行
  errors: Record<string, number>;   // ok=0 行按 error 分桶计数
  input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; total_tokens: number;
  // 以上 5 项 = 有 usage 行的求和；无 usage 行不计入（不视为 0 计入平均）
  cost_total: number;               // 有 usage 行的 cost_total 求和
  calls_without_usage: number;
  avg_duration_ms: number | null;   // 全部行（含失败）平均耗时；当日无行为 null
}
dailyCalls(business_id: string, from: string, to: string): DailyLlmAggregate[];
```

### 契约 C：API 形状（T3 实现、T5 消费）

以 spec §6 为准：`GET /api/stats/daily?business_id=&from=&to=` → `{ business_id, from, to, rows: StatsRow[] }`，`StatsRow = { date, metric, bucket, value }`，指标清单与命名以 spec §4.4 为准（一期无 biz.*）。聚合值到 StatsRow 的映射规则：

- `DailyRunAggregate` → `run.total/run.success/run.failed/run.timeout/run.running`（bucket ""）+ `run.failed_phase`（bucket = 阶段名，0 也出行，保证二维表列稳定）+ `run.avg_duration_ms`（null 不出行）；
- `DailyLlmAggregate` → `llm.calls/llm.cost/llm.avg_duration_ms/llm.calls_without_usage`（bucket ""，avg 为 null 不出行）+ `llm.tokens.*` 五行 + `llm.errors` 按错误码逐桶出行；
- 行排序：`(date, metric, bucket)` 字典序。

## 任务

### T1：runtime——llm-call-store + 两个聚合读口（packages/runtime）

- [x] 新增 `src/llm-call-store.ts`：`createLlmCallStore(db)` 返回 `{ record, dailyCalls }`；`record` 内部 try/catch 消化异常 + warn（fail-open）；
- [x] `env-provider.ts` 的 `MIGRATIONS` 追加 v3（spec §4.1 DDL 原样，含两个索引）；`migrateRuntimeSchema` 不变（数组变长即生效）；
- [x] `lifecycle-store.ts` 的 `LifecycleStore` 接口新增 `dailyRuns`（契约 B）；实现里分日口径 `date(created_at,'localtime')`，耗时 = `(julianday(finished_at)-julianday(created_at))*86400000`；
- [x] 测试（`tests/llm-call-store.test.ts` + lifecycle-store 测试补 dailyRuns）：建表幂等（v2 老库升级路径：先按旧 MIGRATIONS 建 v2 库再跑新迁移）、record 正常/异常消化、dailyCalls 各字段聚合（含 usage 缺失行、错误分桶、跨时区边界行）、dailyRuns（状态计数、failed_phase 分桶含 unknown、avg 含 timeout、空日不出行）；
- [x] `src/index.ts` 导出新类型与工厂。

### T2：agent-service——sink 接口与调用（packages/agent-service）

- [x] `src/index.ts`：新增 `LlmCallSink` 接口（契约 A 原样）；`AgentServiceDeps` 新增可选 `llm_call_sink?: LlmCallSink`（docstring：装配根注入，缺省不采集；实现必须自行消化异常）；
- [x] `pi-runner.ts` `runAgentOp`：`done()` 内调用 sink——`business_id` 用 `parseChannelId(ctx.channel_id)`（判 `kind==="business"`，兜底 `""` + warn）；`ts` = done 时刻 ISO；`error` = `resp.error.split(":")[0]`；usage 映射 pi Usage → sink 字段（`cacheRead→cache_read_tokens` 等；`reasoning/cacheWrite1h` 不采）；
- [x] dispatch 层的 `quota_exceeded` / `model_not_configured` 拦截**不落行**（spec 决策 3）；
- [x] 测试：有 sink 时成功行字段齐全（usage 映射正确）、失败行 ok=0 无 usage、无 sink 时行为不变、sink 抛异常不影响 op 返回（done() 内防御 try/catch，按下方「注」执行）；

> 注：spec 决策 2 说「写失败由实现消化」，但 agent-service 作为调用方再补一层防御 try/catch 更稳（pi-runner done() 内包一层，warn 后照旧返回）。以此计划为准。

### T3：console-api——routes-stats（packages/console-api）

- [x] 新增 `src/routes-stats.ts`：`statsRoutes(deps: { lifecycle: LifecycleStore; llmCalls?: LlmCallStore; registry: BusinessRegistry })` 返回 `GET /api/stats/daily` 一条路由；
- [x] 参数校验（spec §6）：business_id 必填、registry 存在性（不存在 404 not_found）、from/to 形非法或 from>to → 400 invalid_input、缺省 to=今天/from=13 天前、区间上限 92 天；
- [x] 按契约 C 映射成长表行返回；dto.ts 补 `StatsRow` / `DailyStatsResponse` 类型；
- [x] `server.ts` 装配：`ConsoleApiOptions` 新增可选 `llm_calls?: LlmCallStore`（缺省降级为 rows 恒空，保证 T4 落地前可编译）；装配 statsRoutes 并注册；
- [x] 测试：校验分支、空数据、映射正确性（含 0 值 failed_phase 出行、null avg 不出行、errors 分桶）、区间上限（92 放行/93 拒绝）。

### T4：bootstrap 装配（app/server）

- [x] `bootstrap.ts`：`createLlmCallStore(db)` 注入 `createAgentService`（deps.llm_call_sink）；console server options 传入 llm_calls store（T3 落地后主代理补线，TODO 已消除）；
- [x] 检查 `pi-probe` 或其他 createAgentService 调用点（packages/local-runner/src/cli.ts）不注入 sink、行为不变；
- [x] 测试：app/server 现有测试不因 deps 变化而红（编译层面可选成员，零改动全绿）。

### T5：控制台统计页（app/console）

- [x] 新增 `src/pages/StatsPage.tsx`：业务下拉（复用现有 businesses 列表 API 与 client.ts 模式）+ 日期范围（默认近 14 天，选业务/改日期即查询）；
- [x] 长表 → 二维表透视在前端做：行 = date 倒序，列分组「运行」（total/success/failed/timeout/失败阶段/平均耗时）与「大模型」（调用次/输入 token/输出 token/缓存读/缓存写/成本/平均耗时/无 usage 次）；0 值列也要出现（列稳定）；零数据日补零行；llm.errors 动态桶在下方「错误明细」小表呈现；
- [x] 格式化：token 千分位、duration ms→s（保留 1 位小数）、cost 保留 4 位小数（USD）；数值 null/缺失显示 `-`；
- [x] 路由 + AppLayout 导航项「统计」；样式对齐现有页面（不引新组件库；dayjs 补为直接依赖，系 antd 既有传递依赖）；
- [x] 测试：透视函数单测（长表→二维表、补零、格式化）+ 页面级契约 C mock 端到端用例。

### T6：收尾验收（主代理执行）

- [x] 全仓 build + 全部测试绿（yarn test 6m6s 全绿；lint/prettier 通过）；
- [x] 真实环境验证：真实 platform.db 副本上 `dailyRuns` 聚合与手工 SQL 逐日一致（11-04 total=136、11-03 failed/main=1、11-09 running=2 等全对上），v2→v3 迁移在真实库副本上平滑生效；**llm_calls 首行需平台重启后的首个真实 run 产生**（双实例同库风险，不代跑）；
- [x] `GET /api/stats/daily` 核对：routes-stats 测试以真实 store 贯穿映射/校验/边界；线上 curl 与控制台页面人工复核留待部署后；
- [x] 本地运行（local-runner）回归：不注入 sink（cli.ts 零改动），typecheck 通过，全量测试绿即不产生 llm_calls 行；
- [x] 更新本文件复选框 + 工作日志，单次提交（PROGRESS.md 行含二期，待二期完成后一并翻勾）。

## 任务依赖关系

```text
T1（runtime stores）──┬──> T3（console-api）──> T4（bootstrap）──> T6
T2（agent-service）───┴────────────────────────> T4
T5（console 页面）只依赖契约 C（API 形状已定），可与 T3/T4 并行，T6 前完成
```

波次建议：波1 = T1 + T2 + T5（T5 纯前端，按契约 C mock 数据开发）；波2 = T3 + T4；波3 = T6 主代理收尾。
