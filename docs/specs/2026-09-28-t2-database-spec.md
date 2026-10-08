# T2 database 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/core-modules.md` §4.7。

## 1. 目标

产出 `@asterisk/agent-database` 包：SQLite 薄封装 + 最小迁移原语，**全平台唯一数据访问口**。queue / registry / channel 等所有需要持久化的包都经它访问数据库，不允许任何包直接 `import 'node:sqlite'`。

## 2. 背景知识（执行所需的最小上下文）

- 平台是单进程模块化单体，SQLite 与之天然匹配：零运维、备份即文件拷贝。
- 驱动用 **Node 24 内置 `node:sqlite`**（`DatabaseSync`），零外部依赖（已定决策，禁止引入 better-sqlite3 等）。
- 薄封装的理由：消除"各模块各自写 SQL 连接/事务"的散点；未来若迁 PostgreSQL，只有本包的实现需要换。**刻意保持薄**——不做 ORM、不做连接池；版本管理只提供一个最小迁移原语（§5），不建迁移框架。
- 表结构不归本包管：各属主包以**版本化迁移列表**声明自己的 schema（纪律见 §5 末尾）。

## 3. 范围与不做清单

**本任务做**：`openDatabase` 工厂 + `Database` 接口（run/get/all/transaction/exec/close）+ **最小迁移原语 `migrate`**（版本管理见 §5）。

**本任务不做**：

- 任何业务表结构定义（归各属主包，以迁移列表形式声明）；
- down 迁移、迁移文件自动发现、ORM、查询构造器、连接池、异步 API（node:sqlite 是同步的，接口保持同步）；
- 日志、监控、备份逻辑。

## 4. 包结构

```text
packages/database/
├── package.json            # @asterisk/agent-database
├── tsconfig.json           # extends ../../tsconfig.base.json（同 contracts 模板）
├── src/
│   ├── index.ts            # 统一导出
│   └── database.ts
└── tests/
    └── database.test.ts
```

工程约定同 T0 spec §4（ESM、相对导入带 `.js` 后缀、包级脚本模板、devDependencies 自声明 typescript/esbuild/jest）。

## 5. 详细规格

```ts
export interface Database {
  /** 写（INSERT/UPDATE/DELETE/DDL 单语句） */
  run(sql: string, params?: unknown[]): void;
  /** 多语句执行（无参数），供迁移与建表用 */
  exec(sql: string): void;
  /** 读一行；无行返回 undefined */
  get<T>(sql: string, params?: unknown[]): T | undefined;
  /** 读多行 */
  all<T>(sql: string, params?: unknown[]): T[];
  /** 事务：BEGIN IMMEDIATE 包裹 fn；fn 抛错则 ROLLBACK 并把错误原样抛出 */
  transaction<T>(fn: () => T): T;
  /** 关闭连接（幂等） */
  close(): void;
}

/** 打开（不存在则创建）一个 SQLite 数据库文件；父目录自动创建 */
export function openDatabase(path: string): Database;

/** 最小迁移原语：按模块名管理版本化 schema 演进。
 *  migrations 是有序 SQL 列表，下标即版本号（migrations[0] = v1 以此类推）；
 *  已应用的版本跳过，未应用的按序在各自事务内执行并登记 */
export function migrate(
  db: Database,
  module: string,
  migrations: readonly string[],
): void;
```

实现要点：

1. 用 `node:sqlite` 的 `DatabaseSync`；`openDatabase` 时先 `mkdirSync(dirname(path), { recursive: true })`；
2. 打开后执行两个 PRAGMA：`journal_mode = WAL`（读写不互堵）、`busy_timeout = 5000`（锁等待兜底）；
3. `params` 直接透传给 `DatabaseSync` 的 prepare/run/get/all（其参数类型为 `SupportedValueType[]`，实现内部做类型适配，接口上保持 `unknown[]`）；
4. `transaction`：嵌套调用直接抛错（事务嵌套在本平台没有场景，fail-fast 暴露误用）；
5. **迁移机制**：`migrate` 首次调用时自建登记表 `schema_migrations(module TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY (module, version))`；查该模块已应用的最大版本，把其后的迁移按序各在一个事务内执行 + 登记。规则：**统一机制归本包，迁移内容归各属主包**——属主包维护自己的有序 SQL 列表（`migrations[0]` = 初始建表；以后加字段/加索引 = 在列表末尾追加一条 `ALTER TABLE ...`），只许追加、不许改动已发布的历史迁移；
6. `node:sqlite` 在 Node 24 可能打印 ExperimentalWarning，属正常，不处理。

**表结构纪律（使用方约定）**：各属主包**不裸跑 CREATE TABLE**，而是把自己的 schema 演进写成迁移列表，在工厂函数里调 `migrate(db, '<模块名>', MIGRATIONS)`。表名即归属（如 `entry_tasks`、`businesses`）。

## 6. 测试清单

`tests/database.test.ts`（用临时目录 `:memory:` 与临时文件两种方式）：

- run + get 往返：建表、插入、读回一致；
- all 读多行；get 无行返回 `undefined`；
- exec 多语句一次执行成功；
- transaction 提交：fn 内多步写入，提交后可见；transaction 返回 fn 的返回值；
- transaction 回滚：fn 抛错 → 数据不落库，错误原样抛出；
- 嵌套 transaction → 抛错；
- 持久化：写入 → close → 重新 openDatabase 同路径 → 数据仍在；
- openDatabase 父目录不存在时自动创建；
- close 幂等（连调两次不抛错）。

迁移（`migrate`）：

- 首次调用：全部迁移按序应用，schema_migrations 登记完整；
- 重复调用：幂等，已应用版本不重复执行；
- 增量：先在 v1 状态下 migrate，追加 v2 后再 migrate → 只应用 v2；
- 失败回滚：某条迁移 SQL 非法 → 抛错、该版本不登记、之前的版本保持已登记；
- 多模块隔离：模块 A、B 各自的迁移列表互不影响。

## 7. 验收标准

1. 包级与根级 `build` / `test` / `typecheck` / `lint` / `format:check` / `circular` 全绿；
2. 运行时依赖为零（只 import `node:sqlite`、`node:fs`、`node:path`）；
3. 导出签名与本文 §5 一致。
