# T13 管理 API（console-api）任务规格

> 日期：2026-10-05
> 状态：待评审
> 任务：T13（依赖 T12；被 T14 console SPA 依赖）
> 本规格自包含：执行者只读本规格与总计划（`docs/plans/2026-09-28-platform-implementation-plan.md`），不读原始设计文档。

---

## 1. 目标

实现平台管理 API：控制台（T14 浏览器 SPA）与平台服务之间的唯一交互口。产出：

1. 新包 `packages/console-api`（`@asterisk/agent-console-api`）：HTTP 服务 + 账号体系 + 全部管理路由，零第三方运行时依赖（node:http 自制轻量路由）；
2. `app/server` 装配扩展：配置新增管理 API 端口，bootstrap 启动/停止管理 API 服务；
3. `packages/asset-registry` 增补 `remove` 方法（下架，见 §5.6——**契约增补，本规格是其唯一依据**）。

管理 API 是平台全部控制开关的读写口：账号、业务配置、资产登记、环境配置（两桶）、出口工具菜单、运行监控（只读）。设计依据：`design/console-design.md` §4/§12、`design/accounts.md`、`design/config-contracts.md`。

## 2. 背景（上游真实签名，已与源码核对）

### 2.1 装配层（app/server，T12 已实现）

`app/server/src/bootstrap.ts` 导出（真实签名）：

```ts
export interface AssembledContext {
  config: ServerConfig;
  db: Database;
  entryQueue: TaskQueue;
  exitQueue: TaskQueue;
  registry: BusinessRegistry;
  env: EnvProvider;
  assets: AssetRegistry;
  entryLoop: SchedulerLoop;
  exitLoop: SchedulerLoop;
}
export interface ServerHandle {
  context: AssembledContext;
  stop(): Promise<void>; // 优雅停：适配器 → 两循环 → db close；幂等
}
export async function bootstrap(overrides?: {
  env?: Record<string, string | undefined>;
  adapters?: EntryAdapter[];
}): Promise<ServerHandle>;
```

`app/server/src/config.ts` 的 `ServerConfig` 现有字段：workspace / log_level / log_enabled / hop_limit / task_concurrency / result_concurrency / task_timeout_minutes / max_agent_calls / pi_cli_path / pi_agent_dir / pi_env。解析规则：环境变量 > `{workspace}/config.json` 同名键 > 代码默认；逐键解析器 `KeyResolver` 已有 `string/number/boolean` 三方法。**本任务在其中追加 `console_port`（见 §5.8），沿用同一 KeyResolver 模式，不改既有字段。**

bootstrap 内部还创建了但未放进 AssembledContext 的实例，本任务需要其中两个（见 §5.8）：
- `createExitRegistry()`（exit-tools，出口工具菜单）；
- `createLifecycleStore(db)`（runtime，任务监控读口——同 module schema 幂等，再建一个实例即可，与 Lifecycle 内部实例共用同一张表）。

### 2.2 registry（@asterisk/agent-registry，真实签名）

```ts
export interface BusinessMatch {
  business_id: string;
  business_name: string;
  creator_id: string;
  source: EventSource;
  event_type: string;
  on_failure?: boolean;
  entry_config?: Record<string, unknown>;
}
export interface BusinessProfile {
  business_id: string; business_name: string; creator_id: string;
  on_failure: boolean; prompt: string; model: string; agent_kind: string;
  package_asset_id?: string; entry_program?: string;
  tool_asset_ids: string[]; skill_asset_ids: string[];
  timeout_minutes?: number; max_agent_calls?: number;
}
export interface ExitBinding {
  business_id: string; tool: string; config: Record<string, string>;
}
export interface BusinessPatch {
  business_name?: string; on_failure?: boolean;
  exit_bindings?: ExitBinding[]; // 全量替换
  prompt?: string; model?: string; agent_kind?: string;
  package_asset_id?: string; entry_program?: string;
  tool_asset_ids?: string[]; skill_asset_ids?: string[]; // 全量替换
  timeout_minutes?: number | null; // null = 清除覆盖
  max_agent_calls?: number | null;
}
export interface CreateBusinessInput {
  business_name: string; creator_id: string;
  source: EventSource; event_type: string; // 首个匹配行
  on_failure?: boolean;
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>;
  prompt?: string; model?: string; agent_kind?: string;
  package_asset_id?: string; entry_program?: string;
  tool_asset_ids?: string[]; skill_asset_ids?: string[];
  timeout_minutes?: number; max_agent_calls?: number;
}
export interface BusinessRegistry {
  match(source: EventSource, event_type: string): BusinessMatch[];
  exitBindings(business_id: string): ExitBinding[];
  get(business_id: string): BusinessMatch[]; // 全部匹配行；不存在返回 []
  getProfile(business_id: string): BusinessProfile | undefined;
  update(business_id: string, patch: BusinessPatch): void; // 不存在抛错
  create(input: CreateBusinessInput): string; // 返回 business_id
  addMatch(business_id, source, event_type, entry_config?): void; // 重复幂等
  removeMatch(business_id, source, event_type): void;
  remove(business_id: string): void; // 不存在幂等
}
```

`EventSource = "wecom" | "jira" | "github" | "webhook" | "cron" | "internal" | "manual"`（@asterisk/agent-contracts）。

### 2.3 asset-registry（@asterisk/agent-asset-registry，真实签名）

```ts
export type AssetKind = "package" | "tool" | "skill";
export interface AssetInput {
  kind: AssetKind; url: string; ref: string; subpath?: string;
  shared?: boolean; // 仅 tool/skill 有意义；package 传 true → invalid_input
  owner_id: string;
  is_private?: boolean; credential_key?: string; // is_private 时必填
}
export interface AssetMeta {
  asset_id: string; kind: AssetKind; owner_id: string;
  shared: boolean; is_private: boolean; credential_key?: string;
  created_at: string; modified_at: string;
}
export type AssetManifest =
  | { kind: "package"; name: string; version?: string;
      programs: Record<string, string>;
      requires: { tools: string[]; skills: string[] } }
  | { kind: "tool"; name: string; version?: string;
      programs: Record<string, string> }
  | { kind: "skill"; skills: string[] };
export interface AssetObject { meta: AssetMeta; manifest: AssetManifest; }
export interface AssetRegistry {
  register(input: AssetInput, opts?: { credential?: string }): AssetMeta; // 需 git ls-remote
  list(filter: { kind?: AssetKind; owner_id?: string; shared?: boolean }): AssetMeta[];
  get(asset_id: string, opts?: { credential?: string }): AssetObject; // 未登记抛 asset_not_found
  materialize(asset_id: string, opts?: { credential?: string }): string;
}
```

**本任务给该接口增补 `remove`（§5.6）。**

### 2.4 runtime（@asterisk/agent-runtime，真实签名）

```ts
export interface EnvConfig {
  vars: Record<string, string>; secrets: Record<string, string>;
}
export interface EnvProvider {
  getFor(business_id: string): EnvConfig; // 通用层(scope='') + 业务层合并，业务优先
  set(business_id: string | null, bucket: "vars" | "secrets", key: string, value: string): void;
  remove(business_id: string | null, bucket: "vars" | "secrets", key: string): void;
  list(business_id: string | null): { vars: Record<string, string>; secret_keys: string[] };
}
export type LifecycleStatus = "created" | "running" | "success" | "failed" | "timeout";
export interface LifecycleRecord {
  lifecycle_id: string; business_id: string; event_id: string; channel_id: string;
  status: LifecycleStatus; created_at: string; finished_at?: string;
}
export interface LifecycleStore {
  listByBusiness(business_id: string, limit?: number): LifecycleRecord[]; // limit 缺省 50
  get(lifecycle_id: string): LifecycleRecord | undefined;
}
export function createLifecycleStore(db: Database): LifecycleStore & LifecycleWriter;
```

`EnvProvider.getFor("")` 传空串时 `scope IN ('', '')` 等价于只取通用层——**这是读取通用层 secrets 值的唯一现有通道**（list 不给 secrets 值），本任务用它解析私有资产的凭据（§5.5）。

### 2.5 queue（@asterisk/agent-queue，真实签名）

```ts
export type TaskStatus = "pending" | "processing" | "done" | "dead";
export interface Task {
  task_id: string; event: EventEnvelope; status: TaskStatus;
  enqueued_at: string; finished_at?: string;
}
export interface TaskFilter { status?: TaskStatus; event_id?: string; correlation_id?: string; }
export interface TaskQueue {
  enqueue(event: EventEnvelope): Task; take(): Task | null;
  complete(task_id: string): void; deadLetter(task_id: string, reason: string): void;
  query(filter: TaskFilter): Task[]; recover(): number; purge(cutoffIso: string): number;
}
```

### 2.6 exit-tools（@asterisk/agent-exit-tools，真实签名）

```ts
export interface ConfigField {
  key: string; label: string; required?: boolean; secret?: boolean; placeholder?: string;
}
export interface ExitTool {
  readonly kind: string; readonly name: string; readonly implemented: boolean;
  readonly configSchema: ConfigField[];
  destinationOf(config: Record<string, string>): string;
  bind(config: Record<string, string>): Exit;
}
export interface ExitRegistry { get(kind: string): ExitTool; list(): ExitTool[]; }
export function createExitRegistry(): ExitRegistry;
```

### 2.7 database / contracts / logger / env

- `Database`：`run/get/all/exec/transaction/close`；`migrate(db, module, migrations)` 版本化迁移（下标即版本号）。
- contracts：`newUlid()` 生成 ULID。
- logger：全局外观 `logger.for({ module })` → `{ debug/info/warn/error(message, fields?) }`；敏感值脱敏内建于 logger。
- console-api 包**不读 process.env**（端口等由 app/server 配置解析后注入）。

## 3. 不做清单

- **ConfigStore（全局设置库内可写）不做**：`design/config-contracts.md` 的键注册表 + 运行中重载是独立设计量（循环以 PlatformConfig 构造期注入，热改要动调度器）。本期只提供 `GET /api/config` 只读回显生效中的 ServerConfig；改全局参数 = 改环境变量/config.json 后重启。后续单独立项。
- **任务干预（终止/重试）不做**：终止需要 workflow-runner 支持 kill 子进程、重试需要重入队语义，均涉现有包契约，后续单独立项。本期监控全部只读。
- **身份目录**（jira↔github↔邮箱↔企微映射）：设计文档明确「实现归后续任务」，不做。
- **统计搜索页 / 日志检索 / 结果统计**：console-design §12 标注「后续增加」，不做。
- **CORS 中间件不做**：T14 console 开发期用 Vite dev proxy，生产部署同源；API 不感知跨域。
- **console 静态资源托管不做**：T14 自行决定部署形态。
- **滑动续期、找回密码、SSO、审计表**：accounts.md §6 明确不做。
- **webhook 等业务入口**：归 T18，与本任务无关。

## 4. 包结构

```
packages/console-api/
├── package.json            # @asterisk/agent-console-api，type: module
├── tsconfig.json           # 继承根 tsconfig（TS ^5.9，ESM NodeNext）
├── src/
│   ├── index.ts            # 公共出口：createConsoleApi + DTO 类型（console 复用）
│   ├── dto.ts              # API 请求/响应类型（零运行时内容，纯 type）
│   ├── errors.ts           # ApiError + 错误码 → HTTP 状态映射
│   ├── http.ts             # node:http 请求解析（JSON body 上限 1MB / cookie / query）与响应辅助
│   ├── router.ts           # 轻量路由表：method + 路径模板（/api/businesses/:id）
│   ├── accounts.ts         # AccountService：users/console_sessions 迁移、scrypt、会话
│   ├── routes-auth.ts      # 登录/登出/me/改密码
│   ├── routes-users.ts     # 用户管理（admin）
│   ├── routes-businesses.ts# 业务 CRUD + 匹配行增删
│   ├── routes-assets.ts    # 资产登记/列表/详情/下架
│   ├── routes-env.ts       # 环境配置两桶（global/business）
│   ├── routes-config.ts    # 生效配置只读回显 + 出口工具菜单
│   ├── routes-monitoring.ts# 队列计数 / 任务查询 / 业务运行记录
│   └── server.ts           # createConsoleApi：装配路由、认证拦截、启动/停止
└── tests/
    ├── helpers.ts          # 起真实 HTTP 服务（listen 端口 0）+ fetch 封装 + 临时 workspace
    ├── accounts.test.ts
    ├── auth-routes.test.ts
    ├── users-routes.test.ts
    ├── businesses-routes.test.ts
    ├── assets-routes.test.ts
    ├── env-routes.test.ts
    ├── monitoring-routes.test.ts
    └── http.test.ts        # body 上限、非法 JSON、错误格式
```

依赖（package.json dependencies）：`@asterisk/agent-contracts`、`@asterisk/agent-database`、`@asterisk/agent-registry`、`@asterisk/agent-asset-registry`、`@asterisk/agent-runtime`、`@asterisk/agent-queue`、`@asterisk/agent-exit-tools`、`@asterisk/agent-logger`。全部 workspace:*。**不依赖** env/scheduler/agent-service 等。

`app/server` 追加依赖 `@asterisk/agent-console-api`。

## 5. 详规

### 5.1 账号服务（accounts.ts）

设计依据 `design/accounts.md` 全量落地：两角色（admin/member）、不开放注册、停用代替删除、SYSTEM 伪用户不在本包出现。

**数据表**（迁移 module 名 `"console-api"`，经 `migrate()`）：

```sql
-- v1
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,        -- 'usr_' + ULID
  username TEXT NOT NULL UNIQUE,   -- 登录名，创建后不可改
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'admin' | 'member'
  password_hash TEXT NOT NULL,     -- scrypt 自包含串，见下
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE console_sessions (
  token TEXT PRIMARY KEY,          -- 32 字节随机 hex（node:crypto randomBytes）
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL         -- ISO；固定 7 天，不滑动续期
);
```

**密码散列**：`node:crypto` 的 `scryptSync`（零依赖）。存储格式自包含：`scrypt$N$r$p$saltHex$hashHex`，N=16384、r=8、p=1、salt 16 字节随机、keylen 64。校验用 `timingSafeEqual`。

**接口**：

```ts
export type Role = "admin" | "member";

/** 用户读面（password_hash 永不出接口） */
export interface User {
  user_id: string;      // 'usr_' 前缀
  username: string;     // 登录名，唯一，创建后不可改
  display_name: string; // 展示名，可改
  role: Role;
  disabled: boolean;    // 停用不删行（历史业务 creator_id 仍指向它）
  created_at: string;   // ISO
}

export interface AccountService {
  /** 登录：成功返回会话（token + expires_at），失败返回 null
   * （不区分"用户不存在/密码错/已停用"，防枚举） */
  login(username: string, password: string): { token: string; expires_at: string } | null;

  /** 每个请求经此识别操作者；token 无效/过期/用户已停用返回 undefined */
  resolve(token: string): User | undefined;

  /** 登出：删除会话；不存在幂等 */
  logout(token: string): void;

  /** 仅 admin：创建账号。username 重复抛 conflict */
  createUser(
    actor: User,
    input: { username: string; display_name: string; password: string; role: Role },
  ): User;

  /** 仅 admin：列出全部用户 */
  listUsers(actor: User): User[];

  /** 仅 admin：停用/启用。不能停用自己（防自锁），试图停用最后一个启用中的 admin 抛错 */
  setDisabled(actor: User, user_id: string, disabled: boolean): void;

  /** 本人改密码（验旧密码，失败抛 invalid_input）；成功后该用户其它会话全部失效 */
  changePassword(actor: User, old_password: string, new_password: string): void;

  /** 首启注入首个 admin：users 表为空且入参给了账号密码 → 创建并返回 'created'；
   *  表非空 → 'skipped'；表空但无入参 → 'missing'（调用方记 error 日志，不阻断启动） */
  ensureBootstrapAdmin(input?: { username: string; password: string }):
    "created" | "skipped" | "missing";
}

export function createAccountService(db: Database): AccountService;
```

纪律：登录成功/失败、建号、停用、改密码打 info 日志（`logger.for({ module: "console-api" })`）；密码、hash、token 值永不进日志（logger 脱敏是兜底，本包不主动传）。

### 5.2 HTTP 基础（http.ts / router.ts / errors.ts）

- `node:http` 原生服务；请求体 JSON 解析上限 **1MB**，超限 413；非法 JSON 400；
- 路由表：`{ method, pattern: '/api/businesses/:id', handler }`，启动时编译成正则；`:param` 单段匹配；
- 统一响应：成功直接是 DTO JSON（200；登录/创建 201；DELETE 成功 204 无体）；错误统一：

```json
{ "error": { "code": "invalid_input", "message": "……" } }
```

错误码 → 状态码映射（`ApiError extends Error { code }`）：

| code | HTTP | 场景 |
|------|------|------|
| `invalid_input` | 400 | 入参缺失/类型错/校验不过（含下游 invalid_input、enqueue 校验等） |
| `unauthenticated` | 401 | 未登录/token 无效/过期/已停用 |
| `forbidden` | 403 | 已登录但无权（角色不符/非业务创建者） |
| `not_found` | 404 | 资源不存在（业务/资产/用户/run） |
| `conflict` | 409 | username 重复等唯一性冲突 |
| `internal` | 500 | 未捕获异常（记 error 日志，message 不外泄细节，统一「内部错误」） |

下游错误翻译：registry `业务不存在` → not_found；asset-registry `asset_not_found` → not_found、`invalid_input:` 前缀 → invalid_input、`credential_required` → invalid_input（提示凭据 key 未配置）；其余未识别 → internal。

- 认证拦截：除 `POST /api/auth/login` 外全部路由先经 cookie `agent_console_token` → `AccountService.resolve`，失败 401；
- `Set-Cookie: agent_console_token=<token>; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`（7 天；不做 Secure 标记——部署层自行决定 HTTPS 终结，记入 README 注释）；
- 所有写路由 handler 打 info 日志（操作者 user_id + 动作 + 目标 id）；body 整体不进日志。

### 5.3 路由：认证与用户（routes-auth.ts / routes-users.ts）

| 方法 路径 | 角色 | 说明 |
|-----------|------|------|
| POST `/api/auth/login` | 公开 | body `{username, password}`；成功 201 `{user: User, expires_at}` + Set-Cookie；失败 401（统一「用户名或密码错误」） |
| POST `/api/auth/logout` | 登录 | 删会话 + 清 cookie；204 |
| GET `/api/auth/me` | 登录 | 当前 `User` |
| POST `/api/auth/change-password` | 登录（本人） | body `{old_password, new_password}`；204 |
| GET `/api/users` | admin | `User[]` |
| POST `/api/users` | admin | body `{username, display_name, password, role}`；201 `User` |
| POST `/api/users/:id/disabled` | admin | body `{disabled: boolean}`；204 |

### 5.4 路由：业务（routes-businesses.ts）

权限：读不设限（所有登录用户）；写 = 该业务 creator_id === actor.user_id 或 admin。创建时 `creator_id = actor.user_id`。

| 方法 路径 | 说明 |
|-----------|------|
| GET `/api/businesses` | 全部业务的 `BusinessProfile[]`（列表 = 注册表视图）。实现：registry 无 listAll——**本任务给 BusinessRegistry 增补 `list(): BusinessProfile[]`**（见 §5.7） |
| POST `/api/businesses` | body 见 DTO；API 层只强校验 `business_name` 非空、`source` 是合法 EventSource、`event_type` 非空（其余按 registry 缺省；「包绑定/总纲必填」是 console UI 的表单职责，不在 API 强制）；201 返回 `BusinessProfile` |
| GET `/api/businesses/:id` | `BusinessDetail = { profile: BusinessProfile; matches: BusinessMatch[]; exit_bindings: ExitBinding[] }` |
| PATCH `/api/businesses/:id` | body = `BusinessPatch` 同形（API 层校验字段白名单，未知字段拒绝 invalid_input）；204 |
| DELETE `/api/businesses/:id` | 删业务（匹配行、出口绑定一并删）；204 |
| POST `/api/businesses/:id/matches` | body `{source, event_type, entry_config?}`；201 |
| DELETE `/api/businesses/:id/matches` | body `{source, event_type}`（ query 不便带 body，用 body 传）；204 |

### 5.5 路由：资产（routes-assets.ts）

权限：读 = 登录用户；列表过滤——member 看「自己的 + 共享的」，admin 看全部（admin 只读）。写（登记/下架）= **仅 member**（admin 不持有资产，`design/accounts.md` §1 权限表）；下架仅限属主本人。

| 方法 路径 | 说明 |
|-----------|------|
| GET `/api/assets?kind=&scope=mine\|shared\|all` | `AssetMeta[]`；scope 缺省：member = mine+shared 两个查询合并，admin = all |
| POST `/api/assets` | body `{kind, url, ref, subpath?, shared?, is_private?, credential_key?}`；`owner_id = actor.user_id`；私有资产凭据解析见下；201 `AssetMeta` |
| GET `/api/assets/:id` | `AssetObject`（meta + manifest）；**会触发物化（首次可能 git clone，慢）**——路由不另设超时，由 node:http 默认行为承载 |
| DELETE `/api/assets/:id` | 下架：仅属主本人；删登记行 + 清物化缓存（§5.6）；204 |

**私有资产凭据解析**：`is_private` 资产的 register/get 需要 `opts.credential` 值。本任务约定：**凭据值从通用层安全桶解析**——`env.getFor("").secrets[credential_key]`（getFor 空串 = 只取通用层，见 §2.4）。取不到 → invalid_input（提示先在通用配置登记该 credential_key）。此约定写入 DTO 注释。

### 5.6 asset-registry 增补：remove（契约增补）

```ts
export interface AssetRegistry {
  // ……既有四方法不变……

  /** 下架：删登记行 + 清物化缓存目录；不存在幂等不报错。
   *  不校验在役引用——业务绑定着已下架资产时，运行时取用在 ContextLoader 处抛 asset_not_found，
   *  属配置错误，由控制台操作者负责（console UI 可在删除前提示在役业务，非本包职责） */
  remove(asset_id: string): void;
}
```

实现：`DELETE FROM assets WHERE asset_id = ?` + `rmSync(path.join(cacheRoot, asset_id), { recursive: true, force: true })`。asset-registry 现有测试照常全绿；新增 remove 用例（存在删除 + 缓存清理、不存在幂等、删后可重新登记同三元组得到同 asset_id）。

### 5.7 registry 增补：list（契约增补）

```ts
export interface BusinessRegistry {
  // ……既有方法不变……

  /** 全部业务资料（控制台业务列表）；按 business_id 字典序 */
  list(): BusinessProfile[];
}
```

实现：内存视图 businesses Map 逐条走 getProfile 同路径组装。新增用例（空表、多业务、创建/删除后反映）。

### 5.8 路由：环境配置（routes-env.ts）与配置回显/工具菜单（routes-config.ts）

环境配置两桶（普通/安全），scope 二选一：通用层 / 业务层。

| 方法 路径 | 角色 | 说明 |
|-----------|------|------|
| GET `/api/env/global` | 登录可读 | `{ vars: Record<string,string>, secret_keys: string[] }`（secrets 只回键名，掩码回显归 console 渲染） |
| PUT `/api/env/global` | admin | body `{bucket: "vars"\|"secrets", key, value}`；204 |
| DELETE `/api/env/global` | admin | body `{bucket, key}`；204 |
| GET `/api/env/businesses/:id` | 登录可读 | 同上 |
| PUT `/api/env/businesses/:id` | creator 或 admin | 同上 |
| DELETE `/api/env/businesses/:id` | creator 或 admin | 同上 |

配置回显与出口工具菜单：

| 方法 路径 | 角色 | 说明 |
|-----------|------|------|
| GET `/api/config` | 登录可读 | 生效中的平台配置（ServerConfig 去敏感后回显：workspace/log_level/log_enabled/hop_limit/task_concurrency/result_concurrency/task_timeout_minutes/max_agent_calls；**不含** pi_env；pi_cli_path/pi_agent_dir 原样——非机密）。只读；改配置 = 改 env/config.json 重启（DTO 注释写明） |
| GET `/api/exit-tools` | 登录可读 | 出口工具菜单：`Array<{ kind, name, implemented, configSchema: ConfigField[] }>`（`createExitRegistry().list()` 原样映射；secret 字段声明照传，console 据此把 secret 项写安全桶、非 secret 项进 ExitBinding.config） |

### 5.9 路由：监控（routes-monitoring.ts，全部只读）

| 方法 路径 | 说明 |
|-----------|------|
| GET `/api/monitor/queues` | 两队列状态计数：`{ entry: {pending,processing,done,dead}, exit: {...} }`。实现：`queue.query({status})` 逐状态聚合（queue 无 count 口，v1 全量拉取计数——任务行量大时的优化归后续，不提前做） |
| GET `/api/monitor/tasks?queue=entry\|exit&status=&event_id=&correlation_id=` | `Task[]`（含 event 信封原样）。`queue` 参数必填，非法 400 |
| GET `/api/businesses/:id/runs?limit=` | `LifecycleRecord[]`（`lifecycle.listByBusiness`，limit 缺省 50、上限 500） |
| GET `/api/runs/:id` | `LifecycleRecord`；不存在 404 |

### 5.10 createConsoleApi 与 app/server 装配

```ts
/** console-api 对外唯一工厂。deps 全部来自装配层（app/server bootstrap） */
export interface ConsoleApiDeps {
  db: Database;
  registry: BusinessRegistry;
  assets: AssetRegistry;
  env: EnvProvider;
  exits: ExitRegistry;        // 出口工具菜单
  entryQueue: TaskQueue;
  exitQueue: TaskQueue;
  lifecycle: LifecycleStore;  // 运行记录读口
  config: ServerConfig;       // GET /api/config 回显源（type 从 app/server 导入？否——见下）
}
```

`ServerConfig` 是 app/server 的类型，console-api 不能反向依赖 app。处理：console-api 定义自己的回显子集类型——

```ts
/** 回显给控制台的生效配置（ServerConfig 的非敏感子集，装配层负责映射） */
export interface EffectiveConfigView {
  workspace: string;
  log_level: string;
  log_enabled: boolean;
  hop_limit: number;
  task_concurrency: number;
  result_concurrency: number;
  task_timeout_minutes: number;
  max_agent_calls: number;
  pi_cli_path: string;
  pi_agent_dir: string;
}
```

`ConsoleApiDeps.config: EffectiveConfigView`。

```ts
export interface ConsoleApiOptions {
  port: number;                                  // 监听端口（0 = 随机，测试用）
  bootstrap_admin?: { username: string; password: string }; // 首启 admin 注入（accounts §4）
}
export interface ConsoleApi {
  /** 建表 → ensureBootstrapAdmin → 起 HTTP 监听；返回实际端口（port=0 时有用） */
  start(): Promise<number>;
  /** 关监听（幂等）；不 close db（db 归装配层管） */
  stop(): Promise<void>;
}
export function createConsoleApi(deps: ConsoleApiDeps, options: ConsoleApiOptions): ConsoleApi;
```

**app/server 改动**（`app/server/src/config.ts` / `bootstrap.ts` / `index.ts`）：

1. `ServerConfig` 追加两个字段 + 解析：
   - `console_port: number`：`AGENT_CONSOLE_PORT`，默认 **6100**，min 0（0 = 随机，测试用）；
   - `bootstrap_admin?: { username: string; password: string }`：`AGENT_ADMIN_USERNAME` / `AGENT_ADMIN_PASSWORD` 两个 string 键，**都缺省 = undefined（不建号），只给一个 = 配置错误（problems 收集）**；不进 config.json 之外的任何地方、不回显、不进日志。
2. bootstrap 第 7 步（启动循环）之后、第 9 步（启动完成日志）之前插入：
   - `const lifecycleStore = createLifecycleStore(db)`（同 module schema，幂等）；
   - `const exits = createExitRegistry()` 已有（exitDriver 用）——提为局部变量复用；
   - `const consoleApi = createConsoleApi({...}, { port: config.console_port, bootstrap_admin: config.bootstrap_admin })`；`const port = await consoleApi.start()`；
   - `ensureBootstrapAdmin` 返回 `'missing'` 时 log.error（「无用户且未注入首启 admin，控制台无法登录」），**不阻断启动**；
   - 启动完成日志补 `console_port: port`。
3. 启动失败清理链 + `ServerHandle.stop()`：consoleApi.stop() 加在「适配器停止」之前（先关 API 入口，再停循环）。
4. `AssembledContext` 不新增字段（consoleApi 是装配层局部资源，不暴露；与 EntryAdapter 同列管理）。
5. `app/server/package.json` 加依赖 `@asterisk/agent-console-api`、`@asterisk/agent-runtime`（createLifecycleStore——检查是否已依赖，已依赖则不动）。

### 5.11 DTO 与类型导出（dto.ts）

全部 API 请求/响应类型集中在 `dto.ts` 纯 type 定义，从包根导出。**console（T14）以 `import type { ... } from "@asterisk/agent-console-api"` type-only 复用，API 契约不进 contracts 包**（contracts 保持事件域零依赖纯包；本决定更新总计划 T13 行「契约补入 contracts」的旧表述）。DTO 直接复用上游类型（User/BusinessProfile/BusinessMatch/ExitBinding/AssetMeta/AssetManifest/ConfigField/Task/LifecycleRecord），新定义的只有请求体与聚合响应：

```ts
// 请求体（示例，全部字段中文注释）
export interface CreateBusinessBody {
  business_name: string;
  source: EventSource;        // 首个匹配行来源
  event_type: string;         // 首个匹配行事件类型
  entry_config?: Record<string, unknown>;
  on_failure?: boolean;
  prompt?: string;
  model?: string;
  agent_kind?: string;
  package_asset_id?: string;
  entry_program?: string;
  tool_asset_ids?: string[];
  skill_asset_ids?: string[];
  timeout_minutes?: number;
  max_agent_calls?: number;
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>;
}
export interface PatchBusinessBody { /* BusinessPatch 同形 */ }
export interface MatchBody { source: EventSource; event_type: string; entry_config?: Record<string, unknown>; }
export interface RegisterAssetBody { kind: AssetKind; url: string; ref: string; subpath?: string; shared?: boolean; is_private?: boolean; credential_key?: string; }
export interface EnvSetBody { bucket: "vars" | "secrets"; key: string; value: string; }
export interface EnvRemoveBody { bucket: "vars" | "secrets"; key: string; }
export interface LoginBody { username: string; password: string; }
export interface CreateUserBody { username: string; display_name: string; password: string; role: Role; }
export interface ChangePasswordBody { old_password: string; new_password: string; }

// 聚合响应
export interface BusinessDetail { profile: BusinessProfile; matches: BusinessMatch[]; exit_bindings: ExitBinding[]; }
export interface EnvListView { vars: Record<string, string>; secret_keys: string[]; }
export interface ExitToolMenuItem { kind: string; name: string; implemented: boolean; configSchema: ConfigField[]; }
export interface QueueCounts { pending: number; processing: number; done: number; dead: number; }
export interface QueuesStatus { entry: QueueCounts; exit: QueueCounts; }
export interface ApiErrorBody { error: { code: string; message: string } }
```

## 6. 测试清单

测试起真实 HTTP 服务（`port: 0`）+ node 内置 fetch 发请求；workspace 用临时目录；资产登记测试用本地 git 仓库 fixture（`git -c user.email=test@test -c user.name=test commit`，与既有包测试同一约定）。

**accounts.test.ts**：scrypt 存取往返；login 成功/密码错/用户不存在/已停用（三者同返回 null）；resolve 有效/过期/未知 token；logout 幂等；createUser 权限与 username 冲突；setDisabled 自停用拒绝/最后 admin 拒绝；changePassword 验旧 + 其它会话失效；ensureBootstrapAdmin 三分支。

**http.test.ts**：非法 JSON 400；body 超 1MB 413；未知路由 404；未捕获异常 500 且不外泄细节；错误体格式统一。

**auth-routes.test.ts**：login 201 + Set-Cookie 属性（HttpOnly/Path/Max-Age/SameSite）；cookie 认证全链路；logout 后 401；me；change-password 后旧 token 失效；未登录访问任何受保护路由 401。

**users-routes.test.ts**：admin 建号/列表/停用；member 访问 403；停用后该用户登录 401。

**businesses-routes.test.ts**：创建（201 + 返回 profile）；creator 可改/他人 403/admin 可改；PATCH 白名单外字段 400；匹配行增删幂等；DELETE 后 404；GET /api/businesses 列表。

**assets-routes.test.ts**：登记（本地 git fixture）201；member 列表示自己的+共享的、admin 列表全部；admin 登记 403；详情触发物化返回 manifest；下架 204 + 再登记同三元组同 asset_id；非属主下架 403；is_private 无 credential_key 400。

**env-routes.test.ts**：global 读（member 可读）；global 写 member 403/admin 204；业务层写 creator/他人/admin 权限矩阵；secrets 只写——list 只见键名不见值；key 非法（空白）400。

**monitoring-routes.test.ts**：queues 计数（手工 enqueue/complete 造数）；tasks 过滤（queue 参数必填 400）；runs 列表与单条 404。

**app/server 侧**：config 新键解析（console_port 默认/覆盖/非法；bootstrap_admin 成对校验）；bootstrap 集成——console API 端口可连、stop 后连接拒绝；ensureBootstrapAdmin 'missing' 不阻断启动。

## 7. 验收标准

1. `packages/console-api` 与 `app/server` 的 build/test/typecheck/lint/format:check 全绿；
2. 根目录 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 全绿；
3. §5 全部路由有对应测试且权限矩阵逐条覆盖；
4. asset-registry / registry 增补方法有测试，两包既有测试不回归；
5. smoke：真实 bootstrap 后 `curl -X POST :6100/api/auth/login` 全链路可走通（首启 admin 注入 → 登录 → 建业务 → 查询监控）。

## 8. 决策点（本规格已定案，执行中不重新讨论；有异议找 owner）

1. **管理 API 独立成包** `packages/console-api`，不放 app/server：app 层只装配，逻辑可独立测试；DTO 由包根导出供 console type-only 复用。
2. **API 契约不进 contracts 包**：contracts 保持事件域；console 直接 type-only 依赖 console-api。总计划 T13 行「契约补入 contracts」表述随之更新。
3. **ConfigStore 不做**：全局参数改法 = 改 env/config.json 重启；`GET /api/config` 只读回显。运行中热改涉及调度器契约，后续单独立项。
4. **监控全部只读**：任务终止/重试不做（需 runner kill 与重入队设计）。
5. **两个契约增补**（asset-registry.remove、registry.list）属控制台读写的最小必要缺口，已在 §5.6/§5.7 固化签名，实现时不得偏离。
6. **私有资产凭据统一从通用层安全桶解析**（`env.getFor("")`）；业务层安全桶不参与资产登记期凭据解析。
7. **首启 admin 注入失败不阻断平台启动**（记 error 日志）——平台核心职责是跑业务循环，控制台可后续补建。
8. **cookie 不加 Secure 标记**：HTTPS 终结属部署层；SameSite=Lax + HttpOnly 已有基本防护。
9. **下架不校验在役引用**：机械删除，提示义务归 console UI。
