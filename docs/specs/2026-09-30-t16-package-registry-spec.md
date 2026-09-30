# T16 package-registry 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/core-modules.md` §4.4、`design/package-model.md`、`design/console-design.md` §6。

## 1. 目标

产出 `@easemob/agent-package-registry` 包：程序包注册表——**程序包的登记 / 列表 / 取用 / 物化 / 名解析的唯一读写口**。程序包是平台管理的唯一资产单元（内含子程序、skill、自有资源）；本包只管"包在哪里、内容是否合格、名字解析到哪"，不执行包内任何内容。

## 2. 背景知识（执行所需的最小上下文）

- **程序包**：一个 git 仓库（或其子目录）或上传的目录，根下有清单文件 `agent-package.json`。包内可含多个子程序（可执行入口）、多个 skill（含 SKILL.md 的目录）、其他资源。平台只解析清单这一个文件。
- **可见性三级**：`public`（全平台可绑定）/ `account`（归属创建者账号）/ `business`（只一个业务可绑定）。本包只记录归属字段，**不做权限判定**（归控制台层）。
- **提供方式双模**：
  - **引用模式**：登记 git 描述符（url + ref + 可选 subpath），登记时不下载；内容按需物化（clone）到 `cache/packages/{asset_id}/`，物化是缓存、缺失自动补拉；
  - **上传模式**：字节直接交平台，登记时拷贝为母本存 `content/` 下按可见性分目录，母本永不自动删。
- **asset_id**：包的唯一编号，兼任版本钉（内容变即 id 变）：引用模式 = 引用描述符的 hash（不下载即得）；上传模式 = 整包内容 hash。同包同 id 天然去重。
- **清单机械校验**：清单存在且合法 JSON；`programs`/`skills` 的每条路径在包内真实存在。登记（上传模式）与物化（引用模式）时各校验一次，校验不过 = 失败。
- **名解析**（消费方是 T17 ContextLoader / T11 AgentService 的 skill 白名单）：业务绑定多个包，资源名的解析范围 = 该业务绑定的全部包；同名冲突按可见性优先级 **业务级 > 账号级 > 公共** 首个命中；支持 `包名/资源名` 限定写法。本包提供解析纯函数，绑定关系的存取不在本包（归 registry 包，T17 扩列）。
- **工作目录布局**（console-design §6）：母本 `{workspace}/content/{public|accounts/{owner}|businesses/{business_id}}/packages/{asset_id}/`；物化 `{workspace}/cache/packages/{asset_id}/`。本包通过工厂参数拿到这两个根，不读环境变量。
- 数据访问只能经 `@easemob/agent-database`，禁止直接 import `node:sqlite`。

### 2.1 消费的上游包真实签名

`@easemob/agent-database`（0.1.0）：

```ts
export interface Database {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** migrations 是有序 SQL 列表，下标即版本号；已应用的跳过，未应用的按序在各自事务内执行并登记 */
export function migrate(db: Database, module: string, migrations: readonly string[]): void;
```

## 3. 范围与不做清单

**本任务做**：`createPackageRegistry` 工厂（register / list / get / materialize）+ 清单机械校验 + asset_id 计算 + `resolveResource` 名解析纯函数。

**本任务不做**：

- HTTP 上传端点（归 T13；T13 把上传字节落成目录后以 upload 模式调 `register`）；
- 业务与包的绑定关系存取（归 registry 包，T17 扩列；本包的 `resolveResource` 只接收调用方排好序的包集合）；
- 包内容的执行或加载（归 WorkflowRunner / AgentService）；
- 权限校验（读/写/admin 判定归控制台层，本包只记录 `owner_id`）；
- git 认证体系（凭证型 url 由调用方在 url 内携带；本包只保证 `GIT_TERMINAL_PROMPT=0` 防挂起）；
- 缓存清理策略（cache 随时可清，缺失时 materialize 自动补拉）。

## 4. 包结构

```text
packages/package-registry/
├── package.json            # @easemob/agent-package-registry
├── tsconfig.json           # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts            # 统一导出
│   ├── asset-id.ts         # asset_id 计算（git 描述符 hash / 目录内容 hash）
│   ├── manifest.ts         # 清单解析与机械校验
│   ├── package-registry.ts # 工厂 + register/list/get/materialize
│   └── resolve.ts          # resolveResource 纯函数
└── tests/
    ├── package-registry.test.ts
    └── resolve.test.ts
```

工程约定同 T0 spec §4（ESM、相对导入带 `.js` 后缀、包级脚本模板、devDependencies 自声明）。`dependencies`：`@easemob/agent-database`（版本号形式 `0.1.0`）。其余只许 import `node:*`。

## 5. 详细规格

### 5.1 接口

```ts
import type { Database } from '@easemob/agent-database';

export type PackageVisibility = 'public' | 'account' | 'business';

/** 提供方式：git = 引用模式（登记不下载）；upload = 上传模式（path 为已落盘的包目录） */
export type PackageSource =
  | { type: 'git'; url: string; ref: string; subpath?: string }
  | { type: 'upload'; path: string };

/** 登记输入 */
export interface PackageInput {
  source: PackageSource;
  visibility: PackageVisibility;
  owner_id: string;        // 创建者账号 id（读写权限判定数据，本包只记录）
  business_id?: string;    // visibility='business' 时必填，否则抛错
}

/** 登记元数据（库行） */
export interface PackageMeta {
  asset_id: string;              // 包编号，兼任版本钉（见 §5.2）
  visibility: PackageVisibility;
  owner_id: string;
  created_at: string;            // ISO 时间戳
  modified_at: string;           // 本版无修改操作，恒等于 created_at
}

/** 清单（agent-package.json）解析结果 */
export interface PackageManifest {
  name: string;                       // 包名（限定名解析用）
  version?: string;
  programs: Record<string, string>;   // 子程序名 → 入口文件（相对包根）
  skills: string[];                   // 包内 skill 目录路径（相对包根）
}

/** 取用结果：登记元数据 + 清单解析结果 */
export interface PackageObject {
  meta: PackageMeta;
  manifest: PackageManifest;
}

export interface PackageRegistry {
  /** 登记：git 模式记描述符（不下载）；upload 模式拷贝母本并校验清单。
   *  同 asset_id 重复登记 = 幂等返回已有 meta（同包同 id 天然去重） */
  register(input: PackageInput): PackageMeta;

  /** 列表：按 visibility / owner_id 过滤（均可缺省 = 不过滤）；权限过滤归调用方 */
  list(filter: { visibility?: PackageVisibility; owner_id?: string }): PackageMeta[];

  /** 取用：内部先 materialize 再解析清单；未登记抛 `package_not_found` */
  get(asset_id: string): PackageObject;

  /** 物化：确保包内容在本地可用，返回包根绝对路径（幂等；缓存缺失自动补拉） */
  materialize(asset_id: string): string;
}

/** 工厂：db 为全平台唯一数据访问口；paths 为工作目录布局的两个根（由装配方给） */
export function createPackageRegistry(
  db: Database,
  paths: { content_root: string; cache_root: string },
): PackageRegistry;
```

### 5.2 asset_id 规则

- 格式：`pkg_` + sha256 hex 前 16 位（全长 20 字符）；
- git 模式：hash 输入 = `${url}\n${ref}\n${subpath ?? ''}` 的 UTF-8 字节；
- upload 模式：hash 输入 = 目录内容摘要——递归遍历包目录全部文件，按相对路径（posix 风格）排序，对每个文件依次向同一 sha256 先更新相对路径字符串、再更新文件字节；空目录按无文件处理（摘要即空输入的 hash）。

### 5.3 清单机械校验（manifest.ts）

`validateManifest(packageRoot: string): PackageManifest`，逐条不过即抛 `manifest_invalid: <原因>`：

1. `{packageRoot}/agent-package.json` 存在、是合法 JSON、是对象；
2. `name`：非空 string；`version`：可选 string；
3. `programs`：可选 object，键非空、值 string；缺省归一为 `{}`；
4. `skills`：可选 string 数组，元素非空；缺省归一为 `[]`；
5. 每条路径（programs 值 / skills 元素）：必须是相对路径、不含 `..` 段、`path.resolve(packageRoot, p)` 仍在 packageRoot 内、且该路径**真实存在**（programs 指向文件，skills 指向目录）。

### 5.4 存储与母本布局

一张表，迁移列表声明（`migrate(db, 'package-registry', MIGRATIONS)`），v1：

```sql
CREATE TABLE packages (
  asset_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,        -- 'git' | 'upload'
  source_json TEXT NOT NULL,        -- git: {url, ref, subpath?}；upload: {master_path}
  visibility TEXT NOT NULL,         -- 'public' | 'account' | 'business'
  owner_id TEXT NOT NULL,
  business_id TEXT,                 -- visibility='business' 时有值
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);
```

母本目录（upload 模式登记时拷贝至此）：

- public → `{content_root}/public/packages/{asset_id}/`
- account → `{content_root}/accounts/{owner_id}/packages/{asset_id}/`
- business → `{content_root}/businesses/{business_id}/packages/{asset_id}/`

### 5.5 register 行为

- git 模式：`url`/`ref` 非空校验（缺 → `invalid_input: <原因>`）；算 asset_id；已存在 → 幂等返回已有 meta；否则插行返回；
- upload 模式：`path` 必须是已存在的目录；算 asset_id；已存在 → 幂等返回；否则 `fs.cpSync` 递归拷贝到母本目录 → `validateManifest(母本目录)` → 校验失败则**删除已拷贝的母本目录**并原样抛错（不留半成品）；成功插行返回；
- `visibility='business'` 且缺 `business_id` → `invalid_input: business_id required`；
- 时间戳 `new Date().toISOString()`；created_at / modified_at 同值。

### 5.6 materialize 行为

- 未登记 → `package_not_found: <asset_id>`；
- upload 模式：母本路径存在 → 直接返回；不存在 → `master_missing: <asset_id>`（母本永不自动删，丢了无法自动补）；
- git 模式：target = `{cache_root}/{asset_id}/`，完成标记 = `{target}/.materialized-ok`（内容 = 完成时 ISO 时间戳）：
  1. marker 存在 → 返回 `join(target, subpath ?? '')`；
  2. 否则：`git clone --quiet <url> <临时目录>` → `git -C <临时目录> checkout --quiet <ref>`（系统 git，`node:child_process`，env 带 `GIT_TERMINAL_PROMPT=0`，超时 300 秒；失败 → `materialize_failed: <stderr 尾部 1KB>`）→ `validateManifest(join(临时目录, subpath ?? ''))` → 删除临时目录内 `.git`（缓存只是内容快照）→ 写 marker → `fs.renameSync` 到 target（target 已存在先删）→ 返回 `join(target, subpath ?? '')`；
  3. 临时目录用 `{cache_root}/.tmp-{asset_id}-{pid}`，任何失败都尽力清理。

### 5.7 名解析（resolve.ts，纯函数）

```ts
/** 调用方排好序的包视图项：按可见性优先级从高到低传入（业务级 > 账号级 > 公共），命中首个 */
export interface ResolvedPackage {
  asset_id: string;
  name: string;                     // 清单包名
  root: string;                     // 物化后的包根绝对路径
  programs: Record<string, string>;
  skills: string[];
}

export interface ResolvedResource {
  asset_id: string;   // 命中包
  name: string;       // 资源名（不含限定前缀）
  path: string;       // 绝对路径 = join(root, 相对路径)
}

/** 名解析：kind='program' 查 programs，kind='skill' 查 skills。
 *  name 形如 '包名/资源名'（恰好一段限定前缀）→ 只在该包中找，包不在集合或资源不在包内 → 抛错；
 *  否则按集合顺序找首个命中，全无 → 抛 `resource_not_found: <kind> <name>` */
export function resolveResource(
  packages: readonly ResolvedPackage[],
  kind: 'program' | 'skill',
  name: string,
): ResolvedResource;
```

## 6. 测试清单

`tests/package-registry.test.ts`（临时目录造 content/cache 根与包目录；git 用例在临时目录 `git init` + commit 造本地仓库，clone url 用该目录路径）：

- register git → meta 字段一致，asset_id 形如 `pkg_` + 16 hex；
- 同 git 描述符重复 register → 幂等同 id（list 行数不增）；不同 ref / 不同 subpath → 不同 asset_id；
- register upload → 母本拷贝到 content 对应目录、meta 正确；同内容重复 register → 幂等；内容变更 → 新 asset_id；
- upload 母本落位：public / account / business 三种 visibility 各验一条路径；
- `visibility='business'` 缺 business_id → 抛错；
- upload 清单非法（缺清单文件 / programs 路径不存在 / 路径含 `..` / skill 路径不是目录）→ 抛 `manifest_invalid`、母本目录被清理、list 无记录；
- list：无过滤返回全部；按 visibility 过滤；按 owner_id 过滤；
- get → meta + manifest 解析正确（programs/skills 内容一致）；未登记 asset_id → `package_not_found`；
- materialize upload → 返回母本路径；母本目录被人为删除 → `master_missing`；
- materialize git → clone 成功、返回路径下清单存在、`.git` 已删除、marker 存在；二次调用幂等（删掉源仓库后仍能返回，证明未重拉）；带 subpath → 返回子路径、清单在子路径校验；
- materialize git 清单非法 → 抛错、target 无 marker；url 不存在 → `materialize_failed`；
- 物化缓存目录被人为删除 → 自动补拉成功；
- 持久化：register 后 close 数据库重开 → 新实例 list/get 结果一致。

`tests/resolve.test.ts`：

- 无限定名：按传入顺序首个命中（前面的包覆盖后面的同名资源）；
- `包名/资源名` 限定：命中指定包；限定的包不在集合 → 抛错；限定包内无此资源 → 抛错；
- kind='program' 与 kind='skill' 各自解析正确，返回绝对路径 = join(root, 相对路径)；
- 资源全无 → `resource_not_found`。

## 7. 验收标准

1. 包级与根级 `build` / `test` / `typecheck` / `lint` / `format:check` / `circular` 全绿；
2. 运行时依赖只有 `@easemob/agent-database`，其余只 import `node:*`；
3. 导出签名与本文 §5.1 / §5.7 一致。

## 8. 本规格的决策点

1. **名解析的归属**：设计（package-model §7）只定义了解析规则、未定接口归属。解析需要清单与物化路径两类知识，唯一拥有者是本包，故以纯函数 `resolveResource` 落在本包；绑定关系的读取与排序（业务级>账号级>公共）由 T17 ContextLoader 负责。
2. **`get` 不含物化路径**：设计接口（core-modules §4.4）的取用结果就是「清单解析结果 + 元数据」，路径经 `materialize`（幂等廉价）单独取，不额外加字段。
3. **upload 登记入参是目录路径而非字节流**：HTTP 上传端点归 T13，字节落盘/解压是传输层的事；本包只面向「已落盘的包目录」，接口同步、无流处理。
4. **git clone 用全量 clone + checkout**（非 `--depth 1 --branch`）：ref 可能是 commit hash，`--branch` 只认分支/tag；全量 clone 对程序包规模可接受，换取行为统一。
5. **`modified_at` 保留但本版恒等于 `created_at`**：设计元数据含此字段；本版无修改操作（更新 = 新版本登记、asset_id 变），无写入路径。
