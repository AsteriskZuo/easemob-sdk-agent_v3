# 业务包运行统计（第二期）实施计划

> 日期：2026-11-10
> Spec：`docs/specs/2026-11-10-business-stats-spec.md`（自包含，执行只读 spec + 本计划；二期章节：§4.2/§4.5/§5.3/§5.4/§8、决策 7、验收 7-9）
> 范围：二期（业务 metrics 契约全链路：main 产出剥离 → run_metrics 落库 → API `biz.*` → 控制台业务列组 + sdk 契约扩展 + jira-ticket-review 先行验证）。一期已交付（commit `ac12a8d`）。
> 执行方式：子代理分波执行；所有任务完成后主代理统一验收、更新本文件复选框、单次提交。

## 全局纪律

- 子代理**不执行 git commit**，代码留在工作区由主代理统一提交；
- 代码注释风格对齐所在包现状（中文 docstring 为主）；
- 触碰 spec 未覆盖的既有契约时停下来上报，不自行变更；
- 并行波次的子代理只跑自己模块的测试，不跑全量 build；最终全量检查由主代理在收尾任务执行；
- 统计落库 fail-open 纪律：任何写库路径异常必须消化（warn 日志），不得抛回影响 run。

## 本期已定决策（plan 阶段裁定，执行不再讨论）

1. **决策点 B**：sdk 侧新增**独立** `checkMetrics` 函数，不并入 `checkFields`（两者语义不同：点分路径 required 校验 vs 扁平 kv 键名/类型校验）。
2. **contract.json `metrics` 节为可选节**（缺省 = 无 metrics 声明）：与 input/output「必须显式」不同——存量业务包的 contract.json 没有此节，要求显式 null 会让 `loadContract` 对全部存量资产报错。
3. **metrics 是平台保留键，无论合法与否都不进出口 payload**：形状合法 → 提取进 `RunOutcome.metrics` 且从 `output` 删除；形状非法 → 同样从 `output` 删除 + 丢弃 + bizSink warn（spec 决策 7 的「丢弃」按此细化：保留键在任何情况下都不应随 derive 事件出口）。
4. **基数护栏在 console-api 映射层执行**（不在 SQL）：单日单指标 distinct 字符串桶 > 20 时，按计数降序（计数相同按值字典序）取前 20 桶，其余合并为 `__other__` 桶（计数求和）。
5. **sdk 版本 0.4.0 → 0.5.0**：jira-ticket-review 依赖 npm 发布的 `@asteriskzuo/agent-sdk`（非 workspace 引用），**npm publish 由用户执行**（需 npm 登录权限）；T7 开发期用 `file:` 本地引用验证，提交时写 `^0.5.0`。

## 关键跨任务契约（避免并行分叉，双方严格按此签名实现）

### 契约 D：`RunOutcome.metrics` 与剥离规则（T2 实现，T6 消费）

```ts
// packages/workflow-runner/src/runner.ts
export interface RunOutcome {
  status: "success" | "failed" | "timeout";
  output: unknown;
  reason?: string;
  failed_at?: FailedAt;
  /** main 产出的平台保留键 metrics（剥离后；spec 决策 7）。仅 success 且形状合法时有值；
   *  failed/timeout 或 metrics 缺失/非法时为 undefined */
  metrics?: Record<string, string | number>;
}
```

剥离规则（新增内部纯函数，建议 `extractMetrics(output: unknown): { output: unknown; metrics?: Record<string, string | number>; invalid: boolean }`）：

- `output` 不是 plain object，或不含 `metrics` 键 → 原样返回（`{ output, invalid: false }`）；
- 含 `metrics` 键时，合法形状 = plain object + 扁平 + 键全匹配 `/^[a-z][a-z0-9_]*$/` + 键数 ≤ 50 + 值仅为 string（≤ 200 字符）或 number（`Number.isFinite`）：
  - 合法 → `{ output: <删去 metrics 键的副本>, metrics: <提取值>, invalid: false }`；
  - 任一不合 → `{ output: <删去 metrics 键的副本>, invalid: true }`（metrics 字段不出）；
- **剥离点**：runner.ts 阶段 3（check-output）之后、`return mainOutcome` 之前（现 runner.ts:517-519 之间）。严禁放入共享的 `outcomeFromFirst`——check-output 的注入信封必须能看到含 metrics 的原始产出（spec §5.3）；
- `invalid === true` → `bizSink("warn", { message: "metrics 形状非法，已丢弃" })`，run 成败不受影响；
- 只对 mainOutcome 剥离；check 阶段产出不提取（无 metrics 语义）。

### 契约 E：`RunMetricsStore`（T1 实现，T3/T6 消费）

`packages/runtime/src/run-metrics-store.ts`：

```ts
/** run_metrics 写口 + 按日聚合读口。record fail-open：内部 try/catch 消化 + warn，绝不抛回 */
export interface RunMetricsStore {
  /** 落一次 run 的全部 metrics（逐键一行）；metrics 为空对象时不写。
   *  ts = run 终态时刻（UTC ISO，由调用方取 markTerminal 同一时刻） */
  record(
    run_id: string,
    business_id: string,
    ts: string,
    metrics: Record<string, string | number>,
  ): void;

  /** 按日聚合（date(ts,'localtime') 分日，与 llm/runs 同口径）；from/to 为 YYYY-MM-DD 闭区间；
   *  返回按 (date, key) 升序。text 与 num 互斥分组：同一 key 混型时各自成组（防御，契约上不会发生） */
  dailyMetrics(
    business_id: string,
    from: string,
    to: string,
  ): DailyBizAggregate[];
}

export interface DailyBizAggregate {
  date: string; // YYYY-MM-DD（本地时区）
  key: string; // 指标名（run_metrics.key 原样）
  text_buckets: Record<string, number>; // 字符串值 → 出现次数（无字符串值为 {}）
  num_count: number; // 数值值行数（无数值值为 0）
  num_sum: number; // 数值值求和
}

export function createRunMetricsStore(db: Database): RunMetricsStore;
```

DDL 以 spec §4.2 原样为准（迁移 module `'runtime'` 追加 **v4**，`env-provider.ts` 的 `MIGRATIONS` 数组追加）。

### 契约 F：API `biz.*` 行映射（T3 实现，T4 消费）

`GET /api/stats/daily` 形状不变，rows 新增一族（与 run.*/llm.* 同表混排，排序契约不变）：

- 字符串桶 → `{ date, metric: "biz.<key>", bucket: <值原样>, value: <次数> }`；护栏按本期决策 4（>20 桶 → 前 20 + `__other__`）；
- 数值 → 三行 `{ metric: "biz.<key>.sum" | ".avg" | ".count", bucket: "", value }`（avg = sum/count；`num_count = 0` 时三行都不出）；
- deps 扩展：`statsRoutes(deps)` 新增可选 `runMetrics?: RunMetricsStore`；缺省 = 不出 biz 行（降级，与 llmCalls 缺省同模式）；
- `ConsoleApiOptions` 同步加可选 `run_metrics?: RunMetricsStore`。

### 契约 G：contract.json `metrics` 节与 `checkMetrics`（T5 实现，T7 消费）

```ts
// packages/sdk/src/contract.ts
/** contract.json 顶层可选 metrics 节的字段声明（值只允许 string|number，与平台保留键规则一致） */
export interface ContractMetricField {
  key: string; // 指标键，须匹配 [a-z][a-z0-9_]*
  type: "string" | "number";
  required?: boolean; // 缺省 false；true = main 产出 metrics 必须含此键
  desc?: string; // 展示用说明
}

// ContractDoc 扩展：
export interface ContractDoc {
  version: 1;
  input: { fields: ContractField[] } | null;
  output: { fields: ContractField[] } | null;
  metrics?: { fields: ContractMetricField[] } | null; // 可选节：缺省/null = 无声明
}

/** 校验 main 产出的 metrics 是否满足声明（独立函数，决策点 B）：
 *  - 声明了 required: true 的键：必须存在且类型匹配；
 *  - 声明的可选键：存在时类型必须匹配；
 *  - 未声明的键：不查（runner 侧防御式形状检查已兜底合法性）；
 *  - metrics 为 undefined/null 时：等价于 {}（required 键全部报缺失）；
 *  返回问题列表（空数组 = 通过），调用方（check 程序）一般 sdk.fail(problems.join("；")) */
export function checkMetrics(
  fields: ContractMetricField[],
  metrics: Record<string, unknown> | undefined | null,
): string[];
```

- `loadContract`：`metrics` 节缺省或为 null → 合法；存在则必须是 `{ fields: [...] }` 且逐字段校验（key 形、type 词表仅 string/number、required/desc 类型），非法抛错（与 input/output 同 fail-closed）；
- `src/index.ts` 导出 `checkMetrics` 与 `ContractMetricField`；`package.json` version → `0.5.0`。

## 任务

### T1：runtime——run_metrics 表 + RunMetricsStore（packages/runtime）

- [x] `env-provider.ts` 的 `MIGRATIONS` 追加 v4（spec §4.2 DDL 原样，含索引 `idx_run_metrics_biz_ts`）；
- [x] 新增 `src/run-metrics-store.ts`：`createRunMetricsStore(db)` 按契约 E 实现；`record` 逐键一行（string → value_text，number → value_num），内部 try/catch 消化异常 + warn（fail-open）；`dailyMetrics` 分日口径 `date(ts,'localtime')`；
- [x] `src/index.ts` 导出 `RunMetricsStore` / `DailyBizAggregate` / `createRunMetricsStore`；
- [x] 测试（`tests/run-metrics-store.test.ts`）：v3→v4 老库升级路径（先按旧 MIGRATIONS 建 v3 库再迁移）、record 正常/空对象不写/异常消化、dailyMetrics（字符串分桶计数、数值 count/sum、混型防御、跨日边界、空数据不出行）。

### T2：workflow-runner——RunOutcome.metrics + 剥离（packages/workflow-runner）

- [x] `RunOutcome` 新增 `metrics?`（契约 D 原样，docstring 照抄）；
- [x] 新增内部纯函数 `extractMetrics`（契约 D 规则：保留键合法提取/非法丢弃，两种都从 output 删键）；
- [x] 剥离点落在 check-output 阶段之后、`return mainOutcome` 之前（runner.ts:517-519 之间）；`invalid` 时 `bizSink("warn", ...)`；check 阶段产出不做提取；
- [x] 测试：合法 metrics 提取且 output 无该键、非法形状逐类（非对象/键名非法/超 50 键/值类型非法/字符串超 200 字符/非有限数）→ 丢弃 + warn + run 仍成功、无 metrics 键的产出原样、check-output 信封仍能看到含 metrics 的原始产出（剥离点位置回归）。

### T3：console-api——biz.* 行（packages/console-api）

- [x] `routes-stats.ts`：deps 新增可选 `runMetrics?: RunMetricsStore`；按契约 F 映射 `bizRows(agg: DailyBizAggregate)`；护栏（决策 4）在映射层实现；缺省 runMetrics 时不出 biz 行；
- [x] `server.ts`：`ConsoleApiOptions` 新增可选 `run_metrics?: RunMetricsStore`，装配传入 statsRoutes；
- [x] 测试：字符串桶映射、数值三行（含 count=0 不出）、护栏（21 桶 → 前 20 + `__other__`，计数相同按值字典序）、缺省降级、行序契约不变。

### T4：控制台——业务列组（app/console）

- [x] `src/pages/StatsPage.tsx` + `stats.ts` 透视扩展：rows 中 `biz.*` 族 → 第三个列组「业务」；
- [x] 透视规则：字符串指标 `biz.<key>` → 列名 `<key>=<bucket>`（动态收集区间内的 (key, bucket) 并集，按 key 字典序、bucket 字典序排）；数值指标 → 列 `<key>.sum` / `<key>.avg` / `<key>.count`（avg 保留 2 位小数）；缺失显示 `-`（列不补零，数据驱动）；
- [x] 无 biz 行时「业务」列组整体不出现（与一期列组稳定策略不冲突：biz 族本来就数据驱动）；
- [x] 测试：透视函数 biz 族用例（字符串动态列、数值三列、空 biz 不出列组）+ 页面级 mock 用例。

### T5：sdk——metrics 契约节 + checkMetrics（packages/sdk）

- [x] `contract.ts`：`ContractMetricField`、`ContractDoc.metrics?`、`loadContract` 的 metrics 节校验、`checkMetrics`（契约 G 原样）；
- [x] `src/index.ts` 导出 `checkMetrics` / `ContractMetricField`；
- [x] `package.json` version → `0.5.0`；
- [x] 测试：metrics 节缺省/null/非法形状、字段校验逐类（key 非法/type 词表/required 非布尔）、checkMetrics（required 缺失/类型不符/可选键存在时类型错/未声明键放行/metrics 为 null）。

### T6：平台接线（packages/runtime + app/server）

- [x] `lifecycle.ts`：`store.markTerminal(...)` 之后（lifecycle.ts:141 附近），`outcome.metrics` 非空 → `createRunMetricsStore(deps.db).record(run_id, business_id, <markTerminal 同一时刻 ISO>, outcome.metrics)`；store 实例在 `createLifecycle` 顶部与 lifecycleStore 并列创建一次；失败消化归 store 内部（fail-open），调用点不包 try/catch；
- [x] `app/server/src/bootstrap.ts`：`createRunMetricsStore(db)` 注入 console server options（`run_metrics`）；local-runner 不接（本地运行不落 run_metrics，与 llm_calls 同纪律）；
- [x] 验证 run-core/local-runner 行为不变：`RunOutcome` 多了可选键，executeRun/cli 原样打印即可，无需改动（确认 typecheck 绿）。

### T7：jira-ticket-review 先行验证（独立仓 `business/jira-ticket-review/`，GitHub: AsteriskZuo/jira-ticket-review）

- [x] 开发期把 `package/package.json` 的 `@asteriskzuo/agent-sdk` 临时改为 `file:../../../packages/sdk` 并 `npm install`，跑通该仓测试；
- [x] `package/contract.json` 顶层加 `metrics` 节：声明 `decision`（string, required）、`classification`（string, required）、`skill_version`（string, 可选）三键，desc 写清语义；
- [x] `package/apps/main/index.ts`：main 产出增加 `metrics` 成员——`decision` / `classification` 从现有 review-flow/review-output 产物取（子代理先在仓内定位真实来源，找不到 decision/classification 的现成字段时停下来上报，不得自行发明语义）；`skill_version` 取 agent-package.json 的 version 字段；
- [x] `package/apps/check-output/index.ts`：用 `checkMetrics(contract.metrics?.fields ?? [], output?.metrics)` 追加校验（在现有 checkFields 之后，problems 合并）；
- [x] 该仓测试全绿后，依赖改回 `^0.5.0`（**发布前 npm install 会失败，属预期**，提交信息注明「需 @asteriskzuo/agent-sdk@0.5.0 已发布」）；该仓提交需用户单独授权（独立 git 仓）。

### T8：收尾验收（主代理执行）

- [x] 全仓 build + 全部测试绿；lint/prettier 通过；
- [x] 真实 platform.db 副本冒烟：v3→v4 迁移平滑；手工塞 run_metrics 行后 `dailyMetrics` 与手工 SQL 一致；
- [x] 核对 spec 验收 7-9：真实 run 验证（run_metrics 有行、出口 payload 无 metrics、控制台 biz 列）需 sdk 0.5.0 发布 + 平台部署后进行，留给用户复核；
- [x] 更新本文件复选框 + `docs/PROGRESS.md`（二期行翻勾）+ 工作日志，单次提交。

## 任务依赖关系

```text
T1（runtime store）──┬──> T3（console-api）──┐
T2（runner 剥离）────┴──> T6（平台接线）─────┴──> T8
T5（sdk）──────────────> T7（jira-ticket-review，独立仓）──> T8（仅记录状态）
T4（console 前端）只依赖契约 F（mock 开发），与 T3 并行，T8 前完成
```

波次建议：波1 = T1 + T2 + T5 + T4（四个包互不依赖，契约 D/E/F/G 已定死）；波2 = T3 + T6 + T7；波3 = T8 主代理收尾。

## 遗留阻塞（不挡开发，挡真实验证）

1. `npm publish @asteriskzuo/agent-sdk@0.5.0` 需用户执行（T5 合并后）；
2. 平台重启部署后，跑真实工单复核 spec 验收 7-9；
3. jira-ticket-review 独立仓的提交与 push 需用户单独授权。
