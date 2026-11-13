# 资产名称显示与登记粒度约定 spec

日期：2026-11-13
状态：已与用户确认决策，进入实施
背景出处（非必读）：docs/designs/ 下资产管理设计、控制台设计

## 1. 背景与问题

1. **名称不可见**：资产管理页（包/工具/Skill 三 Tab）「名称」列恒渲染 "—"；业务编辑页的包绑定/工具绑定/Skill 绑定下拉，选项 label 直接显示 `ast_` 哈希 id。人无法凭 id 辨认资产。
   根因：`assets` 表只登记资产坐标（url/commit/subpath），名称在 manifest（`agent-package.json` 的 `name` / skill 清单名）里，而列表接口（`AssetMeta`）不返回名称。
   注意：登记流程本身已经物化并解析过 manifest（登记即校验，`asset-registry.ts` register 内 `materialize` + `validateAsset`），名称是现成数据，只是没存没透传。
2. **登记粒度不一致**：skill 资产允许以 `skills` 整目录登记（集合），而 tool 已按 `tools/<名>` 叶子级登记。用户要求统一为**叶子级单个资产**：一个个共享，而非批量共享。

## 2. 决策（用户已确认）

- **D0 入口程序保留可选**：`entry_program` 字段与控制台入口程序下拉**不做修改**。理由：保留「一个包多个 main 入口供业务选择」的灵活性（如不同入口日志等级不同）。本 spec 不触碰该链路。
- **D1 登记时落库名称**：`assets` 表加 `name` 列，登记与版本更新时从 manifest 写入，`AssetMeta` 透出；存量行该列为 NULL。
- **D2 控制台显示名称**：资产管理页名称列与业务编辑页绑定下拉以名称为主、id 短码为辅。
- **D3 粒度为约定而非强制**：tool/skill 叶子级登记写成文档与表单提示；服务端校验须**兼容**叶子级形状（skill 校验支持「根本身含 SKILL.md = 单技能」与「子目录集合扫描」两种形态），但不拒绝集合级登记。
- **D4 存量资产纠正走人工清单**：已按集合级登记的 skill 资产由用户重登为叶子级并改绑定，不在代码内迁移。

## 3. D1 实施细节（asset-registry）

### 3.1 存储迁移

`MIGRATIONS` 数组追加 v3：

```sql
ALTER TABLE assets ADD COLUMN name TEXT
```

- 可空、无默认值：存量行（v3 之前登记）为 NULL。
- `AssetRow` 增加 `name: string | null`；`rowToMeta` 原样透出。

### 3.2 写入点

- **register**（`asset-registry.ts`）：现有「登记即校验」块内 `validateAsset` 已返回 `AssetManifest`（含非空 `name`）。在校验通过后 `UPDATE assets SET name = ? WHERE asset_id = ?` 写入。登记失败的回滚逻辑不变（remove 清行）。
- **updateRef**：重新物化 + 校验后同样刷新 `name`（版本变更名称可能变）。回滚路径（物化失败恢复原 commit）不得写 name。
- **幂等返回路径**（同 id 已存在直接返回既有 meta）：不补写 name，保持「幂等不自动变更」语义；存量 NULL 行靠 D2 的展示回退兜底。

### 3.3 类型契约

```ts
export interface AssetMeta {
  // …既有字段不变…
  /** 清单名（agent-package.json 的 name / skill 清单名）；v3 之前登记的存量行为 null */
  name: string | null;
}
```

- `AssetMeta` 唯一定义点在 `packages/asset-registry/src/asset-registry.ts`；console-api 经 re-export 透传，类型随包发布自动带出，console-api 源码无需改动（子代理须核实 re-export 链确实无冗余本地定义）。
- 不新增 API 端点、不改响应结构（仅在既有 meta JSON 中多一个字段），向后兼容。

## 4. D2 实施细节（控制台 app/console）

- **AssetsPage 名称列**（`AssetsPage.tsx`）：`render` 改为 `row.name ?? "—"`；删除「meta 不含名称」的过期注释。
- **BusinessEditPage 绑定下拉**（`BusinessEditPage.tsx` 的 `assetOptions`）：label 改为名称优先——
  `label = a.name ? `${a.name}（${a.asset_id.slice(0, 8)}）` : a.asset_id`。
  名称可区分时附短码是为了同名资产（不同 url/版本来源）并存时能辨认；用户核心痛点是「只见哈希不见名」，故名称必须在 label 主体位置。
- 既有测试（`assets-page.test.tsx`、`business-form.test.tsx` 等）按新行为更新；为「name 为 null 回退」各补一例断言。

## 5. D3 粒度约定文案

- **登记抽屉 subpath 输入框**（AssetsPage）：`extra` 文案改为按 kind 提示——
  package：「资产根在仓库内的相对路径，缺省 = 仓库根」；
  tool：「建议叶子级：tools/<工具名>，单个工具一个资产，便于按需共享」；
  skill：「建议叶子级：skills/<技能名>，单个技能一个资产，便于按需共享」。
  （按当前 kind 动态渲染。）
- **资产管理页标题 tooltip**：补一句「工具/Skill 建议按单个目录登记（叶子级），共享时他人按个绑定」。
- **handbook**：资产管理相关条目补同样约定（子代理定位 handbook/content 下既有资产管理/控制台条目追加，不新建文件；若无对应条目则只在控制台文案落地，并在交付说明中告知）。

## 6. D4 存量资产处理清单（交付用户，不在代码内迁移）

用户已登记的资产中需纠正的只有 skill 集合资产（tool 已是叶子级，package 本就是整目录单元）：

1. 重新登记 skill 资产：url 不变，subpath 由 `skills` 改为 `skills/sdk-log-analysis`（sdk-log-analysis 仓）/ `skills/jira-ticket-review`（jira-ticket-review 仓），仍开共享。
2. 业务编辑页把对应业务的 Skill 绑定从旧集合资产改指新叶子资产（包/工具绑定不动）。
3. 旧的集合 skill 资产删除（有绑定引用需先解绑；删除会清物化缓存）。
4. 注意：资产 id 由 url+kind+subpath 派生，subpath 变化则 id 变化，属预期。

## 7. 非目标

- 不修改 entry_program 链路（决策 D0）。
- 不拒绝集合级 subpath 登记（兼容旧形态，仅提示约定）。
- 不改资产 id 生成规则、不动 manifest 结构。
- 不回填存量行的 name（NULL 由展示层回退兜底）。

## 8. 验收标准

1. asset-registry 测试全绿，且新增断言：登记后 meta/list 行带正确 name；updateRef 后 name 刷新；存量（v3 前）行 name 为 null 不报错。
2. console-api 测试全绿（响应多 name 字段不破坏既有断言；如有精确快照断言需更新）。
3. console 测试全绿，新增「名称显示」与「null 回退」用例。
4. 五个平台包测试全绿：asset-registry、console-api、registry、runtime、workflow-runner（后三者应无感，作为回归）。
5. dev 手动验证：登记一个资产后，资产管理页名称列显示清单名；业务编辑页下拉显示「名称（短码）」；存量资产名称列回退显示。

## 9. 影响面清单

| 位置 | 改动 |
|---|---|
| packages/asset-registry/src/validate.ts | skill 校验兼容叶子级形态（根含 SKILL.md = 单技能，名 = 目录名） |
| packages/asset-registry/src/asset-registry.ts | MIGRATIONS v3、AssetRow/AssetMeta/rowToMeta、register/updateRef 写 name |
| packages/asset-registry/tests | 新增/更新断言 |
| packages/console-api | 预计仅类型 re-export，无源码改动（需核实） |
| app/console/src/pages/AssetsPage.tsx | 名称列渲染 + 登记抽屉 subpath 提示 + tooltip |
| app/console/src/pages/BusinessEditPage.tsx | assetOptions label |
| app/console/tests | 更新 + 新增用例 |
| handbook/content（如有对应条目） | 粒度约定一句 |
| docs/refs/2026-11-09-local-run-guide.md | 无需改动（本地 config 与资产登记无关） |

任务依赖：D1（asset-registry）先行合入后 D2 前端才有 name 数据；但前后端代码可并行开发，联调以 D1 为准。单 commit 提交（项目惯例，由主代理在验收后统一提交）。
