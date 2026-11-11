# 控制台易用性优化批 spec（2026-11-11）

> 自包含执行规格。执行者只需读本文件；涉及现状代码的位置均已给出文件路径与现状摘要，无需回查设计文档。
> 背景出处（非必读）：`docs/PROGRESS.md`「控制台易用性优化批（2026-11-11 提出）」行、`docs/specs/2026-11-10-business-stats-spec.md`（统计一期/二期契约）。

## 1. 背景与目标

统计一期/二期上线后，控制台已能看队列、任务、运行记录、按日二维统计。用户实际使用后发现五类易用性缺口，本批一次性补齐：

1. **时间序反人类**：任务查询列表默认从旧到新，人们习惯看最新；且不能按列排序。
2. **业务运行记录内容太薄**：仅 run_id/时间/状态三列，排查时要回库查 event_id、失败阶段、失败原因。
3. **统计页无法下钻**：某天失败数异常时，看不到「这一天有哪些 run → 每个 run 的 LLM 调用/业务指标/失败原因/日志」。
4. **统计二维表不能导出**：想要 CSV 做外部图表分析。
5. **run 失败原因不落库**：`outcome.reason` 只进了日志文件，列表/详情看不到，排查必须翻日志。

目标：以上五点全部落地，且**不改动任何采集侧行为**（llm_calls / run_metrics / lifecycles 现有写入语义不变），只做「落库补一列 + 读口扩展 + 前端展示」。

## 2. 范围

### 做

| # | 项 | 层 |
|---|---|---|
| F1 | lifecycles 迁移 v5：新增 `reason` 列；markTerminal 落失败原因 | runtime |
| F2 | LifecycleStore 新增按单日查询读口；LlmCallStore / RunMetricsStore 新增按 run 查询读口 | runtime |
| F3 | `GET /api/businesses/:id/runs` 增加可选 `date` 过滤参数 | console-api |
| F4 | 新增 `GET /api/runs/:id/detail`（run 详情：打标 + LLM 调用 + 业务指标） | console-api |
| F5 | 新增 `GET /api/runs/:id/log`（业务日志只读，尾部截断 + 路径安全） | console-api + 装配层 |
| F6 | 任务查询表：默认入队时间倒序 + 入队/完结时间列头点击排序（入口/出口队列同效） | console |
| F7 | 业务运行记录表：列扩充（事件 ID/耗时/失败阶段/失败原因）+ 创建/完结时间列头排序 | console |
| F8 | 统计页「日期详情」：选日期出当日 run 明细表 → 行展开看 LLM 调用/业务指标/失败原因 → 可查看日志 | console |
| F9 | 统计二维表导出 CSV（纯前端） | console |
| F10 | 错误明细表空态文案说明（长期为空 = 平台健康） | console |

### 不做（明确排除）

- token 消耗维度深化（按模型分桶/缓存命中率等）——用户明确暂缓。
- 告警通道（系统错误企微推送）、定时健康检查——未立项，本批不涉及。
- 任务查询/运行记录的服务端分页——现状全量拉取保持不变（行量可控，排序在前端做）。
- 队列 `query()` 的 SQL 默认排序不改动（`take()` 的 FIFO、countQueue 均不受影响；前端排序即可满足需求）。
- llm_calls / run_metrics 写入路径零改动。

## 3. 现状要点（执行者必读的事实基线）

- 迁移原语：`packages/database/src/database.ts` 的 `migrate(db, module, migrations)`，`migrations` 下标+1 即版本号，已应用跳过。
- runtime 模块迁移集中在 `packages/runtime/src/env-provider.ts` 的 `MIGRATIONS`（当前 4 个：v1 env_entries + lifecycles 建表、v2 `failed_at` 列、v3 llm_calls、v4 run_metrics），入口 `migrateRuntimeSchema(db)`，各 store 创建时幂等调用。本批追加后即为 v5。
- lifecycles 表现行列：`lifecycle_id / business_id / event_id / channel_id / status / created_at / finished_at / failed_at`。其中 `failed_at` 字段名有误导性——它存的是**失败阶段分类**（`check-input` / `main` / `check-output`），不是时间（见 `packages/runtime/src/lifecycle-store.ts:17-19` 注释）。本批不动这个字段名（改名是破坏性契约变更）。
- `Lifecycle.execute`（`packages/runtime/src/lifecycle.ts`）三处打终态：
  1. `onSetupError`（上下文组装/serve 失败）：`store.markTerminal(run_id, "failed")`，错误消息只在日志；
  2. `onRunnerError`（runner 平台错误）：同上；
  3. 正常收尾：`store.markTerminal(run_id, outcome.status, outcome.failed_at)`，`outcome.reason`（runner 产出，failed/timeout 时有值，如 `exit code 1 (duration_ms=12)`）只进日志。
- 读口现状：
  - `LifecycleStore.listByBusiness(business_id, limit=50)`：`ORDER BY created_at DESC`（已是倒序）；
  - `LlmCallStore` 只有 `record` + `dailyCalls`；`RunMetricsStore` 只有 `record` + `dailyMetrics`；均无按 run 查询口。
- 监控路由 `packages/console-api/src/routes-monitoring.ts`：`GET /api/businesses/:id/runs`（limit 参数，上限 500）、`GET /api/runs/:id`。
- run_id 形状：`/^run_[0-9A-HJKMNP-TV-Z]{26}$/`（`packages/workflow-runner/src/runner.ts:67` 的 RUN_ID_PATTERN，Crockford base32 ULID）。
- 业务日志落盘规则（runner.ts:235）：`{workspaceRoot}/businesses/{business_id}/logs/{source}/{session_id}/{run_id}.log`。
- console-api 装配：`createConsoleApi(deps, options)`（`packages/console-api/src/server.ts`），`options.llm_calls` / `options.run_metrics` 可选注入、缺省降级；装配层在 `app/server/src/bootstrap.ts`（持有 workspaceRoot）。
- 前端：`app/console/src/pages/DashboardPage.tsx`（队列计数 + 任务查询 + 业务运行记录）、`app/console/src/pages/StatsPage.tsx` + `app/console/src/stats.ts`（透视/格式化纯函数）。antd v5 Table；console 有自己的 jest 测试（`app/console/tests/`）。
- 队列任务查询：`TaskQueue.query()` 返回全量匹配行（无分页），`ORDER BY enqueued_at, rowid` 升序。

## 4. 数据层契约（runtime）

### 4.1 迁移 v5

`packages/runtime/src/env-provider.ts` 的 `MIGRATIONS` 追加第 5 个迁移：

```sql
ALTER TABLE lifecycles ADD COLUMN reason TEXT;
```

- 存量行 `reason = NULL`（SQLite ALTER ADD COLUMN 语义）；与 v2 加 `failed_at` 同模式。
- 语义：失败/超时的**人读原因**（runner outcome.reason 或平台错误消息首段）；success 恒 NULL。

### 4.2 LifecycleRecord / LifecycleWriter 变更

`packages/runtime/src/lifecycle-store.ts`：

```ts
export interface LifecycleRecord {
  // ……现有字段不变……
  /** 失败/超时原因（人读，最长 500 字符，超出截断）；
   *  仅 failed/timeout 的 run 可能有值；success 与迁移前的历史行无此字段 */
  reason?: string;
}

export interface LifecycleWriter {
  markRunning(record: { /* 不变 */ }): void;
  /** 终态打标：status + finished_at（+ 失败阶段 failed_at + 失败原因 reason）。
   *  reason 仅 failed/timeout 时有意义；超过 500 字符截断（防超长错误文本撑大行） */
  markTerminal(
    lifecycle_id: string,
    status: "success" | "failed" | "timeout",
    failed_at?: string,
    reason?: string,
  ): void;
}
```

- 实现：UPDATE 语句加 `reason = ?`；`reason` 截断常量 `MAX_REASON_LEN = 500`；`rowToRecord` 把 NULL 映射为缺省。
- `LifecycleStore` 读口返回值自然带上 `reason`（SELECT 列表加列）。

### 4.3 Lifecycle 接线（lifecycle.ts）

三处 markTerminal 调用点补传 reason：

1. `onSetupError`：`store.markTerminal(run_id, "failed", undefined, errorMessage(err))`；
2. `onRunnerError`：同上（平台错误消息作为 reason）；
3. 正常收尾：`store.markTerminal(run_id, outcome.status, outcome.failed_at, outcome.reason)`。

### 4.4 新增三个读口

**LifecycleStore 增加：**

```ts
/** 按业务 + 单日查执行记录：date 为 YYYY-MM-DD（本地日历日，口径与 dailyRuns 的
 *  date(created_at,'localtime') 一致）；按 created_at 倒序；防御上限 500 行 */
listByBusinessOnDate(business_id: string, date: string): LifecycleRecord[];
```

SQL：`WHERE business_id = ? AND date(created_at, 'localtime') = ? ORDER BY created_at DESC LIMIT 500`。

**LlmCallStore 增加：**

```ts
/** 单次 run 的 LLM 调用明细（run 详情 API 数据源）；按 ts 升序（时间线序） */
listByRun(run_id: string): LlmCallEntry[];
```

```ts
/** LLM 调用明细行（LlmCallRecord 的读侧平铺形态：usage 展开为可选顶层字段） */
export interface LlmCallEntry {
  run_id: string;
  business_id: string;
  ts: string;               // 调用结束时刻（UTC ISO）
  op: string;               // v1 恒 'agent'
  model: string;            // provider/id
  skills: string[];         // 落库 JSON 数组解析回 string[]
  mode: string;             // channel | fresh
  ok: boolean;              // 落库 0/1 映射回 boolean
  error?: string;           // 失败错误码；ok=true 缺省
  duration_ms: number;
  input_tokens?: number;    // 以下 6 项：落库 NULL 映射为缺省（与 LlmCallRecord.usage 语义一致）
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_total?: number;
}
```

**RunMetricsStore 增加：**

```ts
/** 单次 run 的业务指标明细（run 详情 API 数据源）；按 key 字典序升序 */
listByRun(run_id: string): RunMetricEntry[];
```

```ts
/** 业务指标明细行：value_text / value_num 二选一折叠回单一 value */
export interface RunMetricEntry {
  key: string;               // 指标名（run_metrics.key 原样）
  value: string | number;    // value_text 非 NULL 取字符串，否则取 value_num
}
```

读口均为纯 SELECT，无 fail-open 要求（读失败照常抛错，由 console-api 统一 500）。

## 5. API 层契约（console-api）

### 5.1 DTO 新增（`packages/console-api/src/dto.ts`）

```ts
/** GET /api/runs/:id/detail 响应 */
export interface RunDetailResponse {
  record: LifecycleRecord;        // 打标记录（含 reason；类型从 runtime re-export）
  llm_calls: LlmCallEntry[];      // LLM 调用明细，ts 升序；llmCalls 未装配时恒 []
  metrics: RunMetricEntry[];      // 业务指标明细，key 升序；runMetrics 未装配时恒 []
}

/** GET /api/runs/:id/log 响应 */
export interface RunLogResponse {
  run_id: string;
  /** 命中日志文件相对 workspace 根的路径（如 businesses/b01.../logs/jira/HIM-1/run_01....log），回显用 */
  path: string;
  /** 日志内容（UTF-8；被截断时为尾部内容） */
  content: string;
  /** true = 日志超过读取上限，content 仅为末尾部分 */
  truncated: boolean;
  /** 日志文件总字节数 */
  size: number;
}
```

`LifecycleRecord` / `LlmCallEntry` / `RunMetricEntry` 由 console-api 从 `@asteriskzuo/agent-runtime` re-export（与现状 LifecycleRecord 同模式）。

### 5.2 `GET /api/businesses/:id/runs` 增加 `date` 参数

- 新增可选 query 参数 `date=YYYY-MM-DD`：提供时走 `listByBusinessOnDate`，忽略 `limit`（读口自身 500 行上限）；校验复用 routes-stats.ts 的日历日校验口径（形状 + 真实存在性，非法 → 400 `invalid_input`）。校验函数抽到共用模块（如 `http.ts` 或新 `date-param.ts`），routes-stats 一并改用，不复制实现。
- 不提供 `date` 时行为与现状完全一致（limit 路径不动）。

### 5.3 新增 `GET /api/runs/:id/detail`

- 依赖：`lifecycle.get` + `llmCalls?.listByRun` + `runMetrics?.listByRun`。
- run 不存在 → 404 `not_found`（与 `/api/runs/:id` 同口径）。
- `llmCalls` / `runMetrics` 缺装降级：对应字段恒 `[]`（与 stats 路由同纪律）。

### 5.4 新增 `GET /api/runs/:id/log`

- 依赖新增：`ConsoleApiOptions.workspace_root?: string`（装配层传入平台 workspace 根，与 runner 同根）。缺装 = 降级：路由照常注册，一律 404 `not_found`（"日志接口未装配"语义写进 message）。
- 处理流程：
  1. `lifecycle.get(run_id)` 不存在 → 404；
  2. run_id 形状校验：`/^run_[0-9A-HJKMNP-TV-Z]{26}$/`，不合 → 400 `invalid_input`（路径安全第一道闸）；
  3. 定位日志文件：在 `{workspace_root}/businesses/{business_id}/logs/` 下做**两层目录扫描**（第一层任意目录名 = source、第二层 = session_id），找文件名恰为 `{run_id}.log` 者。**不解析 channel_id、不拼接用户输入进路径**；扫描用 `readdirSync({ withFileTypes: true })`，只下钻目录、只匹配精确文件名；目录不存在/无命中 → 404 `not_found`（"日志不存在或已轮转"）。
  4. 读取护栏：默认返回**末尾** 256 KB（`DEFAULT_LOG_BYTES = 262144`；排障看尾部）；query `bytes` 可调（正整数，上限 `MAX_LOG_BYTES = 1048576`，非法 → 400）。文件 ≤ 读取上限时全量返回、`truncated=false`；否则取尾部、`truncated=true`。
- 响应 `RunLogResponse`（JSON，与全 API 风格一致；不直接吐 text/plain）。

### 5.5 前端可消费性

全部新端点只读，登录即可（与监控/统计路由同级，无额外权限）。

## 6. 前端契约（app/console）

### 6.1 DashboardPage——任务查询表（F6）

- 「入队时间」列：`sorter: (a, b) => a.enqueued_at.localeCompare(b.enqueued_at)` + `defaultSortOrder: "descend"`（ISO UTC 字符串字典序即时间序）。
- 「完结时间」列：同款 sorter；`finished_at` 缺省（undefined）排最后（antd 对 undefined 的自然处理即可，不额外发明规则）。
- 其余列不加排序。入口/出口队列共用此表，天然同效。
- 后端零改动（数据本就全量在前端）。

### 6.2 DashboardPage——业务运行记录表（F7）

现有列（运行 ID/状态/创建时间/完结时间）基础上扩充：

| 新列 | 数据源 | 说明 |
|---|---|---|
| 事件 ID | `record.event_id` | 排在运行 ID 后 |
| 耗时 | `finished_at - created_at` 前端计算 | 未完结显示 `—`；格式化复用 `stats.ts` 的 `formatDurationMs` |
| 失败阶段 | `record.failed_at` | 值原样（check-input/main/check-output）；无值 `—` |
| 失败原因 | `record.reason` | 无值 `—`；长文本 `Tooltip` 包裹省略显示（`ellipsis: true`） |

- 「创建时间」「完结时间」列加客户端 sorter；创建时间 `defaultSortOrder: "descend"`（API 已倒序返回，此列为交互一致性兜底）。

### 6.3 StatsPage——日期详情下钻（F8）

三步交互（用户确认口径）：

1. **选日期**：主表「日期」列渲染为可点击链接（或行尾「详情」按钮——实现取其一，推荐日期列可点击）。点击后主表下方出现新 Card「日期详情 YYYY-MM-DD」；再次点击或点关闭按钮收起。切换业务/日期范围时收起。
2. **当日明细表**：调 `GET /api/businesses/:id/runs?date=YYYY-MM-DD`，列 = 运行 ID/状态/创建时间/完结时间/耗时/失败阶段/失败原因（与 6.2 同款渲染，可抽公共列定义）。默认创建时间倒序。
3. **run 行展开**：`expandable.expandedRowRender` 懒调 `GET /api/runs/:id/detail`，展示三块：
   - 失败原因（有则置顶红字展示）；
   - 「LLM 调用」小表：时间（本地时区 HH:mm:ss.SSS）/模型/状态（ok 绿 ✓ / failed 红 ✗）/耗时/输入 token/输出 token/缓存读/缓存写/成本/错误码；无数据显「无 LLM 调用记录」；
   - 「业务指标」小表：key/value 两列；无数据显「无业务指标」；
   - 「日志」按钮：点击调 `GET /api/runs/:id/log`，Modal 展示 `<pre>` 全文；`truncated=true` 时顶部提示「仅显示末尾部分（共 N 字节）」；404 时提示「日志不存在或已轮转」。

### 6.4 StatsPage——CSV 导出（F9）

- 「运行统计」Card extra 放「导出 CSV」按钮（无数据或末选业务时禁用）。
- 导出内容 = 当前主表透视结果（`pivotDaily` 产物 + 当前生效列定义，含动态 biz 列组），列头用中文标题（与表格一致，列组拼 `父-子`，如 `运行-总数`、`业务-severity-high`）。
- 纯前端实现：拼 CSV 字符串（字段含 `,` `"` `\n` 时 RFC4180 引号转义），`\uFEFF` BOM 头（Excel 中文兼容），`Blob` + 临时 `<a download>` 触发下载，文件名 `stats-{business_id}-{from}-{to}.csv`。
- 错误明细小表不导出（只出主二维表）。

### 6.5 StatsPage——错误明细空态（F10）

- `emptyText` 改为「暂无 LLM 调用错误（长期为空 = 平台健康；有内容 = LLM 调用级失败按错误码分桶计数）」。

## 7. 装配层（app/server）

- `bootstrap.ts` 调 `createConsoleApi` 时在 `options` 增加 `workspace_root`：取装配根已有的平台 workspace 根（与传 runner 的同一值），不新读环境变量。

## 8. 测试要求

- runtime：迁移 v5 平滑（v4 库升级后旧行 reason 为 NULL）、markTerminal reason 落库与 500 截断、listByBusinessOnDate 本地日历日口径/倒序/上限、listByRun（llm 平铺/缺省映射、metrics 折叠/排序）。
- console-api：runs?date= 校验与过滤、detail 404/降级/聚合形状、log 的形状校验 400/不存在 404/截断 bytes 参数/路径安全（构造 `run_..` 类非法 id 必须 400）；现有 117 个测试保持绿。
- console：现有测试保持绿；CSV 生成纯函数（转义/BOM）单测；日期详情交互按现有测试风格补最小用例。
- 全仓 `yarn test` 绿；用真实 platform.db 副本做迁移 v5 冒烟（升级后旧行可见、新列 NULL）。

## 9. 验收标准

1. 任务查询表默认最新在前，入队/完结时间列头可点击切换排序（入口/出口同效）。
2. 业务运行记录表可见事件 ID/耗时/失败阶段/失败原因，创建/完结时间可排序。
3. 统计页点日期 → 当日 run 明细 → 行展开见 LLM 调用 + 业务指标 + 失败原因 + 可开日志。
4. 统计二维表可导出 CSV，Excel 打开中文不乱码。
5. 失败 run 的 reason 落库并在上述列表/详情可见；历史行显示 `—`。
6. 真实库副本迁移 v5 平滑，全仓测试绿。

## 10. 决策记录（本批已确认，不再讨论）

1. **排序全部前端做**：任务/运行记录数据已全量在前端，服务端排序与分页是过度设计；后端仅新增 date 过滤与两个详情端点。
2. **reason 复用 markTerminal 加参数**（不拆新方法），截断 500；平台自身错误消息也落 reason（onSetupError/onRunnerError）。
3. **日志定位用两层目录扫描**而不解析 channel_id：channel_id 格式是编码产物，扫描对 runner 布局规则的唯一事实源依赖最薄（只依赖 `{run_id}.log` 文件名与两级目录深度）。
4. **日志读尾部**：排障场景最新内容在末尾；上限 1 MB 防大文件打爆页面。
5. **CSV 只导主表**，错误明细不导。
6. **错误明细空态文案**（F10）：用户未明确表态的开放项，按「说明性文案」落地（成本一行，价值是消除"这表是干啥的"困惑）。
7. **token 消耗维度深化不做**（用户明确暂缓）。
