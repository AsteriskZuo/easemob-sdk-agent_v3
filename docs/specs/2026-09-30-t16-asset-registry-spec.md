# T16 asset-registry 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/core-modules.md` §4.4、`design/asset-model.md`、`design/console-design.md` §6。

## 1. 目标

产出 `@easemob/agent-asset-registry` 包：资产注册表——**三族资产（包/工具/skill）的登记 / 列表 / 取用 / 物化 / 名解析的唯一读写口**。本包只管"资产在哪里、内容是否合格、名字解析到哪"，不执行资产内任何内容、不做权限判定。

## 2. 背景知识（执行所需的最小上下文）

- **资产三族**：
  - **包（package）**：业务代码单位——流程程序入口 + 胶水代码，能独立完成一个任务；不共享；
  - **工具（tool）**：可复用代码组件（jira-fetch、脱敏…），被 `sdk.run` 按名调用；
  - **skill**：可复用提示词组件——一个 **skill 集合**：资产根下每个含 `SKILL.md` 的直接子目录是一个 skill，技能名 = 目录名。
- **总纲提示词不是资产**：每业务一个的业务资料字段（控制台登记、平台注入、不共享），不在本包三族范围内；工具 / skill / 总纲用不用、用多少，全是包的自由。
- **唯一来源 = git 仓库**。资产身份 = **(url, commit, 子路径) 三元组**；登记时可给分支/tag/commit，平台用 `git ls-remote` 把分支/tag **解析成 commit 存定**（钉版本）。没有上传模式、没有本地内容 hash、没有母本存储。
- **私有仓库凭据**：资产可声明 `is_private` + `credential_key`（key 的名字，值在操作者的安全桶里）。**凭据按操作者维度由调用方解析**，register / materialize 以可选参数接收凭据值；本包只在 git 子进程内临时注入（不落盘、不进日志、错误信息脱敏），不接触安全桶。托管平台无关（GitHub / Gitee / 内网 git 均走 git 协议）。使用者之间互不相干——谁触发物化就用谁的凭据。
- **asset_id** = (属主 + 三元组) 的紧凑编码：唯一性按属主维度——同一三元组不同属主 = 不同资产行，各自管理；同（属主+三元组）重复登记 = 幂等返回。
- **共享标记**：仅 tool/skill 可有，`shared` 缺省 false，**设置后不可修改**（本包不提供任何修改入口）。绑定规则（自己的 + 他人共享的）与 admin 只读全部，都是调用方（控制台）的过滤逻辑，本包只存字段。
- **清单机械校验**（物化时执行）：
  - package/tool：资产根下 `agent-package.json` 存在且合法；`name` 非空；`programs` 每条路径在资产内真实存在且是文件；`requires`（可选）形状合法；
  - skill：资产根下至少一个直接子目录含 `SKILL.md` 文件。
- **名解析**：消费方是 T17 ContextLoader（组白名单）与 T11 AgentService（skill 注入）。`sdk.run` 的作用域 = 本包 programs ∪ 绑定工具；`sdk.agent` 的白名单 = 绑定 skill 集合的技能并集。**名唯一性由控制台在绑定配置期查重保证**，运行时解析按名唯一命中，无优先级、无限定写法。本包提供解析纯函数，绑定关系的存取不在本包（归 registry 包，T17 扩列）。
- **工作目录布局**：物化 `{workspace}/cache/assets/{asset_id}/`。本包通过工厂参数拿物化根，不读环境变量。
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

**本任务做**：`createAssetRegistry` 工厂（register / list / get / materialize）+ ref→commit 解析 + asset_id 计算 + 按 kind 的内容校验 + `resolveResource` 名解析纯函数。

**本任务不做**：

- 业务与资产的绑定关系存取（归 registry 包，T17 扩列；本包的 `resolveResource` 只接收调用方给定的资产视图集合）；
- 绑定规则与权限判定（"自己的 + 他人共享的"、admin 只读——归控制台层过滤，本包只存 `owner_id`/`shared` 字段）；
- 绑定配置期的重名检查与 requires 覆盖检查（归控制台业务流程；本包只提供数据与解析函数）；
- 资产内容的执行或加载（归 WorkflowRunner / AgentService）；
- 资产的更新/下架（更新 = 登记新 commit 的新资产行；下架接口随控制台任务再做）；
- 安全桶的存取与 credential_key → 凭据值的解析（归调用方 / EnvProvider；本包只以可选参数接收凭据值并临时注入 git 进程，不落盘、不进日志）；
- 缓存清理策略（cache 随时可清，缺失时 materialize 自动补拉）。

## 4. 包结构

```text
packages/asset-registry/
├── package.json            # @easemob/agent-asset-registry
├── tsconfig.json           # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts            # 统一导出
│   ├── asset-id.ts         # asset_id 计算（属主 + 三元组 → 短 hash）
│   ├── git.ts              # git 子进程封装：resolveRef（ls-remote）/ clone+checkout
│   ├── validate.ts         # 按 kind 的内容校验（agent-package.json / skill 集合扫描）
│   ├── asset-registry.ts   # 工厂 + register/list/get/materialize
│   └── resolve.ts          # resolveResource 纯函数
└── tests/
    ├── asset-registry.test.ts
    └── resolve.test.ts
```

工程约定同 T0 spec §4（ESM、相对导入带 `.js` 后缀、包级脚本模板、devDependencies 自声明）。`dependencies`：`@easemob/agent-database`（版本号形式 `0.1.0`）。其余只许 import `node:*`。

## 5. 详细规格

### 5.1 接口

```ts
import type { Database } from '@easemob/agent-database';

export type AssetKind = 'package' | 'tool' | 'skill';

/** 登记输入 */
export interface AssetInput {
  kind: AssetKind;
  url: string;              // git 仓库地址（本地路径亦可，git clone 支持）
  ref: string;              // 分支/tag/commit；登记时解析成 commit 存定（§5.3）
  subpath?: string;         // 资产根在仓库内的子路径（相对路径；缺省 = 仓库根）
  shared?: boolean;         // 仅 kind 为 tool/skill 有意义（package 传入 true → invalid_input），缺省 false
  owner_id: string;         // 属主账号 id
  is_private?: boolean;     // 私有仓库标记，缺省 false；true 时 credential_key 必填（§5.6）
  credential_key?: string;  // 凭据 key 的名字（指向操作者安全桶）；本包只存名字不存值
}

/** 登记元数据（库行） */
export interface AssetMeta {
  asset_id: string;         // `ast_` + sha256 前 16 hex（§5.2）
  kind: AssetKind;
  owner_id: string;
  shared: boolean;
  is_private: boolean;
  credential_key?: string;  // 仅 is_private 时有值
  created_at: string;       // ISO 时间戳
  modified_at: string;      // 本版无修改操作，恒等于 created_at
}

/** 清单解析结果：package/tool 来自 agent-package.json；skill 来自集合扫描 */
export type AssetManifest =
  | {
      kind: 'package' | 'tool';
      name: string;                       // 清单 name
      version?: string;
      programs: Record<string, string>;   // 子程序名 → 入口文件（相对资产根）
      requires: { tools: string[]; skills: string[] };  // 缺省归一为两个空数组
    }
  | { kind: 'skill'; skills: string[] };  // 技能名列表（= 含 SKILL.md 的直接子目录名，按字典序）

/** 取用结果：登记元数据 + 清单解析结果 */
export interface AssetObject {
  meta: AssetMeta;
  manifest: AssetManifest;
}

export interface AssetRegistry {
  /** 登记：解析 ref→commit（需网络/可达 git 仓库）→ 算 asset_id → 幂等或插行。不下载内容。
   *  opts.credential：调用方从操作者安全桶解析出的凭据值（is_private 资产的 ls-remote 需要，见 §5.3/§5.6） */
  register(input: AssetInput, opts?: { credential?: string }): AssetMeta;

  /** 列表：按 kind / owner_id / shared 过滤（均可缺省 = 不过滤）；权限过滤归调用方 */
  list(filter: { kind?: AssetKind; owner_id?: string; shared?: boolean }): AssetMeta[];

  /** 取用：内部先 materialize 再按 kind 校验解析；未登记抛 `asset_not_found` */
  get(asset_id: string, opts?: { credential?: string }): AssetObject;

  /** 物化：确保资产内容在本地可用，返回资产根绝对路径（幂等；缓存缺失自动补拉）。
   *  opts.credential 同 register（仅缓存缺失、需要真正 clone 时需要，见 §5.7） */
  materialize(asset_id: string, opts?: { credential?: string }): string;
}

/** 工厂：db 为全平台唯一数据访问口；cache_root 为物化根（由装配方给，如 {workspace}/cache/assets） */
export function createAssetRegistry(
  db: Database,
  paths: { cache_root: string },
): AssetRegistry;
```

### 5.2 asset_id 规则

- hash 输入 = `${owner_id}\n${url}\n${commit}\n${subpath ?? ''}` 的 UTF-8 字节；
- asset_id = `ast_` + sha256 hex 前 16 位（全长 20 字符）。

### 5.3 ref → commit 解析（git.ts resolveRef）

- `ref` 匹配 `/^[0-9a-f]{40}$/` → 直接作为 commit 返回（存在性留给物化时 checkout 检验）；
- 否则 `git ls-remote <url> <ref>`（env 带 `GIT_TERMINAL_PROMPT=0`，超时 60 秒；调用方给了 credential 时按下方注入规则携带）：
  - 无输出 → `ref_not_found: <ref>`；
  - 输出取精确匹配行；带注解 tag 优先取 `^{}` 剥离行的 commit；
  - 分支与 tag 同名等多义情况 → `ref_ambiguous: <ref>（建议直接给 commit）`。

**凭据注入与脱敏**（resolveRef 与 clone 共用同一套规则）：

- 调用方传入 `credential` 且 url 为 `https://` 形式 → **仅对本次 git 子进程**把 url 临时改写为 `https://oauth2:<encodeURIComponent(credential)>@<host><path>`（不落盘、不入库、不进日志；库里的 url 字段永远存原始形态）；
- url 为 ssh/scp-like（`git@host:...` 或 `ssh://...`）且需要凭据 → `credential_unsupported: 私有资产请使用 https 形式的 url`；
- 任何抛错的 message（含 stderr 尾部 1KB）先脱敏：凭据值出现处一律替换为 `***`。

### 5.4 内容校验（validate.ts）

`validateAsset(assetRoot: string, kind: AssetKind): AssetManifest`，逐条不过即抛 `validation_failed: <原因>`：

**package/tool**：

1. `{assetRoot}/agent-package.json` 存在、是合法 JSON、是对象；
2. `name`：非空 string；`version`：可选 string；
3. `programs`：可选 object，键非空、值 string；缺省归一为 `{}`；每条值：相对路径、不含 `..` 段、`path.resolve(assetRoot, p)` 仍在 assetRoot 内、真实存在且是文件；
4. `requires`：可选 object，`tools`/`skills` 可选 string 数组；缺省归一为 `{ tools: [], skills: [] }`。

**skill**：

1. 扫描 assetRoot 的**直接子目录**，每个含 `SKILL.md` 文件的子目录 = 一个 skill，技能名 = 目录名；
2. 至少一个合法 skill → 返回按字典序的技能名列表；否则 `validation_failed: no skill found`。

### 5.5 存储

一张表，迁移列表声明（`migrate(db, 'asset-registry', MIGRATIONS)`），v1：

```sql
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'package' | 'tool' | 'skill'
  url TEXT NOT NULL,
  commit TEXT NOT NULL,           -- 解析后的 commit（钉版本）
  subpath TEXT,                   -- 资产根子路径；NULL = 仓库根
  shared INTEGER NOT NULL,        -- 0 | 1
  is_private INTEGER NOT NULL,    -- 0 | 1
  credential_key TEXT,            -- 凭据 key 的名字；仅 is_private=1 时有值，本表不存凭据值
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);
```

### 5.6 register 行为

- 入参校验：`url`/`ref`/`owner_id` 非空；`kind` 合法；`subpath`（若有）为相对路径、不含 `..` 段；`kind='package'` 且 `shared === true` → `invalid_input: <原因>`；`is_private === true` 且 `credential_key` 为空 → `invalid_input: is_private 需要 credential_key`；`is_private` 缺省/false 时 `credential_key` 归一为 undefined（传入也不存）；
- `input.is_private` 且未传 `opts.credential` → `credential_required: <credential_key>`（ls-remote 需要认证，fail-fast 在发请求前）；
- `resolveRef(url, ref, opts?.credential)` → commit（注入与脱敏规则见 §5.3；失败原样抛 `ref_not_found` / `ref_ambiguous` / `credential_unsupported`）；
- 算 asset_id；已存在 → 幂等返回已有 meta；否则插行返回；
- 时间戳 `new Date().toISOString()`；created_at / modified_at 同值。

### 5.7 materialize 行为

- 未登记 → `asset_not_found: <asset_id>`；
- target = `{cache_root}/{asset_id}/`，完成标记 = `{target}/.materialized-ok`（内容 = 完成时 ISO 时间戳）：
  1. marker 存在 → 返回 `join(target, subpath ?? '')`（命中缓存，**不需要 credential**）；
  2. 否则：资产 `is_private` 且未传 `opts.credential` → `credential_required: <credential_key>`；`git clone --quiet <url> <临时目录>` → `git -C <临时目录> checkout --quiet <commit>`（系统 git，`node:child_process`，env 带 `GIT_TERMINAL_PROMPT=0`，超时 300 秒；credential 注入与错误脱敏见 §5.3；失败 → `materialize_failed: <stderr 尾部 1KB（已脱敏）>`）→ `validateAsset(join(临时目录, subpath ?? ''), kind)` → 删除临时目录内 `.git`（缓存只是内容快照）→ 写 marker → `fs.renameSync` 到 target（target 已存在先删）→ 返回 `join(target, subpath ?? '')`；
  3. 临时目录用 `{cache_root}/.tmp-{asset_id}-{pid}`，任何失败都尽力清理。

### 5.8 名解析（resolve.ts，纯函数）

```ts
/** 调用方给定的资产视图项（绑定集合）；解析按传入顺序首个命中 */
export interface ResolvedAsset {
  asset_id: string;
  root: string;                       // 物化后的资产根绝对路径
  programs: Record<string, string>;   // package/tool 的清单 programs；skill 资产传 {}
  skills: string[];                   // skill 资产的技能名列表；package/tool 传 []
}

export interface ResolvedResource {
  asset_id: string;   // 命中资产
  name: string;       // 资源名
  path: string;       // 绝对路径 = join(root, 相对路径)
}

/** 名解析：kind='program' 查各资产 programs，kind='skill' 查各资产 skills。
 *  按集合顺序找首个命中（名唯一性由控制台绑定配置期保证，此处不设优先级与限定写法）；
 *  全无 → 抛 `resource_not_found: <kind> <name>` */
export function resolveResource(
  assets: readonly ResolvedAsset[],
  kind: 'program' | 'skill',
  name: string,
): ResolvedResource;
```

## 6. 测试清单

`tests/asset-registry.test.ts`（临时目录造 cache 根与 git 仓库：临时目录 `git init` + commit，url 用该目录路径）：

- register package → meta 字段一致，asset_id 形如 `ast_` + 16 hex；
- ref 解析：给分支名 → 存定为该分支的 commit；给 tag（含注解 tag）→ 存定为剥离后的 commit；给 40 位 commit → 原样存定；不存在的 ref → `ref_not_found`；分支与 tag 同名 → `ref_ambiguous`；
- 同（属主+三元组）重复 register → 幂等同 id（list 行数不增）；同三元组**不同属主** → 不同 asset_id 两行；不同 commit / 不同 subpath → 不同 asset_id；
- `kind='package'` 且 `shared: true` → `invalid_input`；
- 凭据入参：`is_private: true` 缺 `credential_key` → `invalid_input`；非私有资产传 `credential_key` → 入库行 credential_key 为 NULL；
- 私有资产凭据流程（url 用本地 git 仓库路径模拟，credential 用可识别哨兵字符串如 `SECRET_TOKEN_xyz`）：`is_private` 登记未传 credential → `credential_required`；传 credential 后 register 成功（本地路径无需认证，注入逻辑不破坏正常 clone）；materialize 缓存缺失时未传 credential → `credential_required`；marker 已存在后 materialize 不传 credential → 幂等返回；
- 脱敏：带 credential 对不可达 url 物化 → `materialize_failed` 且错误信息不含 `SECRET_TOKEN_xyz`（出现处为 `***`）；
- ssh 形式 url（如 `git@host:org/repo.git`）+ `is_private` + credential → `credential_unsupported`；
- list：无过滤返回全部；按 kind / owner_id / shared 各自过滤；
- get package/tool → manifest 解析正确（programs / requires 归一）；get skill → skills 为集合扫描结果（字典序）；未登记 asset_id → `asset_not_found`；
- materialize → clone 成功、返回路径正确（带 subpath 时返回子路径）、`.git` 已删除、marker 存在；二次调用幂等（删掉源仓库后仍能返回，证明未重拉）；
- 物化时内容校验：package 清单缺失/路径不存在/路径含 `..` → `validation_failed`、target 无 marker；skill 仓库无任何 SKILL.md → `validation_failed`；
- url 不存在 → `materialize_failed`；
- 物化缓存目录被人为删除 → 自动补拉成功；
- 持久化：register 后 close 数据库重开 → 新实例 list/get 结果一致。

`tests/resolve.test.ts`：

- 按传入顺序首个命中（前面的资产覆盖后面的同名资源）；
- kind='program' 与 kind='skill' 各自解析正确，返回绝对路径 = join(root, 相对路径)；
- 资源全无 → `resource_not_found`。

## 7. 验收标准

1. 包级与根级 `build` / `test` / `typecheck` / `lint` / `format:check` / `circular` 全绿；
2. 运行时依赖只有 `@easemob/agent-database`，其余只 import `node:*`；
3. 导出签名与本文 §5.1 / §5.8 一致。

## 8. 本规格的决策点

1. **asset_id 含属主维度**：同一 git 三元组不同属主 = 不同资产行。若按纯三元组全局唯一，A 私有登记后 B 登记同仓会拿到 A 的行却无法绑定（非属主非共享），语义怪异；按属主取唯一，语义直白。
2. **登记时解析 ref→commit（`git ls-remote`）**：分支会移动，存 commit 才钉版本；代价是登记时需可达 git 仓库——登记是控制台操作，合理。40 位 commit 原样存定（ls-remote 查不到任意 SHA，存在性留给物化 checkout 检验）。
3. **名解析无优先级、无限定写法**：名唯一性由控制台在绑定配置期机械查重保证（asset-model §6），运行时按名唯一命中；纯函数按传入顺序首个命中只是确定性兜底，不是优先级机制。
4. **skill 集合无清单文件**：`SKILL.md` 目录扫描即可机械判定，不发明新格式；技能名 = 目录名（与 pi 的 `--skill <路径>` 注入形态一致）。
5. **package/tool 机械完全同构**：同一份清单契约、同一条物化校验路径，只差 kind 与消费方；`shared` 对 package 无意义（传 true 直接报错，防误配）。
6. **`modified_at` 保留但本版恒等于 `created_at`**：本版无修改操作（更新 = 新资产行），无写入路径。
7. **凭据按操作者维度传入、只存名字不存值**：资产行的 `credential_key` 只是 key 名，值由调用方从**操作者**安全桶解析后作可选参数传入（谁触发物化用谁的凭据，使用者之间互不相干）——本包因此不依赖配置模块、不接触安全桶（deps 仍只有 database）。注入采用进程内临时改写 https url + 错误脱敏：凭据不落盘、不入库、不进日志。ssh 形式 url 不支持注入（统一走 https，减少机制分叉）。
