# SDK 日志分析业务：多仓登记表 spec

- 日期：2026-11-13
- 状态：待评审
- 背景出处（非必读）：老项目 `sdk-log-bot` 的 `sdk-knowledge/repos/registry.md`（7+ 个 SDK 仓）；现行单仓实现 spec `docs/specs/2026-11-12-sdk-log-analysis-spec.md`（如有）

## 1. 问题与目标

现行日志分析业务的运行配置假设**单一仓库**：env key `sdk_repo_url`（必填）、`mainline_ref`（缺省 msync）、`assignee_tag`（缺省 sdk）、`sdk_repo_account`（可选）。但 SDK 日志分析的对象天然是**一组仓库**（iOS / Android / Linux / Web / HarmonyOS / Flutter…），且 `mainline_ref`、`assignee_tag` 都是**跟着仓走的值**（emclient-linux 主线 msync、iOS 主线 chatsdk；各平台通知对象不同）。把一组 per-repo 三元组塞进平台扁平 key-value 桶既表达不了、也违背"平台不感知业务细节"的铁律。

目标：

1. 仓库组（url / mainline_ref / assignee_tag / 账号引用 / 选仓线索）的**唯一权威来源**改为业务包内置的**仓库登记表**，随业务包版本管理；
2. 事件 run 能**自动选仓**（确定性规则，可复现，不依赖模型即兴判断）；
3. warmup 从"预热单仓"升级为"遍历登记表预热全部仓"；
4. **平台、控制台、local-runner、运行契约零改动**——改动全部关在 `business/sdk-log-analysis` 业务包内；
5. env 配置减负：删除 `sdk_repo_url` / `mainline_ref` / `assignee_tag` / `sdk_repo_account` 四个 key。

## 2. 非目标

- 不改平台 env 结构（不做 JSON 值、不做嵌套桶）；
- 不做"一个日志跨多仓分析"（一次 run 分析一个仓，识别出多个平台关键词时取首个命中）；
- 不改上游审查工单的任何行为（选仓是下游业务内部职责）；
- 不迁移老项目的 `sdk-knowledge` 知识库内容（登记表只登记定位信息，`notes` 字段留扩展位）。

## 3. 决策记录（已与需求方确认）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 仓库组的归属 | 业务包内置登记表（repos.json），不在平台体现 |
| D2 | 平台改动 | 零改动；控制台 env 只删 key 不增 key |
| D3 | 选仓主体 | 业务内确定性规则（关键词匹配），模型不参与选仓 |
| D4 | 多账号 | 复用既有正交设计：登记条目引用账号名，secrets 按账号配（`git_account_{账号}_username/token`）；首版 6 仓均为公开仓，account 全部缺省（匿名） |
| D5 | 实施时机 | 单仓全链路验证（进行中）先行通过，再落地本 spec；落地后旧四 key 移除 |
| D6 | 首版仓范围 | 6 仓：linux / ios / android / harmony / flutter / react-native；websdk / websdk2（web）无账号权限，不登记 |
| D7 | 选仓语料 | 工单标题 + 日志附件前 64 KB，小写子串匹配；不引入上游 mentions/标签字段（契约稳定优先） |
| D8 | 多命中优先级 | 登记表数组顺序即优先级，首个命中生效；维护纪律 = 越具体的仓越靠前 |
| D9 | 预热范围 | 维持现行全分支预热（bare clone + 全量 fetch 已覆盖所有分支，版本分支不过时）；不做 top-3 热点分支选择 |
| D10 | 4.x/5.x 双主线 | 每仓只登记一个 mainline_ref（4.x 主线）；按版本动态选分支是单仓时代已有的已知局限，另立项 |
| D11 | assignee_tag | 首版 6 仓统一 "sdk"；分端标签后续迭代 |

## 4. 设计

### 4.0 首版登记表内容（D6/D10/D11，已与需求方逐仓确认）

| 顺序 | key | url | mainline_ref | assignee_tag | match |
|---|---|---|---|---|---|
| 1 | ios | https://github.com/easemob/emclient-ios | chatsdk | sdk | ios, iphone, ipad |
| 2 | android | https://github.com/easemob/emclient-android | chatsdk | sdk | android, 安卓 |
| 3 | harmony | https://github.com/easemob/emclient_harmony | dev | sdk | harmony, harmonyos, 鸿蒙 |
| 4 | flutter | https://github.com/easemob/im_flutter_sdk | flutter2_stable | sdk | flutter, dart |
| 5 | react-native | https://github.com/easemob/react-native-chat-sdk | dev | sdk | react-native, reactnative, react native |
| 6 | linux | https://github.com/easemob/emclient-linux | msync | sdk | linux, emclient, native sdk |

顺序按 D8 纪律"越具体越靠前"（iOS 日志提到 linux core 时命中 ios 而非 linux）。react-native 不带 "rn"（噪声过大）。websdk / websdk2 不登记（无仓库权限，D6）。

### 4.1 仓库登记表 `repos.json`

位置：`business/sdk-log-analysis/package/repos.json`（包资产根，与 `agent-package.json` 同级；物化后随包走，平台与本地独立运行天然可见）。

```json
{
  "version": 1,
  "repos": [
    {
      "key": "linux",
      "url": "https://github.com/easemob/emclient-linux",
      "mainline_ref": "msync",
      "assignee_tag": "sdk",
      "account": "gh_asterisk",
      "match": ["linux", "emclient"],
      "notes": "iOS/Android/HarmonyOS 共享 C++ 核心，双端一致行为根因常在此"
    }
  ]
}
```

逐字段语义（每个成员都是契约）：

| 字段 | 类型 | 必填 | 语义与约束 |
|---|---|---|---|
| `version` | number | 是 | 登记表 schema 版本，当前恒 1；加载时不认识的更大版本 → fail（提示升级业务包），更小版本按 1 处理 |
| `repos` | array | 是 | 仓条目列表，**`key` 全表唯一**；空数组 → fail |
| `key` | string | 是 | 仓的稳定短标识（小写字母/数字/连字符），用于日志、通知、metrics 标注；**与 match 关键词无关**，是纯标识 |
| `url` | string | 是 | 仓远端地址，必须 http(s)；bare 缓存的唯一 origin（沿用现行 slug 机制，slug 由 url 派生） |
| `mainline_ref` | string | 是 | 该仓主线分支/标签，主线审计（mainline-audit）检出用；不再读 env `mainline_ref` |
| `assignee_tag` | string | 是 | 该仓的通知对象标签（F3 过滤与 @人 用，语义同现行 env `assignee_tag`）；不再读 env `assignee_tag` |
| `account` | string | 否 | 账号名引用；有值则凭据按 `git_account_{account}_username/token` 解析（宽容读，缺 key 按无凭据继续）；无值/缺省 = 公开仓匿名。不再读 env `sdk_repo_account` |
| `match` | string[] | 是 | 选仓关键词（小写归一），见 §4.2；非空，元素非空字符串 |
| `notes` | string | 否 | 该仓背景知识，选仓命中后注入分析提示词（老项目 registry 的定位信息精简版）；缺省不注入 |

加载纪律：

- 加载口统一为 `loadRepoRegistry()`（`packages/repos.ts` 新增）：以**包根为锚点**解析（实现用 `import.meta.url` 相对定位，不依赖 cwd、不读 env），读取 + JSON 解析 + 逐字段校验，任何非法 → 抛错，入口映射 `sdk.fail`；
- 三个入口（main / check-input / warmup）各自调用加载；登记表体积小，不做缓存（每次 run 读一次是廉价路径，避免缓存失效问题）；
- 登记表文件缺失 → fail（它是业务运行的必要输入，与 agent-package.json 同级必要）。

### 4.2 选仓规则（确定性，D3）

时机：analysis-flow 的"审查通知解析通过"之后、准备 worktree 之前。

1. **语料**：a) 工单标题（审查通知 payload 的 title）；b) 日志附件文本的前 64 KB（materialize 之后的本地文件直读）。两者拼接为小写语料。
2. **匹配**：按登记表**数组顺序**逐条目扫描，任一等价小写的 `match` 关键词在语料中出现（子串包含）即命中该条目；首个命中终止。
3. **无命中**：不准备 worktree、不调模型，产出 `platform_unknown` skip 结果 → 企微通知"无法识别平台，未分析"（含 issue_key 与日志头部摘要，方便人工补充 match 词）→ run success（与现行"模型判定 skip"同地位：只记录不通知大模型结论，但平台未知要通知人，因为是配置缺口信号）。
4. 模型全程不参与选仓；`notes` 在命中后作为上下文注入提示词。

### 4.3 各程序改造点（全部在业务包内）

**main / analysis-flow**（`packages/analysis-flow.ts`）：
- 删除 `config.sdk_repo_url` 必填校验与读取；改为：加载登记表 → §4.2 选仓 → 命中条目提供 `url` / `mainline_ref` / `assignee_tag` / `account`；
- F3 过滤的 `assigneeTag` 改取命中条目 `assignee_tag`（不再有 env 缺省值路径）；
- worktree / mainline-audit 调用入参的仓 URL、mainline_ref、账号从命中条目来；`resolveGitCredentials` 签名不变（仍收账号名）；
- `platform_unknown` 分支新增（§4.2-3）。

**check-input**（`apps/check-input`）：现行不读被删四 key，**无需改动**（回归确认即可）。

**warmup**（`packages/warmup.ts`）：
- 从"单仓预热"改为"**遍历登记表逐仓预热**"；每仓独立 try/catch：单仓失败记 warn（含 key 与脱敏错误）并继续下一仓，不整体失败（预热是尽力而为，单仓故障不应拖垮全部仓的新鲜度）；
- 预热范围维持现行全分支语义（D9）：bare clone + `git fetch --no-tags origin` 本来就同步所有分支，版本分支不会"过时"；**不做 top-3 热点分支选择**，登记表也不承载分支清单；
- 产出 `WarmupResult` 改为逐仓数组：每仓 `{ key, repo, repo_dir, action, duration_ms }`，metrics 保留键结构不变（D2 决策：逐仓一行，排查时定位哪个仓没热）；
- 凭据按条目 `account` 解析（沿用 `resolveGitCredentials`，签名不变）。

**mainline-audit**（`packages/mainline-audit.ts`）：`mainline_ref` / url / account 入参来源改为命中条目，内部逻辑不动。

**通知**（`packages/notify-message.ts`）：分析通知里追加仓 key 标注（如 `[linux]`），方便接收人判断结论归属；平台未知通知模板新增。

### 4.4 env key 移除清单（控制台侧动作，落地后由用户在控制台删除）

| key | 桶 | 处置 |
|---|---|---|
| `sdk_repo_url` | vars | 删除 |
| `mainline_ref` | vars | 删除 |
| `assignee_tag` | vars | 删除 |
| `sdk_repo_account` | vars | 删除 |

保留不变：`jira_url`、`jira_username`/`jira_password`/`jira_redirect_username`/`jira_redirect_password`（secrets）、`wecom_key_out`、`git_account_{账号}_username/token`（secrets）。

### 4.5 契约与兼容性

- 业务对平台契约（check-input/check-output 结果行、sdk.return/fail 信封、metrics 保留键）**不变**；
- 业务对上游契约（审查通知解析）**不变**；
- 业务持久数据（analysis-records）新增/沿用：记录里加 `repo_key` 字段标注分析所用仓；旧记录无此字段，读口按可空处理（不回填）；
- 平台、console-api、runtime、asset-registry、local-runner：**零改动**（回归跑绿即可证明）。

## 5. 决策点

无遗留决策点。 grilling 评审五轮结论已全部落入 §3 决策记录（D6–D11）与 §4.0 首版登记表。

已知局限（不在本 spec 范围）：

- **4.x/5.x 双主线**（D10）：每仓单 mainline_ref，5.x 工单（如 HIM-24170 "[Native SDK 5.1.0]"）的主线审计暂以 4.x 主线为参照；后续可按日志版本号推分支另立项；
- **分端通知标签**（D11）：assignee_tag 全仓统一 "sdk"，分端路由后续迭代。

## 6. 验收标准

1. 单测：登记表加载（各字段非法用例）、选仓（命中/无命中/大小写/顺序优先）、warmup 多仓（单仓失败不阻断）、main 全流程注入条目值；`platform_unknown` 分支；
2. 业务包全量测试 + typecheck + lint 通过；
3. 平台五包（asset-registry / runtime / console-api / registry / workflow-runner）+ console 测试回归全绿（证明零改动）；
4. e2e：env 四 key 删除后，HIM-24170 重推全流程通过（linux 仓命中）；构造一条 iOS 日志工单命中 ios 仓（验证"越具体越靠前"顺序纪律）；
5. `平台配置指南.md` 同步改写（删四 key 说明、加 repos.json 维护说明、选仓关键词维护指引）。

## 7. 任务拆分（实施顺序）

1. T1 `packages/repos.ts`（登记表加载 + 校验）+ 单测
2. T2 选仓模块 + 单测（含 platform_unknown 通知）
3. T3 analysis-flow / mainline-audit 改造接入
4. T4 warmup 多仓遍历
5. T5 通知标注 + analysis-records `repo_key`
6. T6 回归 + e2e + 指南文档 + 控制台删 key 操作清单
