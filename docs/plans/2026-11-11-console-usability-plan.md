# 控制台易用性优化批 实施计划（2026-11-11）

> 执行依据：`docs/specs/2026-11-11-console-usability-spec.md`（唯一事实源，自包含）。
> 执行方式：主/子代理模式；子代理不 commit、不 push，完成后由主代理统一验证。
> 纪律：触碰 spec 之外的契约变更必须停下来上报主代理，不得自行变更。

## T1 runtime 层：迁移 v5 + reason 落库 + 三个读口扩展

**范围**：`packages/runtime/`

1. `src/env-provider.ts`：`MIGRATIONS` 追加 v5 `ALTER TABLE lifecycles ADD COLUMN reason TEXT;`。
2. `src/lifecycle-store.ts`：
   - `LifecycleRecord` 加 `reason?: string`；
   - `LifecycleWriter.markTerminal` 加第 4 参 `reason?: string`；实现内截断 `MAX_REASON_LEN = 500`；
   - SELECT 列表加 `reason`，`rowToRecord` 映射 NULL → 缺省；
   - `LifecycleStore` 加 `listByBusinessOnDate(business_id, date)`（spec §4.4）。
3. `src/llm-call-store.ts`：加 `LlmCallEntry` 类型与 `listByRun(run_id)`（ts 升序，skills JSON 解析回数组，NULL → 缺省）。
4. `src/run-metrics-store.ts`：加 `RunMetricEntry` 类型与 `listByRun(run_id)`（key 升序，value_text/value_num 折叠）。
5. `src/lifecycle.ts`：三处 markTerminal 补传 reason（spec §4.3）。
6. `src/index.ts`：导出新类型。
7. 测试：`tests/` 对应文件补用例（spec §8 runtime 段）；`yarn workspace @asteriskzuo/agent-runtime test` 全绿。

**注意**：`failed_at` 字段名不动（它是失败阶段分类，改名是破坏性变更）；只新增 `reason`。

## T2 console-api 层：DTO + 路由 + 装配

**范围**：`packages/console-api/`、`app/server/src/bootstrap.ts`

前置：T1 完成（依赖新类型与读口）。

1. `src/dto.ts`：新增 `RunDetailResponse`、`RunLogResponse`；`LlmCallEntry` / `RunMetricEntry` 从 runtime re-export（`src/index.ts` 同步导出）。
2. 日历日校验抽共用：`routes-stats.ts` 的 `parseDateParam`/`DATE_PATTERN`/`utcDateString` 抽到独立模块（如 `src/date-param.ts`），routes-stats 改用之，行为不变。
3. `src/routes-monitoring.ts`：
   - `GET /api/businesses/:id/runs` 加可选 `date` 参数（spec §5.2）；
   - 新增 `GET /api/runs/:id/detail`（spec §5.3）；
   - 新增 `GET /api/runs/:id/log`（spec §5.4；两层目录扫描定位、尾部截断、bytes 参数、形状/路径安全校验）。
   - `monitoringRoutes` deps 相应扩展（`llmCalls?` / `runMetrics?` / `workspaceRoot?`）。
4. `src/server.ts`：`ConsoleApiOptions` 加 `workspace_root?: string`，路由接线。
5. `app/server/src/bootstrap.ts`：传 `workspace_root`（与 runner 同根，装配根已有此值，不新读环境变量）。
6. 测试：`tests/` 补用例（spec §8 console-api 段）；`yarn workspace @asteriskzuo/agent-console-api test` 全绿；app/server 测试绿。

## T3 console 前端：排序 + 列扩充 + 日期详情 + CSV

**范围**：`app/console/`

前置：T2 完成（依赖 console-api 新 DTO 类型）。

1. `src/pages/DashboardPage.tsx`：
   - 任务查询表：入队/完结时间列加客户端 sorter，入队时间 `defaultSortOrder: "descend"`（spec §6.1）；
   - 业务运行记录表：加事件 ID/耗时/失败阶段/失败原因四列 + 创建/完结时间 sorter（spec §6.2）；
   - 耗时/失败原因等渲染抽公共（供 StatsPage 复用，可放 `src/run-columns.tsx` 或 `stats.ts` 旁新模块）。
2. `src/pages/StatsPage.tsx`：
   - 日期详情下钻三步（spec §6.3）：日期可点 → 当日明细表（调 runs?date=）→ 行展开懒调 detail，展示失败原因/LLM 调用表/业务指标表/日志按钮 + 日志 Modal；
   - CSV 导出按钮 + 纯函数（转义/BOM/文件名，spec §6.4）；纯函数放 `src/stats.ts` 或新 `src/csv.ts`；
   - 错误明细空态文案（spec §6.5）。
3. 测试：`tests/` 保持绿；CSV 纯函数单测；日期详情最小交互用例。
4. `yarn workspace @asteriskzuo/agent-console test`、`yarn workspace @asteriskzuo/agent-console typecheck`、`yarn workspace @asteriskzuo/agent-console build` 全过。

## T4 收尾（主代理执行）

1. 全仓 `yarn build && yarn test` 绿。
2. 真实 platform.db 副本迁移冒烟：复制 `.easemob-agent-workspace/platform/data/platform.db` 到临时目录，打开触发迁移到 v5，查旧行 reason IS NULL、新列存在。
3. 更新 `docs/PROGRESS.md`（优化批 5 项标记落地 + 日期）、`dailylog/AsteriskZuo/2026-11-11.md` 追加。
4. 自审（对照 spec §9 验收清单），交付用户 dev 实测；提交待用户授权。

## 任务依赖关系

- T1 → T2 → T3 → T4（严格串行：T2 依赖 T1 的 runtime 类型/读口；T3 依赖 T2 的 DTO 类型包；T4 依赖全部完成）。
- T1/T2/T3 各自由一个子代理执行（k3-256k），主代理负责 T4 与集成验证。
