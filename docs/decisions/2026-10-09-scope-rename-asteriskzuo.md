# 决策：npm 发布前缀改为 @asteriskzuo

- **日期**：2026-10-09
- **状态**：已执行
- **关联**：`2026-10-08-package-scope-rename.md`（@easemob → @asterisk 的历史记录，原文保留不改）

## 背景

T20 将包前缀定为 `@asterisk`，但首次 `npm publish` 失败（E404：scope 无权限）。原因：npm 的 scope 必须是发布者的**用户名或其创建的 org**，而实际 npm 账号是 `asteriskzuo`（`npm whoami` 实证），`@asterisk` 不属于该账号。

## 决策

全部包名 `@asterisk/*` → `@asteriskzuo/*`，机制与范围同 T20（机械全量替换）：

- 所有 `packages/*/package.json`、`app/*/package.json` 的 name 与内部依赖引用（精确版本号 `0.1.0`，yarn workspace 解析）
- 模板 `templates/agent-package/`、校验脚本 `scripts/verify-template.sh`、业务仓 `business/jira-ticket-review/`（独立仓单独提交）
- 全部现行文档（sdk README、jira-client README、设计文档、计划/进度）同步替换；历史 spec 文档一并替换保持口径一致，**唯一例外**是 T20 决策文档本身（它是那次改名的历史记录，改写即伪史）
- `yarn.lock` 由 `yarn install` 重新生成

## 影响与纪律

- 发布动作不变：`cd packages/sdk && npm publish`、`cd packages/jira-client && npm publish`（包名已是 `@asteriskzuo/*`）
- 业务包依赖声明同步变为 `@asteriskzuo/agent-sdk@^0.1.0`（模板与 business 仓已改）
- 今后再改前缀只需本账号能控制的 scope，或先在 npm 创建对应 org 再改
