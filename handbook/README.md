# handbook —— 平台文档体系

> 本目录是平台的**产品文档**体系：描述「现在是什么样」。
> 「为什么变成这样」的演进过程记录在 `docs/`（designs / decisions / plans / drafts），两边分工不混。

## 核心机制：单一源，多产物

```
content/   唯一写作区（YAML 源，按命名空间分文件）
   │  yarn docs:gen（handbook/tools/codegen.mjs）
   ▼
generated/ 生成物（提交进 git，禁止手改）
   ├── **/*.md    人看的手册（与 content/ 镜像同构）
   └── **/*.json  程序消费（控制台按此取内容，与 content/ 镜像同构）
```

一条 `content/<路径>/<名>.yaml` 对应生成 `generated/<路径>/<名>.md` 和 `<名>.json`，路径一一对应。

## 三个消费面

| 消费面 | 载体 | 状态 |
|---|---|---|
| 人（开发者/平台维护者） | `generated/**/*.md` | ✅ |
| 控制台（页面说明、tip、抽屉） | `generated/**/*.json` | ✅（console-api 接入另立项） |
| AI（仓库内导览 llms.txt / llms-full.txt） | 生成物第三出口 | 🔜 已预留，后续迭代 |

## 铁律（违反 = CI 红或 review 打回）

1. **ID 只增不废**：条目 `id` 创建后永不修改、永不复用；内容过时走 `status: deprecated`（可选 `related.replaced_by` 指向继任者），条目不删除——控制台与历史文档的旧引用永远有落点。
2. **单一源**：内容只在 `content/` 手写；`generated/` 全部生成、提交、禁止手改。`yarn docs:check`（内存重渲染并与磁盘比对）兜底，双向防漂移——源变了没重新生成、手改了生成物，都会被检出。
3. **引用不复制**：跨条目复用一律 `related.see_also` 引用 ID，body 里不整段搬抄。一个定义只在一个地方。
4. **可验证**：描述「现状」的条目必须填 `verify`（代码路径或测试），review 时人和 AI 都能核对。
5. **语言**：`title` / `body` 为语言字典，`cn` 必填（简体中文为主）；标识符、代码、配置键保持英文且与仓库实际命名一致。

## 写作规则

字段语义、枚举取值、命名空间风格、生命周期——**全部以 [META.md](./META.md) 为准**。
任何人或 AI 编写/修改 `content/` 前必须先读 META.md，不靠猜。

## 工作流

```bash
# 1. 编辑 content/**/*.yaml
# 2. 生成并自检（schema 校验 / ID 查重 / 引用检查）
yarn docs:gen
# 3. 提交 content/ 与 generated/ 两处改动
git add handbook/ && git commit
# CI / 提交前兜底：生成物与源不一致则失败
yarn docs:check
```

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 框架：schema（META.md）+ codegen + docs:check + 目录骨架 | 🚧 本阶段 |
| P1 | 内容：`bizpkg.*`（业务包规范与使用）+ `console.business-edit.*`（控制台业务编辑页） | ⬜ |
| P2 | 内容：`platform.*` 平台机制考古（原料：spec-v3 / dailylog / git log / 代码） | ⬜ |
| 远期 | llms.txt + llms-full.txt 第三出口；console-api 消费 generated json | ⬜ |
