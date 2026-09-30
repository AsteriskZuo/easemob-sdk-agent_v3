# 用户与账号（最小设计）

> 定位：内部工具的最小账号体系——能登录、能分清"谁的业务"、能管住全局开关，够用就好。
> **本页是 `User` 类型与角色权限规则的唯一定义处**，其他文档（设置契约、业务注册表）一律引用本页。
> 明确不做的功能见 §5，不为未确认需求预留结构。

---

## 1. 角色与权限规则

两个角色，没有更细粒度：

| 角色 | 说明 |
|------|------|
| `admin` | 平台管理员；可管全局设置、用户账号，可干预任何业务；对全部资产（包/工具/skill）只读，**不持有资产** |
| `member` | 普通成员；可创建业务，管自己的业务与自己的资产 |

权限规则（与设置模块契约 §3 一致，这里是用户视角的总表）：

| 操作 | member | admin |
|------|--------|-------|
| 读任何设置/业务配置 | ✅（内部工具，读不设限） | ✅ |
| 读资产（包/工具/skill） | 自己的 + 他人共享的 | ✅ 全部（只读） |
| 写全局设置（超时、hop 上限、并发数等） | ❌ | ✅ |
| 创建业务 | ✅（创建者 = 自己） | ✅ |
| 改业务配置/业务设置 | 仅自己创建的 | ✅ 全部 |
| 写环境配置（普通/安全两桶） | 仅自己业务的业务层 | ✅ 全部（含通用层） |
| 写资产（登记/更新/下架；工具与 skill 的共享标记登记时定、不可改） | 仅自己的 | ❌（不持有资产） |
| 用户管理（建号/停用） | ❌ | ✅ |
| 改自己的密码、显示名 | ✅ | ✅ |

**SYSTEM 伪用户**：定时器、内部事件等无真人操作者的场景使用，`role: 'admin'`，仅内部模块持有，不对应任何登录账号、不可登录。

---

## 2. 数据模型（两张表，归控制台模块，经 Database 薄封装）

```ts
type Role = 'admin' | 'member';

/** 用户；user_id 全平台稳定标识（业务配置里的 creator_id 指向它） */
interface User {
  user_id: string;        // usr_ 前缀，IdGen 生成
  username: string;       // 登录名，唯一，创建后不可改
  display_name: string;   // 展示名，可改
  role: Role;
  password_hash: string;  // scrypt（node:crypto 内置，零依赖）
  disabled: boolean;      // 停用标记：停用不删行（历史业务的 creator_id 仍指向它）
  created_at: string;
}

/** 控制台登录会话 */
interface ConsoleSession {
  token: string;          // 随机串，IdGen 生成
  user_id: string;
  expires_at: string;     // 固定有效期，过期重新登录（不做滑动续期）
}
```

---

## 3. 认证

- 控制台账号密码登录；成功发随机 token（httpOnly cookie），**有效期 7 天**，过期重新登录；
- 控制台全部接口（除登录页/登录接口）要求先 `resolve(token)` 识别操作者 `actor: User`，权限判定只认 actor，不认前端传的任何身份字段；
- 未登录/已停用用户：仅可访问登录页。

---

## 4. 账号生命周期

- **不开放注册**。首个 admin 在部署初始化时由环境变量注入（首启检测无用户则创建）；
- admin 在控制台创建成员账号（设初始密码，成员首次登录后自行修改）；
- **停用**代替删除：停用后不能登录，其创建的业务保留并继续运行（业务是平台资产，不随人走）；需要交接时由 admin 改业务的 `creator_id`。其登记的资产：共享资产继续可用（资产行只是 git 指针，仓库与物化还在），接手 = fork 仓库、登记新资产并共享——不需要 admin 代管资产。

> 说明：建号方式后续有需求再调整——例如"一个小组一个账号"（账号主体从人变组，权限规则不变）或邀请链接自助建号；当前 admin 直接建号够用，不提前做。

---

## 5. 接口契约

控制台模块内部使用，不外溢到内核：

```ts
interface AccountService {
  /** 登录：成功返回会话，失败返回 null（不区分"用户不存在/密码错"，防枚举） */
  login(username: string, password: string): ConsoleSession | null;

  /** 每个控制台请求经此识别操作者；token 无效/过期/用户已停用返回 undefined */
  resolve(token: string): User | undefined;

  /** 仅 admin：创建成员账号 */
  createUser(actor: User, input: { username: string; display_name: string; password: string; role: Role }): User;

  /** 仅 admin：停用/启用 */
  setDisabled(actor: User, user_id: string, disabled: boolean): void;

  /** 本人改密码（需验旧密码） */
  changePassword(actor: User, old_password: string, new_password: string): void;
}
```

依赖：`Database`、`IdGen`、`Clock`、`Logger`（登录成功/失败、建号、停用打 info 级日志，密码与 hash 永不进日志——脱敏内建于 Logger）。

---

## 6. 明确不做

- 开放注册、找回密码/邮件流程、密码复杂度策略与强制轮换；
- SSO / OAuth / LDAP 等企业身份集成；
- 多租户、资源级 ACL 等细粒度权限（两角色够用）；
- 独立审计体系（关键操作走 `logging.md` 的 info 契约性日志，不另建审计表）。

以上任一项未来真有需求时，按演进路径单独立项，不在本期结构中预留。
