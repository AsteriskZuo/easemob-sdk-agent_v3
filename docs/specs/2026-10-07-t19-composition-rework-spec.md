# T19 组合机制回炉 spec

> 日期：2026-10-07
> 状态：待评审
> 定位：本文是执行者的**唯一必读依据**（自包含；不读设计文档也能实施）。设计依据（背景与语义细节）见
> `docs/designs/2026-09-14-skill-platform-spec-v3/design/asset-model.md` §6/§7.1、
> `design/console-design.md` §4、
> `design/business-workflow.md` §2/§3（均已按本批决策更新）。

---

## 0. 背景与目标

真机验证（server + console 实跑）暴露三类问题，本批一次性修复：

1. **工具组合链路断**：`sdk.run('jira-fetch')` 中的程序名没有任何解析机制——stdin 信封从未注入程序名→路径映射，跨仓库工具物化在 `cache/assets/{asset_id}/`（hash 目录），业务代码无从得知路径，跨资产 `sdk.run` 必然失败。
2. **模型名硬编码**：`'qwen3.8max'` 散落在 registry 默认值、console 下拉、设计文档中；且该值缺 provider 前缀，对 pi 而言本就不是合法模型名（models.json 里的合法选择是 `provider/id` 形式，如 `qwen/qwen3.8-max`）。**目标态：平台代码不出现任何具体模型名**，可选集合由部署侧 models.json 驱动。
3. **业务编辑页不可用**：agent/model 下拉硬编码；绑定下拉为空时无任何引导；出口机密项不知道去哪配；叹号提示单薄。

**核心原则**（本批所有改动的统一准绳）：资产的物理路径是平台内部计算结果，业务只有**使用权**（按名调用），没有**管理权**（任何界面/代码都不让业务填路径）；对外暴露的只有 git 引用（url + commit + 子路径）与程序名。

---

## 1. 变更总览

| 包/应用 | 变更 | 任务 |
|---------|------|------|
| `packages/workflow-runner` | `StdinEnvelope`/`RunRequest` 增加 `programs` 字段 | T19a |
| `packages/sdk` | 信封类型同步；`sdk.run` 按名查表解析绝对路径 | T19a |
| `packages/runtime` | `RunContext` 增加 `programs`；ContextLoader 产出全量映射；lifecycle 传递 | T19a |
| `packages/registry` | 去掉 model 硬编码默认；迁移 v3 清理历史行 | T19a |
| `packages/console-api` | `GET /api/config` 返回 `models`/`agents`；业务绑定配置期校验（本批最大新逻辑） | T19a |
| `app/server` | models.json 解析函数；自检增强；configView 扩展 | T19a |
| `templates/agent-package` | README 补「包内程序 vs 共享工具」分工 | T19a |
| `app/console` | 业务编辑页重做（下拉 API 驱动、空资产引导、出口机密项标注、叹号文案、关系说明） | T19b |

执行顺序：**T19a 先行**（console 的表单依赖 console-api 的新 DTO 字段），T19a 验收通过后做 T19b。

---

## 2. T19a：平台侧

### 2.1 workflow-runner：`StdinEnvelope` 增加 `programs`

文件：`packages/workflow-runner/src/contract.ts`、`packages/workflow-runner/src/runner.ts`

- `StdinEnvelope` 增加字段：

```ts
programs?: Record<string, string>; // 程序名→物化绝对路径映射（本包 programs ∪ 绑定工具 programs）；
                                   // 仅平台→流程程序注入，sdk.run 不向子程序传
```

- `RunRequest` 增加字段：`programs: Record<string, string>; // 程序名→物化绝对路径映射（装配根经 ContextLoader 产出）`
- `runner.ts` 组包处（约 112 行）把 `req.programs` 放进信封。
- 现有测试同步：构造 RunRequest 处补 `programs`（可传 `{}`）；新增一条断言「信封携带 programs 映射原样到达业务进程」。

### 2.2 sdk：`sdk.run` 按名查表

文件：`packages/sdk/src/stdin.ts`、`packages/sdk/src/sdk.ts`

- `stdin.ts` 的本地 `StdinEnvelope` 类型同步增加 `programs?: Record<string, string>`（注释与 runner 侧一致）。
- `sdk.ts` 的 `run()` 改造：`program` 参数语义从「路径」变为「程序名」——

```ts
/** 调子程序：program 是程序名（本包 programs ∪ 绑定工具 programs），SDK 从 stdin 信封
 *  注入的 programs 映射（名→物化绝对路径）查表后 spawn——业务按名调用，不接触路径。
 *  名不存在 → 抛错（消息列出全部可用程序名）。对端 ok=false / 异常退出 / 超时 → 抛错 */
run(program: string, args: {...}): Promise<unknown> {
  const env = readStdinEnvelope();
  const path = env.programs?.[program];
  if (path === undefined) {
    const available = Object.keys(env.programs ?? {});
    throw new Error(
      `未知程序名：${program}（可用：${available.length > 0 ? available.join(", ") : "无"}）`,
    );
  }
  return runSubprogram(path, args, sdk.input().workspace);
}
```

- `runSubprogram`（run.ts）签名与行为不变（仍收绝对路径）；它组给子程序的信封**不带** `programs`（工具是叶子，不能再按名组合——物理成立）。
- 测试：名命中 → 正确 spawn（可用临时 JS 文件验证）；名不存在 → 抛错且消息含可用名列表；子程序信封不含 programs（用 mock 程序把收到的信封写出来断言）。

### 2.3 runtime：ContextLoader 产出全量 programs 映射

文件：`packages/runtime/src/context-loader.ts`、`packages/runtime/src/lifecycle.ts`

- `RunContext` 增加：`programs: Record<string, string>; // 程序名→物化绝对路径全量映射（本包 ∪ 绑定工具；runner 注入信封）`
- `ContextLoader.load()`：在现有 `resolved` 数组（包在前、工具随后、skill 最后）上，遍历每个 `ResolvedAsset.programs` 逐键产出 `join(root, rel)` 绝对路径；**同名按数组顺序首个命中**（与 `resolveResource` 同语义；名冲突本应被 console-api 配置期校验拦住，此处为运行时兜底）。`entry_program` 的既有解析逻辑不变（其命中结果仍在 `program` 字段）。
- `lifecycle.ts` 第 113 行 `runner.run({...})` 增加 `programs: ctx.programs`。
- 测试：绑定一个包（2 个 programs）+ 一个工具（1 个 program）的夹具，断言 `programs` 映射含全部 3 个键且值为绝对路径；同名键断言首个命中语义。

### 2.4 registry：去 model 硬编码默认

文件：`packages/registry/src/business-registry.ts`

- `CreateBusinessInput.model` 注释改为「缺省 ''（空串 = 未选择；registry 层机械存储，必选校验归控制台表单）」。
- `create()` 两处 `input.model ?? "qwen3.8max"` → `input.model ?? ""`。
- `BusinessProfile.model` 注释去掉「MVP 仅 qwen3.8max」，改为「provider/id 形式（如 qwen/qwen3.8-max）；可选集合由部署侧 models.json 决定」。
- **迁移纪律：已有迁移（v1/v2）一个字节都不能改。** 新增迁移 v3：

```sql
UPDATE businesses SET model = '' WHERE model = 'qwen3.8max';
```

  注释说明：清理历史默认填入行（旧值缺 provider 前缀，本就不是合法模型名）；schema 里 v2 的 `DEFAULT 'qwen3.8max'` 是死代码（INSERT 恒显式给值），保留不改、在 v3 注释里说明。
- 测试更新：既有「缺省 create → model 为 'qwen3.8max'」断言改为 `''`；新增迁移测试：v2 老库（含 'qwen3.8max' 行）升级后该行 model 变 `''`。

### 2.5 console-api：config 视图扩展 + 业务绑定配置期校验

文件：`packages/console-api/src/dto.ts`、`routes-config.ts`、`routes-businesses.ts`、`server.ts`（或 index 装配处）

**a) config 视图**：

- `EffectiveConfigView` 增加两字段：

```ts
/** 可选大模型列表（provider/id 形式）：server 启动时解析 pi_agent_dir/models.json 所得全量 */
models: string[];
/** 可选 agent 内核列表（MVP 恒 ['pi']） */
agents: string[];
```

- `routes-config.ts` 无需改（`GET /api/config` 原样回显视图）。
- `CreateBusinessBody.model` 注释改为「provider/id 形式；缺省 '' = 未选择（console 表单必选，API 不强制但做合法性校验，见下）」。

**b) 业务绑定配置期校验（新增，本批最大逻辑块）**：

`businessRoutes` 的 deps 从 `{ registry }` 扩为 `{ registry, assets, env, config }`（`assets: AssetRegistry`、`env: EnvProvider`、`config: EffectiveConfigView`——models/agents 校验用）。`server.ts`/`index.ts` 装配处同步传参（装配层已有全部实例）。

POST `/api/businesses` 与 PATCH `/api/businesses/:id` 在落库前执行以下校验，**任一不过 → 400 `invalid_input`，消息列出全部问题**（不遇一错即停）：

1. **触发条件**：create 时若带了任一绑定字段（`package_asset_id`/`tool_asset_ids`/`skill_asset_ids`/`entry_program`）；patch 时仅当 patch 中出现任一绑定字段。**patch 不涉及绑定字段时零校验、零物化**（改个 prompt 不应触发 git clone）。
2. **生效绑定集合**：patch 场景 = 既有 profile 的绑定与 patch 覆盖合并后的结果。
3. **资产存在性与取用**：对生效集合中的每个 asset_id 调 `assets.get(asset_id, { credential })`——不存在/物化失败/清单校验不过 → 收集为问题。凭据解析与资产登记接口同约定：`is_private` 资产从**通用层安全桶**取 `env.getFor("").secrets[credential_key]`，取不到 → 问题（提示先去通用配置安全桶登记该 credential_key）。**此步顺带落实「业务初始化物化」**：get 内部即物化，配置期 fail-fast。
4. **绑定权限**：package 资产的 `owner_id` 必须 = 操作者 user_id（包不共享）；tool/skill 资产必须 `owner_id` = 操作者 或 `shared = true`。违反 → 问题。admin 也不例外（admin 对资产只读，不替成员持有绑定）。
5. **entry_program 合法性**：绑定集合含包且指定了 `entry_program` 时，必须是该包清单 `programs` 的键。
6. **程序名查重**：包 programs 键 ∪ 各工具 programs 键，重复 → 问题（报出冲突名与来源资产）。
7. **skill 名查重**：各 skill 集合技能名并集查重，重复 → 问题。
8. **requires 覆盖**：包清单 `requires.tools` 的每个名字 ∈ 绑定工具 programs 键并集；`requires.skills` 的每个名字 ∈ 绑定 skill 技能名并集。缺 → 问题（报出缺绑名）。
9. **model/agent_kind 合法性**（与绑定无关，create/patch 均执行）：字段出现且非空时，`model ∈ config.models`、`agent_kind ∈ config.agents`，否则 → 问题（消息列出可选集合）。

校验逻辑抽成 `routes-businesses.ts` 内的局部函数（或同目录新文件 `binding-validation.ts`），保持路由函数薄。注意 `assets.get` 是**同步**接口且可能触发 git clone——管理 API 的单线程事件循环会被阻塞，本版接受（配置期低频操作；在代码注释里写明这一已知代价）。

**c) 测试**：存在性/权限/entry_program/程序名查重/skill 名查重/requires 缺绑/model 非法/agent_kind 非法 各一条；「patch 只改 prompt 不触发校验」一条（用会抛错的 assets stub 证明未被调用）；「全部合法 → 通过且物化发生」一条。资产用本地临时 git 仓库夹具（routes-assets 的既有测试同法，可复用其模式）。

### 2.6 server：models.json 解析 + 自检增强

文件：`app/server/src/models.ts`（新建）、`self-check.ts`、`bootstrap.ts`

- **新建 `models.ts`**：

```ts
/** 解析 pi 的 models.json（{pi_agent_dir}/models.json），产出可选模型全量列表（provider/id 形式）。
 *  结构非法（非 JSON / providers 非对象 / 无任一 provider 含非空 models 数组）→ 抛错（消息说明原因） */
export function loadModelList(piAgentDir: string): string[];
```

models.json 结构（pi 原生格式，模板见 `templates/models.json.example`）：

```jsonc
{ "providers": { "<provider>": { "baseUrl": "...", "api": "...", "apiKey": "...", "models": [{ "id": "<model-id>" }] } } }
```

  解析规则：遍历 `providers` 每个键值对，对其 `models` 数组的每项取 `id`，产出 `${provider}/${id}`；**不读、不记、不回显 apiKey**（它只属 pi 子进程）。任一 provider 的 `models` 为空数组或缺 `id` 字段 → 跳过该项不算错，但最终全平台列表为空 = 抛错。
- `self-check.ts` ④ 增强：在「models.json 是文件」之上，调 `loadModelList` 验证可解析且非空，失败原因进 `failures`。
- `bootstrap.ts`：自检通过后 `const models = loadModelList(config.pi_agent_dir)`（自检已保证合法，此处必成功）；`configView` 增加 `models` 与 `agents: ["pi"]`（字面量，注释：新内核 = 代码新增 + 此处登记）。
- 测试：models.ts 单测（合法多 provider / 非法 JSON / 空 providers / 全部空 models / 缺 id 跳过）；self-check 增强用例；bootstrap 集成测试断言 configView 携带 models/agents。

### 2.7 包模板 README 补充分工说明

文件：`templates/agent-package/README.md`

补一节「包内程序 vs 共享工具」：

- 包内程序（本仓库 `programs` 声明的）：同仓库路径可知，**可直接 import 进程内调用**（首选，零进程开销），也可 `sdk.run('名')` 走子进程隔离（需要隔离/限时时用）——包自由掌握；
- 共享工具（控制台绑定的工具资产）：**只能 `sdk.run('名')` 按名调用**——跨仓库，物理路径由平台注入（stdin 信封 `programs` 映射），SDK 按名查表；业务代码永远不写路径；
- 名唯一性：绑定时平台查重，重复拒绝；包清单 `requires` 声明的外部引用名必须在绑定中覆盖。

---

## 3. T19b：console 业务编辑页重做

文件：`app/console/src/pages/BusinessEditPage.tsx`（主），必要时新增小组件。全部数据经既有 `apiFetch` 通道；样式沿用 antd 既有用法，不引新依赖。

### 3.1 agent/model 下拉 API 驱动

- 页面加载时请求 `GET /api/config`（`EffectiveConfigView`，T19a 后含 `agents`/`models`），两个 Select 的 options 由其驱动；**删除全部硬编码**（约 385/386/415/421 行的 `'pi'`/`'qwen3.8max'` 固定项与 initialValues）。
- 创建模式：`agent_kind` 默认选中 `agents[0]`；`model` **必选、无默认选中**（placeholder「请选择模型」，表单 rules required）——模型没有部署无关的合理默认，必须用户显式选。
- 编辑模式：回显 profile 原值；若原值不在可选集合（models.json 后来改了），保留显示并标黄提示「该模型已不在可选列表」。

### 3.2 空资产引导

包/工具/skill 三个绑定 Select 的数据源（`/api/assets?kind=...`）为空时，表单项下方渲染引导文案 + 跳「资产管理」页的链接（react-router Link）：

- 包：「还没有可用的包资产。包是业务代码单位（恰好绑定一个），先去资产管理登记。」
- 工具：「没有可绑定的工具资产（可选项）。工具是可共享的子程序，sdk.run 按名调用。」
- skill：「没有可绑定的 skill 集合（可选项）。skill 是给大模型的能力，sdk.agent 按名注入。」

### 3.3 出口机密项标注

出口表单按 `configSchema` 渲染时，对 `secret: true` 的项：

- 标注其安全桶键名 `exit.{kind}.{field.key}`（键规则的全平台唯一定义处在 server 侧 exit-driver，console 按同一规则拼接展示）；
- 显示「已配置 / 未配置」状态：数据源 = 该业务 `GET /api/env/businesses/:id` 响应的 `secret_keys`（创建模式业务未存在 = 全部「未配置」，文案提示「保存业务后到环境配置里写该键」）。

### 3.4 叹号文案重写

业务编辑页每个资料模块的叹号提示统一按三段式重写：**是什么 / 何时用 / 配错的后果**。至少覆盖：业务名称、包绑定（含入口程序）、工具绑定、skill 绑定、agent、大模型、入口（三种各一段）、出口、提示词总纲、关注（匹配行）、失败传播、超时与配额覆盖、key-value 两桶。文案用 plain 中文，每条不超过 3 句。

### 3.5 资料关系说明

包绑定模块附近放一段说明（antd Alert type=info 或 Typography.Paragraph type=secondary）：

> 包 = 业务代码单位，提供流程程序入口（平台每次执行 spawn 它）与包内程序；工具 = 可共享的子程序，包代码用 sdk.run('程序名') 调用；skill = 给大模型的能力集合，sdk.agent 按名注入。工具与 skill 可绑多个（自己的 + 他人共享的），名冲突会被拒绝。

### 3.6 测试

- 下拉由 `/api/config` 响应驱动（mock 两个模型，断言 options 渲染且无硬编码项）；
- model 未选提交 → 表单校验拦截；
- 空资产数组 → 引导文案出现；
- secret 项渲染键名标注与已配置状态（mock secret_keys 含/不含各一条）。

---

## 4. 验收

每个任务完成后执行根六连（仓库根）：

```bash
yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular
```

全绿为准（dpdm 对 exit-tools 的 skip warning 是既有噪音，exit 0 即过）。console 测试较慢（约 2 分钟）是既有特性。

## 5. 依赖关系

```
T19a（平台侧：runner/sdk/runtime/registry/console-api/server/模板）
  └─→ T19b（console 编辑页；依赖 T19a 的 EffectiveConfigView 新字段与绑定校验 API 行为）
```

## 6. 不做项（本批明确不做）

- Aibot 连接器、webhook 入口（T18 另行讨论）；
- 绑定校验的异步化（同步 get 阻塞事件循环的已知代价，本版接受）；
- console 其他页面的改版（本批只动业务编辑页）；
- models.json 的热更新（改了重启 server）；
- pi `--model` 传参链路的改动（pi-runner 原样传 `model` 字符串，行为不变——变化的是值的来源）。
