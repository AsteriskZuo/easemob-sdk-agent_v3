# 设置模块契约

> 日期：2026-09-15
> 状态：定稿
> 范围：**设置（key-value）的读写核心接口 + 权限规则 + 调度循环所需键清单**。用户/账号的完整设计见 `design/accounts.md`，本文档只引用权限判定所需的最小形状；控制台 UI 不在本文档。
> 依据：调度循环契约 §6（PlatformConfig 是本模块全局作用域的类型化读取视图）。

---

## 1. 定位与原则

- **设置 = key-value，落数据库**。控制台不直连数据库，只调本模块接口；
- **读写只有一套接口**：控制台与内部模块（含调度循环）共用，没有第二套——与 BusinessRegistry「查询/修改只有一个口」同一原则；
- **平台定键的规范**：可用键由平台预注册（键名、类型、默认值、作用域），写入时校验，防止控制台/业务乱写键；
- **安全变量不走设置模块**：secrets 属环境配置对象（循环契约 §4 EnvConfig），运行时注入、不落盘不进日志；设置里只放普通可调参数。

---

## 2. 最小用户模型（引用，非本稿设计）

```ts
type Role = 'admin' | 'member';

/** 权限判定所需的最小形状；User 与角色规则的唯一定义处：design/accounts.md */
interface User {
  user_id: string;
  role: Role;
  display_name: string;
}

/** 内部模块（调度循环、生命周期等）读取设置时使用的系统身份 */
declare const SYSTEM: User; // role: 'admin'，仅内部使用，不对应任何登录用户
```

---

## 3. 作用域与权限

```ts
type ConfigScope =
  | { kind: 'global' }                      // 全局设置：平台级运行参数
  | { kind: 'business'; business_id: string }; // 业务设置：按业务隔离
```

**权限规则（写操作的全部规则就这三条）**：

| 作用域 | 谁可写 |
|--------|--------|
| global | 仅 admin |
| business | admin，或该业务的创建者（`BusinessRegistry.get(business_id).creator_id === actor.user_id`） |

- 其他用户无权干预别人的业务设置，管理员除外——上表即全部；
- **读不设限**：控制台登录用户与内部模块（系统身份）都可读；设置内无敏感数据（secrets 不在这里）；
- **调度循环只读**：内部模块只有读取需求；写操作只来自控制台。将来若出现内部写需求，走同一个 `set`，不新增接口。

---

## 4. 键注册表（平台定规范）

```ts
/** 一个可用键的全部约定。平台预注册全部键，set 时校验存在性/类型/作用域 */
interface ConfigKeyDef {
  key: string;                          // 键名，全平台唯一
  scope: 'global' | 'business';         // 该键允许的作用域
  type: 'number' | 'string' | 'boolean';
  default: unknown;                     // 未设置时 get 返回此值；数据库只存覆盖值
  description: string;
}
```

---

## 5. 核心接口

```ts
/** 设置条目：数据库中实际存的一行（覆盖值） */
interface ConfigEntry {
  key: string;
  value: unknown;
  updated_by: string;    // user_id
  updated_at: string;    // ISO 8601
}

/** 设置读写唯一接口：控制台与内部模块共用 */
interface ConfigStore {
  /** 读取：未设置返回键注册表默认值。内部模块与控制台都用它 */
  get(scope: ConfigScope, key: string): unknown;

  /** 写入：依次校验 ①键已注册且作用域/类型匹配 ②actor 权限（§3），失败抛错 */
  set(scope: ConfigScope, key: string, value: unknown, actor: User): void;

  /** 控制台展示：列出该作用域全部已注册键（含默认值与是否被覆盖） */
  list(scope: ConfigScope): ConfigEntry[];
}
```

---

## 6. 第一批键清单（调度循环印证所需，就这三个）

| 键 | 作用域 | 类型 | 建议默认值 | 谁使用 |
|----|--------|------|-----------|--------|
| `task_timeout_minutes` | global | number | 60 | Lifecycle.run 超时 |
| `hop_limit` | global | number | 待定 | 循环判派生循环进死信 |
| `channel_concurrency` | global | number | 待定 | 并发闸门（最大通道并发数） |

- **业务级键第一批为空**：当前没有已确认的业务级设置需求，不预测扩展；将来有具体需求时在键注册表新增即可，接口不用动。

---

## 7. 与 BusinessRegistry 的边界（一个配置只有一个家）

| 配置种类 | 归属 | 例子 |
|---------|------|------|
| 结构化、影响匹配/链构造/权限归属的字段 | **BusinessRegistry**（循环契约 §3，统一读写口） | `source`、`event_type`、`disposition`、`creator_id`、`business_name` |
| 数值/开关型运行参数 | **ConfigStore**（本稿） | 超时、hop 阈值、闸门值 |

判定口诀：**进匹配视图 BusinessMatch 的归注册表，可调的数归设置**。

---

## 8. 与调度循环的印证

```
控制台 set(global, 'task_timeout_minutes', 90, admin)
        │  落数据库
        ▼
ConfigStore.get({kind:'global'}, 'task_timeout_minutes')
        ▲
PlatformConfig（循环契约 §6）= global 作用域的类型化读取视图
        ▲                        （启动时加载 / 变更后重载，节奏由实现定）
调度循环 / Lifecycle ── 只读
```

- 循环不直接摸 key-value 字符串，经 `PlatformConfig` 拿强类型值；三个全局键正好对上 `PlatformConfig` 的三个字段；
- 加载节奏（启动读一次 / 变更通知 / 定期重载）是实现细节，不影响契约。

---

## 9. 待定项（本稿不解决，列出备忘）

| 项 | 说明 | 归属 |
|----|------|------|
| 用户/管理员完整设计 | 认证、创建、最小够用 | 单独文档 |
| 变更历史 | ConfigEntry 只留最新 updated_by/at；是否保留修改历史 | 待定 |
| `hop_limit` / `channel_concurrency` 默认值 | 待定 | 定稿时填 |
