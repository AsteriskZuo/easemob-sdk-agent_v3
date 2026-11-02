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

pi 内核由 app/server 的 npm 依赖提供，无需在宿主单独安装。

## 快速开始

```bash
yarn install

# 平台工作目录（必填、只能来自环境变量；也可在每条命令前行内指定，见下文示例）
export AGENT_WORKSPACE=/path/to/workspace

# 配置文件：从模板拷贝后编辑（模板含全部键与默认值；replace-with-* 占位必须替换为真实值或整键删除；__ 前缀为逐键说明，解析器自动忽略）
mkdir -p "$AGENT_WORKSPACE/platform"
cp templates/config.json.example "$AGENT_WORKSPACE/platform/config.json"

# 首启注入控制台 admin（仅首个用户创建时需要，成对出现）
export AGENT_ADMIN_USERNAME=admin
export AGENT_ADMIN_PASSWORD=your-initial-password
```

配置文件的所有键均有默认值、按需覆盖。注意 `AGENT_WORKSPACE` 不能写进 config.json——它只从环境变量解析，写进文件会被静默忽略。

大模型配置不在部署配置里：业务的大模型（models.json）在控制台按业务配置（在线验证全部模型 → 确认保存、脱敏回显、经统一更新队列生效不重启），未配置的业务无法使用大模型推理。结构示例见 `templates/models.json.example`。

> pi 内核（`@earendil-works/pi-coding-agent`）版本由 yarn.lock 锁定，`yarn install` 即得。推荐缺省自动解析 CLI；仅在明确需要替换二进制时设置 `AGENT_PI_CLI_PATH`。

### 生产模式（部署运行）

先构建全部 packages 与 app（含 console 产物 `app/console/dist`），再由 server 单进程托管一切（API + 双循环 + 控制台静态文件）：

```bash
yarn build
AGENT_WORKSPACE=$(pwd)/.easemob-agent-workspace \
AGENT_CONSOLE_STATIC_DIR=$(pwd)/app/console/dist \
  yarn workspace @asteriskzuo/agent-server start
# 浏览器访问 http://localhost:6100
```

`start` 读取 `app/server/dist` 与 `packages/*/dist`；修改源码后需重新构建并重启。

### 开发模式（日常调试）

两个进程分开跑。server 直接运行 `app/server/src` 与 `packages/*/src` 并监听变更，无需手动构建；console 由 Vite 提供源码热更新：

```bash
# 终端 1：server 源码模式（纯 API，不托管静态文件）
AGENT_WORKSPACE=$(pwd)/.easemob-agent-workspace yarn workspace @asteriskzuo/agent-server dev

# 终端 2：console 源码模式（/api 自动代理到 localhost:6100；console 不读任何环境变量）
yarn workspace @asteriskzuo/agent-console dev
```

## 数据重置（调试手段）

先停 server，再删数据。workspace 内数据按「五类生命周期 × 两种归属」分根（平台在 `platform/` 下，每个业务在 `businesses/{business_id}/` 下；细则见 `docs/designs/2026-09-14-skill-platform-spec-v3/design/console-design.md` §6）：

| 路径 | 内容 | 删除影响 |
|------|------|---------|
| `platform/data/platform.db` | 全部状态：账号/业务/资产登记/队列/通道/环境配置 | 全量重置（含控制台账号；下次启动需重新注入首启 admin） |
| `platform/cache/` | 资产物化 | 安全，启动或按需重建 |
| `platform/logs/` | 平台三日志 | 安全 |
| `businesses/` | 各业务的数据/缓存/runs/日志 | 安全（业务级持久状态随之丢失，如去重记录） |
| `platform/config.json` | 人工维护的部署配置，可能含模型 API Key | 别删（除非连配置一起重置）；真实文件不进 git，误删可用 `templates/config.json.example` 重建 |

完整重置：**除 `platform/config.json` 外，工作区其余内容可整体删除**。

```bash
rm -rf "$AGENT_WORKSPACE/platform/data" "$AGENT_WORKSPACE/platform/cache" "$AGENT_WORKSPACE/platform/logs" "$AGENT_WORKSPACE/businesses"
```

## 配置项

**所有配置项都归 server；console 不需要任何环境变量**（浏览器 SPA 运行时不读 env；开发模式的 API 代理目标写在 `app/console/vite.config.ts`，生产模式由 server 托管静态文件）。

来源优先级：**环境变量 > `{workspace}/platform/config.json` 同名键 > 代码默认值**（config.json 与环境变量同名、含 `AGENT_` 前缀）。config.json 允许放 `__` 前缀的说明键（解析器一律忽略）——`templates/config.json.example` 即用此方式逐键注释（如 `__AGENT_LOG_LEVEL` 说明该键可选与否与用途）。

### 启动必选项

| 变量 | 来源 | 说明 |
|------|------|------|
| `AGENT_WORKSPACE` | **只能环境变量** | 平台工作目录（数据五类分根的根）；config.json 栖身于 workspace，故不能来自文件 |
| `PATH` / `HOME` | 只能环境变量 | pi 子进程基础环境（pi_env 固定组）；正常 shell 天然存在，一般无需显式设置 |

大模型配置**不归部署配置**：每个业务在控制台「业务编辑页 → 大模型配置区」维护自己的 `models.json`（Pi 原生结构，可配多个 provider 与模型；默认模型 = 第一个 provider 的第一个模型），经「在线验证全部模型 → 确认保存」生效，全部模型真实探针通过才允许保存；未配置的业务调用 `sdk.agent` 会被拒绝（`model_not_configured`）。完整键清单与默认值模板见 `templates/config.json.example`（拷贝后替换占位即用）。业务配置里的 `apiKey` 应使用字面量——Pi 子进程环境只有 PATH/HOME，不能依赖 `$ENV_VAR` 插值读取厂商密钥。

### Pi 路径（可选，推荐默认）

| 变量 | 默认 | 说明 |
|------|------|------|
| `AGENT_PI_CLI_PATH` | 自动解析 npm 依赖的 bin | 显式指定时优先，自检验存在可执行；仅在明确需要替换 Pi 二进制时设置 |

真实 `config.json` 与业务派生的 `models.json`（`businesses/{业务}/cache/pi/agent/`）都可能含密钥，均不得进入 git、日志或管理 API 回显。

### 运行参数（均有默认值，env 或 config.json 均可）

| 变量 | 默认 | 说明 |
|------|------|------|
| `AGENT_CONSOLE_PORT` | `6100` | 管理 API / 控制台端口 |
| `AGENT_HTTP_TIMEOUT_MS` | `30000` | 平台 HTTP 服务（管理 API 与 webhook 入口）统一超时（毫秒），范围 1000–300000 |
| `AGENT_HOP_LIMIT` | `8` | 派生事件 hop 上限（防循环订阅） |
| `AGENT_TASK_CONCURRENCY` | `4` | 入口业务并发闸门 |
| `AGENT_RESULT_CONCURRENCY` | `16` | 出口投递并发闸门 |
| `AGENT_TASK_TIMEOUT_MINUTES` | `60` | 单次业务执行超时（业务可在控制台覆盖） |
| `AGENT_MAX_AGENT_CALLS` | `20` | 单次执行的大模型调用配额（业务可覆盖） |
| `AGENT_LOG_LEVEL` | `info` | 系统日志级别（error/warn/info/debug） |
| `AGENT_LOG_ENABLED` | `true` | 日志总开关 |

### 入口与物化（均有默认值，env 或 config.json 均可）

| 变量 | 默认 | 说明 |
|------|------|------|
| `AGENT_ENTRY_WEBHOOK_ENABLED` | `true` | webhook 入口适配器开关（关闭 = 不创建不启动，完全不检查其配置） |
| `AGENT_ENTRY_JIRA_POLLING_ENABLED` | `false` | jira 轮询入口开关（内部测试与无外网 webhook 场景的拉取入口）；与 webhook 同时开启时被抑制（webhook 优先，记 error 日志、继续运行） |
| `AGENT_WEBHOOK_PORT` | `6200` | webhook 入口适配器监听端口 |
| `AGENT_NPM_REGISTRY` | 官方 registry | 资产物化 `npm ci` 与初始化脚本子进程的 registry（启动自检验可达） |

### 可选增强

| 变量 | 默认 | 说明 |
|------|------|------|
| `AGENT_CONSOLE_STATIC_DIR` | 不设 = 纯 API | 控制台静态产物目录（vite build 输出），设置后 server 同进程托管控制台 |
| `AGENT_ADMIN_USERNAME` / `AGENT_ADMIN_PASSWORD` | 不设 = 不建号 | **控制台唯一建号入口**（平台不开放注册）：users 表为空时创建首个 admin。两键必须成对，只给一个 = 配置解析失败；不注入不影响 server 启动（记 error 日志），但控制台无人能登录，只能下次启动时注入或删 `data/` 重来 |

## 开发一个业务

1. 拷贝 `templates/agent-package/` 为独立 git 仓库，按其中 README 开发流程程序（`@asteriskzuo/agent-sdk`：`sdk.input` / `sdk.runInput` / `sdk.config` / `sdk.agent` / `sdk.run` / `sdk.log` / `sdk.return`）；
2. 把仓库推送到 git（github/gitee 均可），在控制台「资产管理」登记为**包**资产（可复用的子程序/skill 分别登记为**工具**/**skill** 资产，可共享）；
3. 在控制台「业务管理」创建业务：绑定包与流程程序入口、配置入口（触发源）、出口（通知工具）、提示词总纲、key-value 两桶；
4. 事件到达后平台自动调度执行，结果按出口绑定投递；控制台「监控仪表盘」查看任务与运行记录。

业务程序开发约束详见 `docs/designs/2026-09-14-skill-platform-spec-v3/design/asset-model.md`（作者指南）与 `business-workflow.md`（SDK 契约）。

## 仓库结构

```text
├── packages/           # 平台内部库（@asteriskzuo/agent-*；仅 sdk 对外发布 npm）
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
│   ├── agent-service/  # agent 调用服务（unix socket + pi 子进程 + 配额 + 审计）
│   ├── workflow-runner/# 业务子进程运行时（socket 协议平台侧）
│   ├── process-runner/ # 子进程创建唯一实现（超时/取消/输出上限/进程组清理；公共发布，SDK 依赖它）
│   ├── pi-probe/       # 业务 Pi 配置在线验证探针（一次性最小真实调用）
│   ├── sdk/            # @asteriskzuo/agent-sdk（业务程序唯一 SDK）
│   └── console-api/    # 管理 API（HTTP + 账号体系 + 全部管理路由）
├── app/
│   ├── server/         # 平台装配根 + 进程入口
│   └── console/        # 控制台 SPA（React + Vite + antd）
├── templates/
│   ├── agent-package/      # 业务包模板（拷贝即用）
│   ├── config.json.example # {workspace}/platform/config.json 完整模板（全部键 + 默认值 + 占位）
│   └── models.json.example # 业务大模型配置（models.json）的结构示例
├── .easemob-agent-workspace/ # 本地开发约定俗成的 AGENT_WORKSPACE 指向（gitignore；变量必填、无默认值，上文示例命令即指向它）
└── docs/               # 设计/规格/计划/进度（见 docs/README.md）
```

## 文档导航

- 设计骨架：`docs/designs/2026-09-14-skill-platform-spec-v3/`（先读骨架文档，子文档按需深入）
- 实现计划与进度：`docs/plans/2026-09-28-platform-implementation-plan.md` / `...-progress.md`
- 任务规格：`docs/specs/`
- 文档目录约定：`docs/README.md`

## 参与开发

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
