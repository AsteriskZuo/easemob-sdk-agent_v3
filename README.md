# 智能体平台（easemob-sdk-agent_v3）

内部工具平台：**接收外部事件 → 调度业务程序（大模型推理）→ 投递结果通知**。业务以代码承载（代码即流程），平台负责接入、调度、投递、监控，业务开发者专注 skill 与流程逻辑。

## 平台能力

- **双事件循环**：入口循环承载业务执行（大模型推理等耗时任务），出口循环承载结果通知（企微/邮件/jira/confluence/github 等投递）——两循环各自独立并发上限，耗时业务不堵通知；
- **业务 = 包 + 配置**：业务代码（流程程序 + 独立工具 + skill + 总纲提示词）托管在 git 仓库，控制台登记为资产并绑定成业务；平台 spawn 子进程执行业务程序，大模型调用经内置 agent 服务（pi）；
- **控制台**：浏览器控制台是平台唯一的配置生产入口——账号、业务、资产、环境配置（普通/安全两桶）、出口工具、运行监控；
- **稳定优先**：单进程模块化单体，SQLite 持久化（落库才算收到），崩溃恢复，业务错误不影响平台运行。

## 环境要求

- Node.js ≥ 24（使用 `node:sqlite` 等内置模块）
- Yarn 4.14.1（仓库已钉 `packageManager`，启用 corepack 即可）
- git（资产物化依赖）
- pi CLI（大模型 agent 内核，业务执行必需）

## 快速开始

```bash
yarn install
yarn build        # 构建全部 packages 与 app（含 console 产物 app/console/dist）

# 配置（必填项见下表）
export AGENT_WORKSPACE=/path/to/workspace
export AGENT_PI_CLI_PATH=/path/to/pi
export AGENT_PI_AGENT_DIR=/path/to/pi-agent-dir   # 内含 models.json（模型凭据，模板见 templates/models.json.example）

# 首启注入控制台 admin（仅首个用户创建时需要，成对出现）
export AGENT_ADMIN_USERNAME=admin
export AGENT_ADMIN_PASSWORD=your-initial-password
```

### 生产模式（部署运行）

server 单进程托管一切（API + 双循环 + 控制台静态文件）：

```bash
AGENT_CONSOLE_STATIC_DIR=$(pwd)/app/console/dist yarn workspace @easemob/agent-server start
# 浏览器访问 http://localhost:6100
```

### 开发模式（日常调试）

两个进程分开跑，前端热更新：

```bash
# 终端 1：server（纯 API，不托管静态文件）
yarn workspace @easemob/agent-server start

# 终端 2：console dev server（/api 自动代理到 localhost:6100）
yarn workspace @easemob/agent-console dev
```

## 数据重置（调试手段）

先停 server，再删数据。workspace 内数据按生命周期五类分根（细则见 `docs/designs/2026-09-14-skill-platform-spec-v3/design/console-design.md` §6）：

| 路径 | 内容 | 删除影响 |
|------|------|---------|
| `data/platform.db` | 全部状态：账号/业务/资产登记/队列/通道/环境配置 | 全量重置（含控制台账号；下次启动需重新注入首启 admin） |
| `cache/` | 资产物化、仓库克隆、agent 会话 | 安全，自动重建 |
| `runs/` | 业务执行临时数据 | 安全 |
| `logs/` | 日志 | 安全 |
| `config.json` | 人工维护的配置兜底 | 别删（除非连配置一起重置） |

完整重置：

```bash
rm -rf "$AGENT_WORKSPACE/data" "$AGENT_WORKSPACE/cache" "$AGENT_WORKSPACE/runs" "$AGENT_WORKSPACE/logs"
```

## 配置项

优先级：**环境变量 > `{workspace}/config.json` 同名键 > 代码默认值**。`AGENT_WORKSPACE` 只能来自环境变量。

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `AGENT_WORKSPACE` | 是 | — | 平台工作目录（数据五类分根的根） |
| `AGENT_PI_CLI_PATH` | 是 | — | pi 可执行文件绝对路径 |
| `AGENT_PI_AGENT_DIR` | 是 | — | pi 的 models.json 所在目录（模型凭据由它承载；模板见 `templates/models.json.example`，apiKey 支持 `$ENV_VAR` 环境插值） |
| `AGENT_CONSOLE_PORT` | 否 | `6100` | 管理 API / 控制台端口 |
| `AGENT_CONSOLE_STATIC_DIR` | 否 | 不托管 | 控制台静态产物目录（vite build 输出） |
| `AGENT_ADMIN_USERNAME` / `AGENT_ADMIN_PASSWORD` | 否 | — | 首启注入首个 admin（成对；仅 users 表为空时生效） |
| `AGENT_HOP_LIMIT` | 否 | `8` | 派生事件 hop 上限（防循环订阅） |
| `AGENT_TASK_CONCURRENCY` | 否 | `4` | 入口业务并发闸门 |
| `AGENT_RESULT_CONCURRENCY` | 否 | `16` | 出口投递并发闸门 |
| `AGENT_TASK_TIMEOUT_MINUTES` | 否 | `60` | 单次业务执行超时（业务可在控制台覆盖） |
| `AGENT_MAX_AGENT_CALLS` | 否 | `20` | 单次执行的大模型调用配额（业务可覆盖） |
| `AGENT_LOG_LEVEL` | 否 | `info` | 系统日志级别（error/warn/info/debug） |
| `AGENT_LOG_ENABLED` | 否 | `true` | 日志总开关 |

## 开发一个业务

1. 拷贝 `templates/agent-package/` 为独立 git 仓库，按其中 README 开发流程程序（`@easemob/agent-sdk`：`sdk.input` / `sdk.runInput` / `sdk.config` / `sdk.agent` / `sdk.run` / `sdk.log` / `sdk.return`）；
2. 把仓库推送到 git（github/gitee 均可），在控制台「资产管理」登记为**包**资产（可复用的子程序/skill 分别登记为**工具**/**skill** 资产，可共享）；
3. 在控制台「业务管理」创建业务：绑定包与流程程序入口、配置入口（触发源）、出口（通知工具）、提示词总纲、key-value 两桶；
4. 事件到达后平台自动调度执行，结果按出口绑定投递；控制台「监控仪表盘」查看任务与运行记录。

业务程序开发约束详见 `docs/designs/2026-09-14-skill-platform-spec-v3/design/asset-model.md`（作者指南）与 `business-workflow.md`（SDK 契约）。

## 仓库结构

```text
├── packages/           # 平台内部库（@easemob/agent-*，不对外发布）
│   ├── contracts/      # 事件信封、channel_id、校验器（零依赖）
│   ├── database/       # SQLite 薄封装，全平台唯一数据访问口
│   ├── queue/          # 持久任务队列（入口/出口双实例）
│   ├── registry/       # 业务注册表 + 入口匹配 + 出口绑定
│   ├── channel/        # ChannelPool/Channel + 会话映射
│   ├── logger/         # 日志全局外观（ConsoleLike 底层 + 脱敏）
│   ├── env/            # 环境变量唯一读取口
│   ├── scheduler/      # 入口/出口双调度循环 + 并发闸门
│   ├── runtime/        # Lifecycle 四步时序 + 上下文组装 + 两桶环境配置
│   ├── asset-registry/ # 资产注册表（包/工具/skill：git 登记/物化/校验）
│   ├── exit-tools/     # 出口工具群（企微×2/邮件/webhook/jira/confluence/github）
│   ├── agent-service/  # agent 调用服务（unix socket + spawn pi + 配额 + 审计）
│   ├── workflow-runner/# 业务子进程运行时（spawn + socket 协议平台侧）
│   ├── sdk/            # @easemob/agent-sdk（业务程序唯一 SDK）
│   └── console-api/    # 管理 API（HTTP + 账号体系 + 全部管理路由）
├── app/
│   ├── server/         # 平台装配根 + 进程入口
│   └── console/        # 控制台 SPA（React + Vite + antd）
├── templates/
│   ├── agent-package/      # 业务包模板（拷贝即用）
│   └── models.json.example # pi 模型凭据模板（复制到 AGENT_PI_AGENT_DIR 改名为 models.json）
├── workspace/              # 本地开发建议的 AGENT_WORKSPACE 指向（gitignore；注意：变量无默认值、必填，这只是约定俗成的本地目录）
└── docs/               # 设计/规格/计划/进度（见 docs/README.md）
```

## 文档导航

- 设计骨架：`docs/designs/2026-09-14-skill-platform-spec-v3/`（先读骨架文档，子文档按需深入）
- 实现计划与进度：`docs/plans/2026-09-28-platform-implementation-plan.md` / `...-progress.md`
- 任务规格：`docs/specs/`
- 文档目录约定：`docs/README.md`

## 参与开发

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
