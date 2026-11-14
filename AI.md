# easemob-sdk-agent_v3 — AI 工作入口

> 平台行为验证日期：2026-11-14。本文档给 AI 读；设置和配置，使用者可以交给 AI，项目维护者也可以交给 AI。

## 1. 你是谁（角色路由）

按你要改动的代码在哪个目录判定：

| 你要做的事 | 读什么 |
|---|---|
| 开发/调试**业务包**（主受众） | 本文件 + `docs/ai/` 三篇（开发手册 / 排查手册 / 环境配置） |
| 维护**平台**本身（packages/ 下的包） | `AGENTS.md` + `docs/README.md` |
| 部署运维（安装、启动、网络） | `docs/refs/` 下的部署文档 |

## 2. 必读纪律

1. 你只开发业务包，**不修改 `packages/` 平台代码**；发现平台疑似 bug，停下来向平台维护者报告，不自行绕过
2. 不绕过 check-input / check-output 契约闸门，不为跑通而改宽契约
3. 改动后必须运行业务包验证命令（`npm test`、`npm run typecheck`），并如实贴出结果
4. 引用文件一律用仓库相对路径
5. 修改配置类文件前先备份原值
6. 真实 token/secret **永不写入任何会提交进 git 的文件**（`.local-run/` 含 secrets，已被 gitignore）
7. 排查先看日志再猜，日志路径模板见 `docs/ai/troubleshooting.md`
8. 控制台操作步骤优先读本业务的 `平台配置指南.md`（在业务仓根目录）
9. 契约字段语义查 `handbook/content/bizpkg/contract.yaml`，查不到再上人

## 3. 项目一分钟

环信 SDK Agent 平台：一个平台 + 多个业务包。业务包是**独立 git 仓**，核心四件：`agent-package.json`（清单）、`main`（主程序）、`contract.json`（输入输出契约）、`check-input`/`check-output`（契约闸门程序）。

事件流转：入口适配器（jira 轮询 / webhook）→ 事件队列 → 调度派发 → run（check-input → main → check-output 三段）→ 出口通知（企业微信等）。上游 run 成功可派生 internal 事件触发下游业务，**上下游之间唯一的联系是契约**。

两个样例业务：`jira-ticket-review`（工单审查，有入口适配器）、`sdk-log-analysis`（日志分析，靠上游派生事件触发）。

## 4. 文档地图（业务包开发者）

| 文档 | 什么时候读 |
|---|---|
| `docs/ai/development.md` 业务包开发手册 | 从零开发业务包、上架、编排；**按序照做，每步有验证** |
| `handbook/content/bizpkg/*.yaml` | 开发中查字段语义、目录结构、契约规则（字典式，不从头读） |
| `docs/ai/environment.md` 环境配置说明 | 不知道配置项填什么值时查（config.json / env / secrets / git 账号） |
| `docs/ai/troubleshooting.md` 问题排查手册 | 出问题时按症状查 |
| `docs/refs/2026-11-09-local-run-guide.md` | 本地独立运行调试的细节 |
| 业务仓内 `平台配置指南.md` | 控制台逐步操作（按业务各自维护） |

## 5. 命令速查

```bash
# 业务包内（business/<name>/package/ 目录；node >= 24）
npm test                # 构建 + jest（dist-test 模式），全绿才算过
npm run typecheck       # tsc --noEmit

# 本地独立运行（平台仓根目录；业务包须先 npm run build）
node packages/local-runner/dist/src/cli.js export-event \
  --db .easemob-agent-workspace/platform/data/platform.db \
  --event-id <evt_xxx> --out .local-run/events/<name>.json
node packages/local-runner/dist/src/cli.js run \
  --config .local-run/config.json --event .local-run/events/<name>.json

# 平台状态（平台仓根目录；DB 时间为 UTC，本地 +8）
node --experimental-sqlite -e "const {DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync('.easemob-agent-workspace/platform/data/platform.db',{readOnly:true});\
db.prepare('select * from lifecycles order by rowid desc limit 8').all()\
.forEach(r=>console.log(JSON.stringify(r)))"
tail -40 .easemob-agent-workspace/platform/logs/system.log
```
