# 业务包运行统计（平台指标 + 业务指标）Spec

> 日期：2026-11-10
> 状态：待评审
> 范围：LLM 消耗落库、按日统计 API、控制台二维表展示（一期）；业务包 metrics 产出契约与搬运（二期）。
> 前置：无（不依赖未实施文档）；相关背景 `docs/specs/2026-11-06-shared-run-execution-spec.md`（executeRun/RunOutcome）、`docs/specs/2026-11-09-local-run-spec.md`（本地运行共用执行核）。

## 1. 背景与目标

平台需要向控制台暴露业务包运行信息，当前缺口：

- **大模型消耗无数据**：pi-runner 已能拿到 pi 上报的 `usage`（token 数与成本），但只写日志、不落库（`packages/agent-service/src/pi-runner.ts:111-123` 的 `done()` 埋点）；run 目录下 `audit/llm-requests.jsonl` 只有请求体，没有 usage。
- **业务处理统计弱**：控制台只有队列计数与 run 列表（`packages/console-api/src/routes-monitoring.ts`），`lifecycles` 表数据齐全但没有聚合视图。
- **业务语义无通道**：业务产出（如 jira-ticket-review 的 decision/classification）只用于出口通知，随派生事件投递后不留痕，平台无法统计。

核心思路（已与需求方对齐）：

- **两类数据，两条采集路径**：
  - **平台事实**（run 状态/耗时、LLM 消耗）——平台自己是发起方，自采落库，业务包零配合；
  - **业务语义**（decision、classification 等）——平台不懂也不该懂，业务包按契约产出 `metrics` 段，平台原样搬运落库，不解释语义。
- **长表存储 + 长表 API，控制台透视成二维表**：每行 = 日期 × 业务 × 指标名 × 维度桶 × 值。新增指标不改表结构、不改 API，控制台展示怎么变数据层都不变。

### 一期目标（本 spec 主体）

1. `llm_calls` 表：每次 agent op（sdk.agent 调用）落一行，含模型、耗时、token 用量、成本、成败。
2. 按日统计 API：`GET /api/stats/daily`，返回长表行集，支持按业务 + 日期范围查询。
3. 平台指标聚合：run 量/成败/耗时/失败阶段分布（lifecycles）+ LLM 调用次/token/成本（llm_calls）。
4. 控制台统计页：业务选择 + 日期范围 + 二维表（行 = 日期，列 = 指标）。

### 二期目标（契约部分，一期不实施）

5. 业务产出契约扩展：main 输出可携带保留键 `metrics`（扁平键值）。
6. `run_metrics` 表与 runner 提取：平台从 main 产出剥离 `metrics` 落库，出口 payload 不变。
7. 统计 API 扩展 `biz.*` 指标族；jira-ticket-review 先行改造验证。

### 非目标

- 预聚合表/物化视图（量级小，实时 GROUP BY 足够；量大有瓶颈再议）；
- 成本单价管理面（成本用 pi 调用时点上报的 `usage.cost.total`，不建平台单价表）；
- 全平台跨业务汇总视图（v1 统计查询 business_id 必填）；
- 统计数据保留策略/TTL 清理（lifecycles 同样无清理，后续统一议）；
- compact op 的 LLM 用量采集（rpc 响应无 usage 可提取，见 §3 决策 3）；
- 告警、报表导出、图表组件（控制台 v1 只出表格）。

## 2. 当前代码事实（已核实）

### 2.1 lifecycles 表（run 事实，已落库）

`packages/runtime/src/lifecycle-store.ts`：

- 表结构（`packages/runtime/src/env-provider.ts:45-64`，迁移 module `'runtime'`，当前 v2）：`lifecycle_id PK | business_id | event_id | channel_id | status | created_at | finished_at | failed_at`。
- `status` 枚举：`running | success | failed | timeout`（created 是瞬时态不落行）。
- `failed_at` 仅失败的 run 有值：`check-input | main | check-output`；历史行与平台自身错误为 NULL。
- `created_at` / `finished_at` 为 UTC ISO 字符串（`new Date().toISOString()`）。
- 读口现状：`listByBusiness(business_id, limit)`、`get(lifecycle_id)`，无聚合查询。

### 2.2 LLM 用量来源（已具备，未落库）

- pi 的 `Usage` 类型（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:270`）：`input / output / cacheRead / cacheWrite / totalTokens / cost.{input,output,cacheRead,cacheWrite,total}`，可选 `reasoning`、`cacheWrite1h`。**cost 由 pi 在调用时点按其模型价格表算出**，自定义模型可能为 0。
- pi-runner 的 `extractAssistantOutput`（pi-runner.ts:67-96）已从 pi stdout JSONL 的最后一条 `message_end`（role=assistant）提取 `message.usage`，目前仅传入 `done()` 写日志。
- 一次 agent op = 一次 pi 单次推理（`-p --mode json --no-tools`），usage 取自最终 assistant 消息；平台侧每次 agent op 至多一行统计（op 内 pi 重试/模型链回退的中间消耗不单独计，见 §3 决策 3 的已知取舍）。
- `AgentServeContext`（`packages/agent-service/src/index.ts:22-45`）已有 `run_id`、`channel_id`、`model`；无 `business_id`（可从 channel_id 第三段解析，见 §5.1）。
- `AgentServiceDeps`（index.ts:58-65）为装配根注入：`pi_cli_path / pi_env / mapping`。构造点唯一：`app/server/src/bootstrap.ts:201`；本地运行 CLI 另有一处构造（`packages/local-runner/src/cli.ts`），不注入统计 sink 即不生效。
- compact op（`packages/agent-service/src/pi-compact.ts`）走 `--mode rpc` 长驻进程，响应只取 `success/error`，**无 usage 提取**。

### 2.3 run 产出与扇出链（metrics 二期改造点）

- `RunOutcome`（`packages/workflow-runner/src/runner.ts:37-42`）：`status / output / reason? / failed_at?`，`output` 为业务产出原样。
- 产出去向：`scheduler/src/derive-event.ts` —— success 时 `payload = output 原样`，failed/timeout 时 `payload = { status, output }`。因此**main 产出里新增的任何键都会进入出口事件 payload**，metrics 必须由 runner 剥离（§5.3）。
- `ExecutionResult.usage?: { tokens; duration_ms }` 字段已在类型上预留但注释「暂不填」（`packages/runtime/src/lifecycle.ts:157`）；本 spec 维持不填（llm_calls 取代其职责，见 §3 决策 8）。
- 契约机制：资产根 `contract.json` 顶层含 `input` / `output` 节（`null` 或 `{ fields: [...] }`），runner 只做存在性探测（runner.ts:111-129，额外顶层键不报错）；字段校验由业务 check 程序经 sdk 的 `loadContract` / `checkFields` 完成（`packages/sdk/src/index.ts:3-4`）。

### 2.4 迁移与装配机制

- 迁移原语 `migrate(db, module, migrations)`（`packages/database/src/database.ts:87-117`）：按模块名版本化，新表 = `MIGRATIONS` 数组追加一个版本。
- console-api 路由模式：`packages/console-api/src/routes-monitoring.ts` —— 纯函数返回 `Route[]`，`ApiError("invalid_input", ...)` 校验输入，登录即可访问（只读）。
- 时区：平台 run 记录时间戳为 UTC ISO；按日聚合需指定日历日口径（§3 决策 6）。

## 3. 架构决策（已定）

### 决策 1：LLM 消耗归平台自采，不进业务契约

平台是 LLM 调用的发起方（业务经 sdk.agent 调平台 agent-service），usage 在 pi-runner 手里。业务包不参与、不上报——防止不报/错报/虚报，且对所有存量业务包立即生效。

### 决策 2：新增 `llm_calls` 表，写点走注入 sink

- 表归属迁移 module `'runtime'`（与 env_entries/lifecycles 同模块，追加 v3），实现文件 `packages/runtime/src/llm-call-store.ts`。
- agent-service **不依赖 database 包**：`AgentServiceDeps` 新增可选 `llm_call_sink?: LlmCallSink`（接口定义在 agent-service 包内）；装配根（bootstrap）用 runtime 的实现注入；本地运行不注入 = 不采集。
- **fail-open**：sink 写失败只 warn 日志，绝不影响 agent 调用的返回（统计是附加面，不阻断业务）。

### 决策 3：一行 = 一次 agent op；compact 不采集

- 采集点 `runAgentOp` 的 `done()`（成功/失败统一出口）：成功带 usage 落行，失败落 ok=0 行（usage 字段 NULL）。
- **覆盖边界**：只有进入 `runAgentOp` 的请求才落行；`quota_exceeded` / `model_not_configured` 在 dispatch 层（agent-service/src/index.ts:218-242）被拦截、未消耗任何 LLM 资源，**不落行**（llm_calls 是消耗账，不是请求审计；配额拦截信号已有系统日志）。
- usage 缺失（提取失败/模型未上报）也落行，token 字段 NULL，并以 `llm.calls_without_usage` 指标暴露数据质量。
- compact op 实际消耗 token，但 rpc 响应无 usage 可提取，v1 不采集、不计调用次；后续 pi 暴露该信息再补。
- 已知取舍：usage 取自 op 最终 assistant 消息，op 内 pi 模型链回退的中间请求消耗不单独计；`model` 记请求生效模型（可能不等于实际回退命中的模型）。请求级精确账可交叉参考 run 目录 `audit/llm-requests.jsonl`（只有请求体，无 token）。

### 决策 4：成本用 pi 调用时点上报的 cost，不建单价表

`usage.cost.total` 是调用时点的价格计算结果，落库即历史真值；查询层重算反而会在调价后算错旧账。代价：pi 价格表未覆盖的自定义模型 cost 为 0——token 字段是权威数据，cost 是 best-effort 展示。（此决策修正了讨论期「查询层算成本」的初步想法：那时未确认 pi 自带 cost 字段。）

### 决策 5：长表存储 + 长表 API + 实时聚合

- 不建宽表（加指标要改表结构），不建预聚合表（当前量级：单业务每日 run 数十到数百，实时 GROUP BY 足够）。
- API 返回长表行 `{ date, metric, bucket, value }`，控制台前端透视成二维表；新增指标 = 新增行，API 形状不变。

### 决策 6：按日口径 = 平台服务器本地时区

`date(created_at, 'localtime')`（SQLite 本地时区修饰符，进程 TZ 决定）。部署环境即团队时区；不做时区参数（v1）。

### 决策 7：业务语义指标走 output 保留键 `metrics`（二期）

- `metrics` 是 main 产出的**平台保留键**：扁平对象，键 `[a-z][a-z0-9_]*`，值仅 string | number。
- runner 在收结果时剥离：形状合法 → `RunOutcome.metrics` + `output` 中删除该键（出口 payload 保持原样，出口绑定零感知）；形状非法 → 丢弃 metrics、业务日志 warn，**run 不失败**（统计不阻断业务）。
- 校验责任划分：runner 只做防御式形状检查；业务质量关口在 check-output（sdk 提供 `checkMetrics` helper，contract.json 可声明 `metrics` 节，见 §8）。
- 无 check 程序的旧结构资产同样可以产出 metrics（提取与 check 机制无关），只是没有契约校验背书。

### 决策 8：`ExecutionResult.usage` 维持不填

llm_calls 按 op 落库后，run 级用量 = `SUM(llm_calls)`，预留学生字段无消费者，保持「暂不填」。

## 4. 数据契约

### 4.1 `llm_calls` 表（一期；迁移 module `'runtime'` v3）

```sql
CREATE TABLE llm_calls (
  id            INTEGER PRIMARY KEY,
  run_id        TEXT NOT NULL,    -- 归属 run（= lifecycles.lifecycle_id）
  business_id   TEXT NOT NULL,    -- 冗余落列，免 join 聚合
  ts            TEXT NOT NULL,    -- 调用结束时刻（UTC ISO）
  op            TEXT NOT NULL,    -- v1 恒 'agent'（compact 不采集，决策 3）
  model         TEXT NOT NULL,    -- 请求生效模型（provider/id；回退命中模型不另记，决策 3）
  skills        TEXT NOT NULL,    -- 请求选中 skill 名的 JSON 数组（如 '["jira-ticket-review"]'）
  mode          TEXT NOT NULL,    -- 'channel' | 'fresh'
  ok            INTEGER NOT NULL, -- 1 = 调用成功；0 = 失败（error 记首段错误码）
  error         TEXT,             -- 失败错误码首段：input_too_large / model_not_allowed / skill_not_allowed
                                  --   / skill_missing / agent_failed / agent_empty_output；ok=1 时 NULL。
                                  --   quota_exceeded / model_not_configured 在 dispatch 层拦截、未消耗 LLM，不落行（决策 3）
  duration_ms   INTEGER NOT NULL, -- op 墙钟耗时
  input_tokens  INTEGER,          -- 以下 6 个用量字段：usage 缺失时整组 NULL
  output_tokens INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  total_tokens  INTEGER,
  cost_total    REAL              -- pi 上报 usage.cost.total（USD）；模型无价表时为 0
);
CREATE INDEX idx_llm_calls_biz_ts ON llm_calls (business_id, ts);
CREATE INDEX idx_llm_calls_run ON llm_calls (run_id);
```

### 4.2 `run_metrics` 表（二期；迁移 module `'runtime'` v4）

```sql
CREATE TABLE run_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,     -- 归属 run
  business_id TEXT NOT NULL,
  ts          TEXT NOT NULL,     -- run 终态时刻（UTC ISO；按日聚合口径与 llm_calls 一致）
  key         TEXT NOT NULL,     -- 指标名（业务自定义，[a-z][a-z0-9_]*）
  value_text  TEXT,              -- 字符串值（原样）
  value_num   REAL               -- 数值值；字符串值时 NULL
);
CREATE INDEX idx_run_metrics_biz_ts ON run_metrics (business_id, ts);
```

### 4.3 统计长表行（API 返回元素）

```ts
/** 统计长表行：控制台透视成二维表（行=date，列=metric/bucket） */
interface StatsRow {
  date: string; // 日历日 YYYY-MM-DD（服务器本地时区，决策 6）
  metric: string; // 指标名，族前缀 run.* / llm.* / biz.*（清单见 §4.4、§4.5）
  bucket: string; // 维度桶；无维度指标恒 ""（如 run.failed_phase 的桶 = 阶段名）
  value: number; // 指标值（计数/求和/平均/比率，由各指标定义）
}
```

### 4.4 一期指标清单（平台指标，metric 名即契约）

| metric | bucket | value 含义 | 数据来源 |
|---|---|---|---|
| `run.total` | "" | run 总数（含 running 残留） | lifecycles |
| `run.success` / `run.failed` / `run.timeout` | "" | 终态计数 | lifecycles |
| `run.running` | "" | 按 created_at 分日、查询时点仍 running 的计数（正常应为 0，非 0 = crash 残留信号） | lifecycles |
| `run.failed_phase` | `check-input` / `main` / `check-output` / `unknown` | 失败阶段分布（failed_at NULL 归 unknown） | lifecycles |
| `run.avg_duration_ms` | "" | 已完结 run（success/failed/timeout 全含）的平均耗时（finished_at - created_at） | lifecycles |
| `llm.calls` | "" | agent op 次数（含失败） | llm_calls |
| `llm.errors` | 错误码首段（如 `agent_failed`） | 失败计数按错误分桶 | llm_calls |
| `llm.tokens.input` / `llm.tokens.output` / `llm.tokens.cache_read` / `llm.tokens.cache_write` / `llm.tokens.total` | "" | token 求和（usage 缺失行不计入） | llm_calls |
| `llm.cost` | "" | cost_total 求和（USD，best-effort，决策 4） | llm_calls |
| `llm.avg_duration_ms` | "" | op 平均耗时 | llm_calls |
| `llm.calls_without_usage` | "" | usage 缺失行计数（数据质量指标） | llm_calls |

按日归属：run 指标按 `created_at` 分日；llm 指标按 `ts`（调用结束时刻）分日。跨日 run 的 LLM 消耗落在调用发生日，与 run 指标日期可能不同——语义正确，不强行对齐。

### 4.5 二期指标清单（业务指标族 `biz.*`）

| metric | bucket | value 含义 |
|---|---|---|
| `biz.<key>` | 字符串值原样 | 该值出现次数（字符串型指标按值计数） |
| `biz.<key>.sum` / `biz.<key>.avg` / `biz.<key>.count` | "" | 数值型指标的求和/平均/个数 |

基数护栏：单业务单日单指标 distinct bucket 超过 20 时，超出部分并入 `__other__` 桶（防业务放飞维度炸表）。

## 5. 采集点改造

### 5.1 agent-service：usage 落库（一期）

- `AgentServiceDeps` 新增可选成员：

```ts
/** LLM 调用统计写口（装配根注入；缺省 = 不采集）。
 *  实现纪律：写失败必须自行消化（warn 日志），不得抛回——agent op 不因统计失败 */
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

- `runAgentOp` 在 `done()` 处调用 sink（成功带 usage，失败无 usage；`error` 取 `resp.error.split(":")[0]`，与日志埋点同规则）。sink 自身异常由实现消化（决策 2），调用点不 try/catch。
- `business_id` 来源：`parseChannelId(ctx.channel_id)`（`packages/contracts/src/channel-id.ts`，返回 union——判 `kind === "business"` 取 `businessId`；出口通道到不了 agent op，解析失败或非 business 兜底记 `""` 并 warn）。
- usage 映射：pi `Usage` → sink 字段一对一（`cacheRead → cache_read_tokens` 等；`reasoning`/`cacheWrite1h` 不采，v1 无消费场景）。
- bootstrap 装配：`createLlmCallStore(db)`（runtime 包新实现）注入 `createAgentService`；本地运行 CLI 不注入。

### 5.2 runtime：`createLlmCallStore`（一期）

`packages/runtime/src/llm-call-store.ts`：实现 `LlmCallSink`（结构兼容，agent-service 自定义不 import 本包），`record` 内部 try/catch 消化异常并 warn；建表走 `migrateRuntimeSchema` 追加 v3（§4.1 DDL）。

### 5.3 workflow-runner：metrics 剥离（二期）

- `RunOutcome` 新增 `metrics?: Record<string, string | number>`。
- **剥离点 = check-output 阶段之后、`return mainOutcome` 之前**（runner.ts:519 附近）。不能放在共享的 `outcomeFromFirst` 里：check-output 的注入信封携带 `output: mainOutcome.output`，先剥离会让 check-output 看不到 metrics，§8 的业务校验责任就落空了。
- 剥离规则：`mainOutcome.output` 为 plain object 且含 `metrics` 键时——
  - 形状合法（扁平、键合规、值 string|number，上限 50 键）→ 提取进 `outcome.metrics`，`output` 删除该键；
  - 形状非法 → 丢弃并 bizSink warn（`metrics 形状非法，已丢弃`），run 成败不受影响。
- check 阶段自身的产出不做提取——只有 main 产出有 metrics 语义。

### 5.4 lifecycle：run_metrics 落库（二期）

`executeRun` 返回后、`markTerminal` 同时：`outcome.metrics` 非空 → 逐键写 run_metrics（`ts` = markTerminal 同一时刻；string → value_text，number → value_num）。写失败 fail-open warn。scheduler 侧 `ExecutionResult` 不变（metrics 不进出队列）。

## 6. 统计 API（一期）

console-api 新增 `routes-stats.ts`（模式照抄 routes-monitoring，登录即可、只读）：

```
GET /api/stats/daily?business_id=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
```

- 参数：`business_id` 必填（不存在 → 404 `not_found`）；`from`/`to` 可选，缺省 `to` = 今天、`from` = 13 天前（共 14 天）；`from > to` 或日期形非法 → 400 `invalid_input`；区间上限 92 天（防全表扫）。
- 响应：

```ts
{
  business_id: string;
  from: string; to: string;   // 生效区间（回显）
  rows: StatsRow[];           // §4.3，按 (date, metric, bucket) 排序
}
```

- 实现：lifecycles 与 llm_calls 两组聚合 SQL（`date(ts,'localtime')` 分日、按分日结果过滤区间；已核实 node:sqlite 支持带 `Z` 的 ISO 时间戳与 `'localtime'` 修饰符），在路由内合并为统一长表；聚合查询封装在 runtime 包的 store 上（`LifecycleStore` / `LlmCallStore` 各自加聚合读口），console-api 不裸写 SQL。
- 路由 deps：`LifecycleStore`、`LlmCallStore`、业务存在性校验口（registry `getProfile`；business_id 不存在 → 404）。server.ts 装配时注入。
- 零数据日不出行（控制台渲染时自行补零行）。

## 7. 控制台页面（一期）

`app/console` 新增「统计」页（`/stats`，导航进 AppLayout）：

- 顶栏：业务下拉（复用 businesses 列表接口）+ 日期范围（默认近 14 天）；
- 主体：二维表——行 = 日期（倒序），列分组 = 运行（total/success/failed/timeout/失败阶段/平均耗时）、大模型（调用次/输入 token/输出 token/缓存 token/成本/平均耗时/无 usage 次）；
- 前端只做透视与格式化（长表 → 二维表、千分位、耗时 ms→s），不发明指标；
- 二期追加「业务指标」列分组，数据驱动自动出现，不改 API。

## 8. 业务包约束：metrics 产出规则（二期）

业务包要暴露语义统计，只需：

1. main 输出 JSON 增加 `metrics` 成员，例 jira-ticket-review：
   ```json
   { "content": "...", "mentions": ["ZuoYu"],
     "metrics": { "decision": "pass", "classification": "contact-group", "skill_version": "1.5.0" } }
   ```
2. 键规则：`[a-z][a-z0-9_]*`，单 run 上限 50 键；值仅 string（≤ 200 字符）| number（有限数）。
3. contract.json 可选新增顶层 `metrics` 节声明字段（`{ fields: [{ key, type: "string"|"number", required, desc }] }`）；sdk 的 `loadContract`/`checkFields` 扩展支持该节，供 check-output 校验（业务质量关口；平台 runner 侧只做防御式形状检查，见决策 7）。
4. 纪律：metrics 是**统计面**，不承载业务流程数据（流程数据仍走 output 本体进出口）；键名即控制台展示名，起名将就长期稳定（改名 = 新指标，历史断档）。

jira-ticket-review 改造（二期先行验证）：main 汇总 decision/classification/skill_version 进 metrics；check-output 加 metrics 校验；控制台应出现 `biz.decision` / `biz.classification` 分桶计数。

## 9. 验收标准

一期：

1. 真实 run 后 `llm_calls` 有行：字段齐全、token 与 pi 日志埋点一致；失败 op 有 ok=0 行。
2. sink 写失败（如 db 只读）不影响 agent 调用返回与 run 成败。
3. `GET /api/stats/daily`：参数校验（缺 business_id/日期形非法/区间超限）报错正确；返回行与手工 SQL 对 lifecycles/llm_calls 的聚合结果一致；`llm.calls` 与 audit jsonl 行数吻合（单 op 单请求场景）。
4. 控制台统计页：选业务 + 日期范围出二维表，数字与 API 返回一致。
5. 本地运行（local-runner）不产生 llm_calls 行（未注入 sink），run 行为不变。
6. 全仓测试、构建通过；新增单测覆盖：llm-call-store（写/聚合/失败消化）、runAgentOp sink 调用（有/无 usage/失败）、routes-stats（校验/聚合/空数据）、metrics 剥离（二期）。

二期：

7. jira-ticket-review 真实 run 后 run_metrics 有 decision/classification/skill_version 行；出口企微通知 payload 无 metrics 键（与改造前一致）。
8. metrics 形状非法的 run：run 成功、bizSink 有 warn、run_metrics 无行。
9. API 出现 `biz.decision` 分桶计数，与 run_metrics 手工核对一致；基数护栏生效（构造 21 个 distinct 值 → 出现 `__other__`）。

## 10. 假设与决策点

- 假设 1：成本展示接受 best-effort（pi 价表外的模型 cost=0，token 为权威）。若后续要求成本准确，再议平台单价表（那时是新增而非修改）。
- 假设 2：服务器本地时区即团队日历日口径（当前部署单机，成立）。
- 假设 3：`llm.running` 类 crash 残留信号先以 `run.running` 指标暴露，不做自动修复。
- 决策点 A（plan 阶段定）：llm_calls 的 `skills` 列是否进入统计维度（v1 只落库不出指标，留着将来按 skill 拆消耗）。
- 决策点 B（二期 plan 定）：sdk `checkMetrics` 是独立 helper 还是并入 `checkFields` 的节参数。
