# META —— handbook 元属性规范（作者契约）

> 本文件是编写 `handbook/content/**/*.yaml` 的**唯一规则来源**。
> 任何人或 AI 编写、修改内容前必须先读本文件；codegen（`handbook/tools/codegen.mjs`）按本文件实施机械校验。
> 规则先于实现：要新增枚举值或字段，先改本文件，再改 codegen，最后才能用于内容。

## 1. 文件结构

每个 YAML 文件：

```yaml
version: 1            # 必填，目前恒为 1（结构演进时递增，codegen 按版本解析）
title: 页面标题        # 可选（cn），生成 md 的 H1；缺省用文件名
entries:              # 必填，条目列表（可为空数组）
  - id: ...
```

文件路径即命名空间归属：`content/bizpkg/*.yaml` 内条目的 id 必须以 `bizpkg.` 开头，console、platform 同理。

## 2. 条目字段总表

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | string | 稳定 ID，见 §3 |
| `kind` | ✅ | enum | 条目类型，见 §4 |
| `title` | ✅ | lang-map | `{ cn: "标题" }`，见 §6 |
| `body` | ✅ | lang-map | `{ cn: "markdown 正文" }`，见 §6 |
| `surfaces` | ✅ | list | 消费面声明，见 §5 |
| `status` | 可选 | enum | 生命周期，默认 `stable`，见 §7 |
| `related` | 可选 | map | 引用关系，见 §8 |
| `verify` | 见 §9 | string | 可验证出处（相对仓库根的路径） |
| `name` | field 必填 | string | 字段名（英文标识符） |
| `type` | field 必填 | enum | `string` / `number` / `boolean` / `object` / `array` |
| `required` | 可选 | boolean | 字段是否必填，默认 false |

未在本表出现的字段 = 非法，codegen 报错。

## 3. id 规则（第一铁律）

- 格式：小写点分命名空间，段内 kebab-case：`^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$`；首段必须是已登记命名空间（§10）。
- **id 是逻辑地址，不是标识符本身**：被描述对象的真实标识符若含下划线、冒号等字符（如 `issue_key`、`jira:issue_updated`），id 用 kebab 形式（`issue-key`），真实名字写在 `name` 字段或 body 里。
- **创建后永不修改、永不复用**。内容大改 ≠ 改 id：在原地修订 body 即可；只有「这个概念整体被取代」时才新建条目并将旧条目置 `deprecated`。
- 全局唯一（跨所有 content 文件，codegen 查重）。

## 4. kind 枚举

| kind | 语义 | 渲染 | 额外约束 |
|---|---|---|---|
| `section` | 普通段落/章节 | md 正文小节 | — |
| `field` | 字段级参考（契约/配置项） | md 中带 name/type/required 元信息；json 中结构化 | 必填 `name`、`type` |
| `concept` | 术语定义（会被多处引用） | 同 section | 命名取 `*.concept.<术语>` 为宜 |
| `guide` | 操作指南/流程（步骤性内容） | 同 section | — |

新增 kind：先在本表登记（含语义与渲染约定），codegen 加支持后才可使用。kind 可用于过滤（如「导出所有 field」）。

## 5. surfaces（消费面）

每条目必须声明至少一个 surface。两种形态：

```yaml
surfaces:
  - doc: bizpkg/contract              # 进生成的文档页：<页面路径>[#锚点]
  - console: business-edit.contract   # 进控制台，简写 = display: tip
  - console:                          # 完整写法
      at: business-edit.contract      #   控制台位置：页面.区域（点分 kebab）
      display: drawer                 #   tip | drawer（缺省 tip）
```

- `doc`：字符串，格式 `<页面路径>`（可带 `#锚点`）。页面路径决定条目汇入哪篇生成文档的哪个位置。
- `console.at`：控制台逻辑位置，格式 `页面[.区域[.子区域]]`（点分 kebab，页面级可单段）。控制台按页面聚合取用，或按条目 id 精确取用。
- `display`：
  - `tip` —— 内联提示。操作导向，宜一两句话（风格建议，不机械限制）。
  - `drawer` —— 右侧弹出抽屉。可承载长内容：详细解释、示例、链接。重叠的详细内容进 drawer，不进 tip。
- 同一主题可同时注册 tip 与 drawer 两个条目（如 `…​.tip` 一句话 + `….detail` 抽屉详述），互相 `see_also`。

## 6. 语言（i18n）

`title` / `body` 均为语言字典：

```yaml
title:
  cn: 契约的作用        # 必填
body:
  cn: |                 # 必填，markdown
    ……
  # en: |              # 可选预留；缺省语言回落 cn
```

- `cn` = 简体中文，为必填基准语言（键名定为 `cn`，不再变更）。
- 标识符、配置键、代码片段保持英文，且必须与仓库实际命名一致。
- 生成物包含全部已填语言；消费端按界面语言取值、缺省回落 `cn`。

## 7. status（生命周期）

```
draft（撰写中）→ stable（正式）→ deprecated（已作废）
```

- 缺省 `stable`。
- `deprecated`：条目不删除，body 保留供历史引用；建议同时在 `related.replaced_by` 指向继任条目，并在 body 开头注明作废原因。
- 作废是常态机制：迭代导致细节或架构变化时，旧内容体面退场，引用方（控制台/文档）有迹可循。

## 8. related（引用关系）

```yaml
related:
  see_also: [bizpkg.layout.monorepo]     # 相关条目 id 列表
  replaced_by: bizpkg.contract.v2        # 仅 status=deprecated 时有意义
```

- 只引用、不复制：需要别处内容时用 `see_also`，body 内禁止整段搬抄。
- `see_also` / `replaced_by` 引用的 id 必须存在（codegen 全局校验，悬空引用报错）。

## 9. verify（可验证出处）

- 描述「现状」（机制、行为、字段、配置）的条目**必须**填 `verify`：相对仓库根的代码路径或测试路径，如 `packages/sdk/src/contract.ts`。
- 写「理念/背景」的条目可空。
- `kind: field` 一律必填。
- codegen 检查文件存在性：不存在给 **warning**（代码会移动，不硬卡；但 warning 要在 review 时清零）。

## 10. 命名空间与文体

| 命名空间 | 内容 | 文体约束 |
|---|---|---|
| `bizpkg.*` | 业务包规范与使用（开发者最关心） | 专业、详细：概念 + 机制 + 示例 |
| `console.*` | 控制台页面说明 | 操作导向，一看便知；长内容放 drawer |
| `platform.*` | 平台机制（P2 考古填充） | 机制 + 地图，凡现状必 verify |

新增顶层命名空间：先在本表登记。

## 11. 写作风格（面向人与 AI 的共同约束）

1. **条目自足**：每条独立可理解，禁止「如上所述」「见前文」。
2. **术语唯一**：一个概念一个名字，与 `docs/designs/2026-09-14-skill-platform-spec-v3/design/glossary.md` 的既有定义对齐；冲突时先对齐再写。
3. **标识符精确**：代码符号、配置键、事件类型与仓库实际命名一致。
4. **示例真实**：示例中的工单号、路径、命令必须来自仓库真实存在的事物。

## 12. codegen 校验清单（与本文件一一对应）

**error（阻断）**：schema 未知字段 / id 非法或不唯一 / kind 未知 / title、body 缺 cn / surfaces 为空或格式非法 / field 缺 name、type / see_also、replaced_by 悬空 / 文件路径与 id 命名空间不符。

**warning（不阻断，review 清零）**：`verify` 文件不存在 / deprecated 条目缺 `replaced_by` / `replaced_by` 出现在非 deprecated 条目。
