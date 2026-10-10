# T25 spec：event_type 留空通配 + 创建页草稿与随建环境配置

- **日期**：2026-10-10
- **状态**：已实现（2026-10-10，用户确认两点方案后落地；随建 env 为实现路径上发现并经用户知悉的连带决策）
- **决策来源**：2026-10-10 讨论结论——① event_type 不做下拉枚举，改为「留空 = 不过滤（接收该来源全部事件），填写 = 精确过滤」；② 创建业务被占位校验 fail-fast 拦截后，表单草稿本地保留；③（实现路径上发现的连带问题）创建时业务级环境配置随请求一并提交，解决"业务级 secrets 需要 business_id、而 id 要创建成功才有"的死锁

## 1. 背景

- **event_type 必填的痛点**：匹配行不填 event_type 现在直接报错。但很多业务就想接收某来源的全部事件（ webhook 推送、jira 轮询产出），强制填写逼用户编造一个标签。下拉枚举方案在讨论中被否：polling/webhook 适配器的 event_type 只是行配置贴的标签，不存在"能力以外的事件"，伪约束反而误导。
- **草稿的痛点**：T24 的保存时占位校验（fail-fast）生效后，用户忘记先配 key-value 时创建失败、整页白填。
- **连带死锁**：fail-fast 要求占位 key 已存在；业务级环境配置挂在 business_id 下，新业务还没有 id——业务级 key 在创建前无处可配，只能全局桶绕路。

## 2. 范围

**做**：

- registry：`match(source, event_type)` 增加通配语义——除精确命中外，同时返回该 source 下 `event_type = ""`（留空）的行
- console-api：匹配行 `event_type` 改为可选（缺省/空串 = 通配）；POST /api/businesses 请求体新增可选 `env`（随建环境配置）
- entry-adapters：适配器产出信封的 event_type 在行配置为空时落具体默认值（信封契约 event_type 非空不变）
- console：MatchEditor 的 event_type 改可选 + 引导文案；创建页 localStorage 草稿；创建页「随业务一并创建的环境配置」折叠区；校验失败提示带环境配置入口引导
- 文档回写与测试

**不做（范围外）**：

- event_type 下拉/AutoComplete 推荐值（讨论中明确否决：无真实枚举约束的 source 不做伪下拉）
- webhook 从 body 提取 event_type 的 `event_type_key` 字段（暂不需要：同 path 同标签足够；将来有需求再加）
- 编辑已有业务页的草稿（已有服务端数据，草稿引入新旧冲突）
- PATCH 更新路由的随建 env（业务已存在，走既有环境配置页即可）

## 3. event_type 通配

### 3.1 语义

- 匹配行 `event_type` 留空（存储为 `""`）= **通配**：该 source 的任何事件都触发本业务
- 填写 = 精确过滤（现状不变）
- `UNIQUE(business_id, source, event_type)` 约束不变：一个业务对同一 source 至多一条通配行

### 3.2 registry 改动（packages/registry）

`match(source, event_type)` 返回：精确键 `source__{event_type}` 的行 ∪ 通配键 `source__` 的行（去重——同一行不会同时命中两键，无需额外处理）。内存视图键规则不变。

### 3.3 适配器默认值（信封 event_type 必须非空，契约不动）

| 适配器 | 行 event_type 为空时的产出值 |
| ------ | ---------------------------- |
| jira-polling | `"jira.issue.updated"`（eventDoc 注明：轮询不区分原生事件类型，留空时的默认标签） |
| webhook | `"webhook.event"`（eventDoc 注明；推送方要区分类型就拆 path） |

poller 键 `business_id::event_type` 中空串合法（`"b1::"`），对账逻辑不变。

### 3.4 console-api 改动

- `routes-businesses.ts` 三处 `requireNonEmptyString(body.event_type, ...)` 改为可选：缺省/`""` 一律落 `""`；非空时仍是字符串校验
- `dto.ts` 的 `event_type: string` 注释更新（留空 = 通配）

### 3.5 console 改动（MatchEditor）

- event_type 输入框不再必填；placeholder 改「留空 = 接收该来源全部事件；填写 = 精确过滤」
- internal 引导逻辑不变（选了上游业务仍自动拼 `{id}.completed`）
- 提交校验删除「event_type 必填」拦截

## 4. 创建页草稿（localStorage）

- 仅**创建页**（BusinessEditPage 新建模式）：表单全量状态（业务名/描述/agent/model/资产绑定/超时覆盖/匹配行/出口配置文本）变化时防抖（500ms）写入 `localStorage["business-create-draft-v1"]`
- 进入创建页检测到草稿 → 恢复 + 顶部提示「已恢复上次未完成的草稿」+「清除草稿」按钮
- 提交成功 → 清除草稿；编辑模式不做草稿
- 敏感性：表单里只有占位文本（`{{key}}`）不含真值，落 localStorage 可接受

## 5. 随建环境配置（解决创建死锁）

### 5.1 契约（POST /api/businesses 请求体新增可选字段）

```jsonc
{
  // …现有字段…
  "env": {                       // 可选；随业务一并创建的环境配置
    "vars":    { "jira_url": "https://…" },
    "secrets": { "jira_password": "…" }
  }
}
```

### 5.2 服务端顺序与回滚（routes-businesses.ts 创建路由）

1. DTO 校验 → 2. `registry.create()`（生成 business_id）→ 3. 写入 `env`（`env.set(businessId, bucket, key, value)` 逐条）→ 4. 占位 key 存在性校验（T24 既有逻辑，此时刚写入的键可见）→ 5. 任一步失败：删除刚写入的全部 env 键 + `registry.remove(businessId)` 回滚，抛错

env 键校验沿用 EnvProvider 既有 key 合法性规则；`env` 缺省 = 现状行为。

### 5.3 console 创建页

- 新增折叠区「环境配置（可选，随业务一并创建）」：两组 key-value 行编辑（普通变量明文 / 安全变量），状态进草稿
- 占位校验失败的错误提示末尾追加引导：「可在下方『环境配置』区补充后重新提交」
- 提交时 `env` 非空才随 body 携带

## 6. 测试

- registry：通配行命中任意 event_type；精确行不误命中其他类型；通配 + 精确共存；持久化重开一致
- console-api：event_type 缺省/空串 → 201 落 `""`；创建带 env → 键落在该业务桶；占位校验失败 → 业务与 env 键都回滚（计数不变）
- entry-adapters：jira 行 event_type 空 → 信封 `"jira.issue.updated"`；webhook 行空 → `"webhook.event"`
- console：草稿写/恢复/成功清除/手动清除；event_type 留空可提交；随建 env 区提交进 body
- 回归：根六连

## 7. 文档回写

- `docs/specs/2026-09-29-t4-registry-spec.md`：match 通配语义
- `docs/specs/2026-10-05-t13-console-api-spec.md`：event_type 可选 + 创建 body env 字段
- `docs/specs/2026-10-07-t14-console-spec.md`：草稿 + 随建 env 区
- `docs/specs/2026-10-08-t21-platform-landability-spec.md`：适配器默认 event_type
- `packages/sdk/README.md`：event_type 通配说明（业务对接文档面）
- 计划文档追加 T25 行；PROGRESS 记录

## 8. 任务依赖

- 依赖：T24（占位校验是草稿/随建 env 的触发场景）
- registry 与 console 可并行；console-api 的 env 字段与 console 的随建区需对齐字段名（本 spec §5.1 即契约）
