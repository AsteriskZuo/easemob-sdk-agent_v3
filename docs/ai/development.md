# 业务包开发手册

> 平台行为验证日期：2026-11-14
> 读者：开发业务包的 AI（及其操作者）。按章节顺序执行，每节末尾有**验证**动作；字典式字段语义不在本文重复，按条目 id 查 `handbook/content/bizpkg/*.yaml`。

## 0. 本手册怎么用

- 第 1 节建立边界认知（5 分钟）；第 2~3 节是开发期主循环；第 4 节是调试核心手段；第 5~6 节是上架与编排；第 7 节是发布前自查。
- 每个「验证」小节是可执行的判据：不满足就停下来排查，不要带着失败进入下一步（排查入口：`docs/ai/troubleshooting.md`）。
- 凡本文写「查 handbook」处，含义是：读 `handbook/content/bizpkg/` 下对应 yaml 条目的 `body.cn`，不猜字段语义。

## 1. 业务包是什么（边界 10 行版）

业务包是**独立 git 仓**，由平台加载运行。核心四件：

| 件 | 作用 | 位置 |
|---|---|---|
| `agent-package.json` | 清单：程序映射 + 依赖声明（tools/skills） | 包根 |
| `main` | 主程序：取数 → 大模型 → 组装产出 | `apps/main/` |
| `contract.json` | 输入输出契约：字段路径/类型/必填 | 包根 |
| `check-input` / `check-output` | 契约闸门程序，平台三段编排自动调用 | `apps/check-input/`、`apps/check-output/` |

两个样例业务，开发时可参照：
- `jira-ticket-review`（工单审查）：有入口适配器（jira 轮询），单轮审查。
- `sdk-log-analysis`（日志分析）：无入口适配器，靠上游 run 成功派生的 internal 事件触发；内置 `repos.json` 仓库登记表与 `warmup` 定时预热程序。

目录结构、程序纪律、依赖注入规则的字段级语义：查 handbook `bizpkg.layout.*`（条目 id：`overview` / `monorepo` / `programs` / `manifest` / `requires` / `assets` / `runtime-deps`）。

## 2. 从零创建：模板向导

### 2.1 拷贝模板并初始化

```bash
# 在你要放业务仓的父目录执行（<平台仓> = easemob-sdk-agent_v3 的本地路径）
cp -R <平台仓>/templates/agent-package my-package
cd my-package
# 修改 package.json 与 agent-package.json 的 name（两个文件都要改）
npm install
```

注意（来自 handbook `bizpkg.development.quickstart`，已踩过的坑）：
- 首次 `npm install` 后**必须提交 `package-lock.json`**——平台物化用 `npm ci`，没有 lockfile 物化会失败。
- 模板里的 `your-skill` 是占位，按真实引用调整，不要带着占位提交。
- SDK 发布前本地调试可临时用 `"@asteriskzuo/agent-sdk": "file:<平台仓>/packages/sdk"`，发布前恢复为已发布版本号。

**验证**：`npm install` 退出码 0，且 `package-lock.json` 已生成。

### 2.2 逐文件改造清单

| 文件 | 改什么 |
|---|---|
| `package.json` | `name`、`version`；依赖按实际需要增删 |
| `agent-package.json` | `name`；`programs` 映射（模板已含 main/check-input/check-output 三个保留名，勿改名勿删除）；`requires.tools` / `requires.skills` 声明本包要用哪些工具/技能（名称必须与之后控制台绑定的资产名一致） |
| `contract.json` | **先写契约**：`input.fields`（`path` 用 `payload.xxx` 的点分路径）与 `output.fields`（主程序 return 的顶层键）。字段语义逐条规则查 handbook `bizpkg.contract.*`（`input.issue-key` / `transport` / `envelope` / `pipeline` / `check-discipline` / `null-semantics` / `output-consumer`） |
| `apps/main/index.ts` | 主流程骨架：模板已给出「stdin 进 JSON → 取数 → `sdk.agent` → `sdk.return` → 唯一出口」薄壳，按业务填充 |
| `apps/check-input`、`apps/check-output` | 模板实现已通用（解释 contract.json 做存在+类型校验），多数业务不用改；需要更强校验（跨字段一致性、值域）时才自写替换 |
| `apps/<业务工具程序>`（可选） | 如日志分析的 `warmup`：定时任务程序，`phases: main-only` 运行，事件 run 严禁使用该模式 |
| `packages/`、`tests/` | 业务逻辑模块与对应测试 |

关键纪律（模板注释与 handbook `bizpkg.contract.check-discipline` 的浓缩，违反会被 review 打回）：
- main **不自查**：check-input 已保证输入形状，main 按 contract 声明直接取用。
- check 程序**只判过/不过、不做转换**；解析归 main。
- main 的唯一出口是 `sdk.return(...)` / `sdk.fail(...)`：**结果由平台扇出**（下游关注 + 出口投递），业务代码自己不做通知投递。

**验证**：改完后 `npm run build && npm test && npm run typecheck` 三条全过（exit 0）。

## 3. 实现业务逻辑

### 3.1 main 编程模型

```
stdin 一段 JSON 进（sdk.input()：event 信封 + 注入的 config/secrets/endpoint）
stdout 一段 JSON 出（sdk.return 成功 / sdk.fail 失败）
日志走 sdk.log（stderr，平台采集进 run 日志）
```

- 取数：工具用 `sdk.run('<工具名>', { input })` 调本包或绑定的工具资产子程序。
- 大模型：`await sdk.agent({ skills: [...], input })`，skills 来自控制台绑定的技能资产；**模型凭据平台持有，业务不接触 key**。
- 上下文里有什么、secrets 怎么读、目录约定：查 handbook `bizpkg.development.*`（`agent` / `state` / `tools` / `logging`）与 `bizpkg.layout.runtime-deps`。
- 单测写法与 mock 纪律：查 handbook `bizpkg.development.mock` / `testing`。

### 3.2 契约闸门的职责划分

| 层 | 职责 |
|---|---|
| check-input（平台编排第一阶段） | 机械校验 contract.json input：required 项存在 + 类型；不过则 run 在 check-input 阶段失败（`failed_at=check-input`），main 不会执行 |
| main | 信任输入形状，做业务；业务内可做更宽的业务校验（宽容读，失败走 sdk.fail） |
| check-output（平台编排第三阶段） | 机械校验 main 的 return 值符合 output 契约；不过则 run 失败（`failed_at=check-output`） |

**验证**：写一个缺必填字段的事件样例跑 `tests/check-input.test.ts` 能演示拦截；`npm test` 全绿。

## 4. 本地独立运行调试（开发主循环）

平台 run 和本地 run 跑的是**同一份业务包代码**，中间没有平台私有逻辑；差异只有入口/出口适配（本地用 stub 替代）。因此：**本地跑通是平台上跑通的必要条件**。本地不过，上平台必挂；本地过了，平台侧只剩配置问题（查 `troubleshooting.md`）。

完整命令细节在 `docs/refs/2026-11-09-local-run-guide.md`（不复制）；config.json 每个字段的值去哪找，查 `docs/ai/environment.md`（这是最容易卡住的文件，先读它再动手）。

三步循环：

```bash
# ① 从平台库导出真实事件做回放文件（事件 id 从控制台或 lifecycles 表查）
node packages/local-runner/dist/src/cli.js export-event \
  --db .easemob-agent-workspace/platform/data/platform.db \
  --event-id <evt_xxx> --out .local-run/events/<case>.json

# ② 写好 .local-run/config.json（字段值见 environment.md）

# ③ 本地运行（业务包改动后须先 npm run build）
node packages/local-runner/dist/src/cli.js run \
  --config .local-run/config.json --event .local-run/events/<case>.json
```

- 退出码：0=run 成功；1=业务失败（failed/timeout，看输出里的 RunOutcome 与日志路径）；2=配置/装配非法（错误信息直接指到字段）。
- run 日志在 `workspace/` 派生目录下，终端输出会打印日志路径。
- 上下文等值校验：本地能复现平台 run 后，可用 `diff --config ... --snapshot <平台快照.json>` 对比本地装配的上下文与平台快照（退出码 1=有差异）。

**验证**：本地 run 退出码 0，且 RunOutcome 输出符合 contract.json 的 output 形状。

## 5. 上架：资产登记与业务绑定

控制台逐步操作（点哪个页面、填哪个框）以**本业务的 `平台配置指南.md` 为准**（业务仓根目录，随业务维护）。本节只讲原则与决策点：

### 5.1 资产三条

一个业务包在控制台登记**三条资产**（同一仓库、同一 ref，靠 subpath 区分）：

| kind | subpath 约定 | 共享性 |
|---|---|---|
| package | 包根（含 agent-package.json 的目录） | 不共享 |
| tool | `tools/<工具名>`（叶子级，直指单个工具目录） | 可共享 |
| skill | `skills/<技能名>`（叶子级，直指含 SKILL.md 的技能目录） | 可共享 |

- **ref 即版本钉**：填分支/tag/commit 均可，登记时解析成具体 commit 钉死。非共享资产升版本 = 资产页「更新」填新 ref（asset_id 不变，业务绑定不动）；共享资产不能更新，只能下架重登。
- 本地仓登记可用 `file:///绝对路径`。
- 私有仓库：登记时勾选私有并填 credential_key，凭据值放**通用配置安全桶**（`environment.md` §4）。

### 5.2 创建业务与绑定

- 包绑定后「入口程序」下拉自动加载（选中包后首次物化可能较慢，耐心等）。
- `requires.tools` 声明的工具**必须绑定同名资产**，否则保存被拒。
- 提示词总纲 = 注入给大模型的 system prompt；env / secrets 每个 key 的值去哪找，见 `environment.md` §2~§4。
- 契约字段语义疑问查 handbook `bizpkg.contract.*`，不要凭控制台占位猜。

**验证**：控制台手动触发（或等真实事件），run 状态 success；业务 run 日志路径模板见 `troubleshooting.md` 总表。

## 6. 上下游编排

- **契约即联系**：上游输出契约的字段 = 下游输入契约的字段；上游 run 成功（check-output 通过）后，平台按下游业务的入口关注派生 internal 事件（`event_type = "<上游business_id>.completed"`，信封含 `producer_business_id` 与 hop_count）。
- **平台公平原则：谁消费谁过滤**。上游不知道下游是谁，不过滤；下游对自己的输入负责（例：日志分析只分析 SDK 前端分类的 bug 工单——过滤写在下游 check-input/main，不是上游）。
- 平台对 run 成功的定义 = 三段编排通过；想让下游触发，上游输出必须符合自己的 output 契约。

**验证**：真实链路一次：上游 run success → 下游出现 internal 事件 → 下游 run success。两条 run 日志都拿到即通过。

## 7. 发布前检查清单

- [ ] `npm test` / `typecheck` / `lint` / `format:check` 全绿（六条检查的保障含义查 handbook `bizpkg.development.checks`）
- [ ] 无循环依赖：`npm run circular` 通过
- [ ] `package-lock.json` 已提交
- [ ] 模板占位（your-skill 等）已清理
- [ ] contract.json 与 main 实际 return 形状一致（check-output 会机械复核，但本地先自查）
- [ ] 本地独立运行对真实导出事件通过（§4）
- [ ] 控制台三条资产 ref 钉在**已推送的 commit**（本地未推送的 commit 平台拉不到）
- [ ] secrets 只存在于控制台安全桶与本地 `.local-run/`（gitignored），未写入任何入库文件
- [ ] 本业务 `平台配置指南.md` 与实际配置一致（改了配置就更新它）
