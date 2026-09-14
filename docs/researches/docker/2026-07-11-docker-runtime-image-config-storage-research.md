# Docker 运行环境调研

日期：2026-07-11

## 背景

当前架构草稿把 Docker 服务作为多业务场景 Task Runner 的运行底座：

```text
Docker 服务
├── Trigger Layer
├── Task Router
├── Context Builder
├── Runtime Adapter
│   └── Codex CLI
├── Skill / Tool Resolver
├── Result Handler
└── Task Store / Log
```

本次调研只回答第一版落地前的 Docker 基础问题：

1. 运行镜像应该选官方 Node 镜像，还是完全自建镜像。
2. Node + TypeScript + Codex CLI + Git 这类运行环境需要哪些基础工具。
3. 环境变量很多时，能否用配置文件集中管理。
4. 配置文件、密钥、Codex 状态、任务日志和仓库工作区如何挂载。

不在本次调研中决定最终 Compose 文件、CI 发布流程或线上部署平台。

## 调研结论

推荐第一版使用官方 `node:<major>-bookworm-slim` 作为基础镜像，再构建项目自己的运行镜像。

当前建议：

```text
优先方案：node:24-bookworm-slim
保守过渡：node:22-bookworm-slim
不推荐：node:alpine
不推荐：node:latest / node:current / 未固定 major 的 node:slim
```

原因：

- 本项目 `package.json` 声明 `node >= 22`，Node 22 可以满足当前最低要求。
- Node 24 当前是 Active LTS，维护周期更长，适合作为新服务的长期基线。
- Debian `bookworm-slim` 比默认 Node 镜像小，同时保留 glibc 生态，适合 Codex CLI、Git、SSH、native Node 依赖和企业内网 CA 等场景。
- Alpine 更小，但使用 musl libc。官方 Node Docker 文档明确说明 Alpine 不是 glibc，Debian/glibc 应用可能不能直接运行；这会给 Codex CLI、native addon、企业内网工具链带来额外不确定性。
- 默认 `node:<version>` 镜像基于 `buildpack-deps`，包含大量常见包，便利但偏大；本项目目标是“镜像小但够用”，因此更适合从 `slim` 开始按需安装。

第一版运行镜像应该安装的系统工具尽量少：

```text
ca-certificates
curl
git
openssh-client
tini
```

可选但不默认安装：

```text
bash
python3
make
g++
```

这些只应在实际依赖、MCP server、测试命令或 Codex CLI 明确需要时加入。不要为了“以后可能调试方便”把编辑器、完整 build-essential、大量语言运行时放进基础镜像。

## 资料依据

### Docker 官方建议

Docker build best practices 明确建议：

- 选择可信来源的基础镜像。
- 优先使用 Docker Official Images / Verified Publisher 等可信镜像。
- 基础镜像要匹配需求并尽量小。
- 使用 multi-stage build，把构建阶段和运行阶段分离，最终镜像只保留运行所需文件。
- 使用 `.dockerignore` 排除和镜像构建无关的文件。
- 不安装不必要的软件包。
- 需要定期重建镜像获取安全更新。
- 可以固定 base image major/tag；如需供应链强一致性，再进一步 pin digest。

Docker Compose 环境变量文档明确建议：

- 可以通过 `environment` 设置容器环境变量。
- 可以通过 `env_file` 加载 `.env` 文件，避免 Compose 里写很长的环境变量块。
- 不要用环境变量传递密码等敏感信息，应使用 secrets。

Docker Compose secrets 文档明确说明：

- secret 是不应该放进 Dockerfile 或源代码的密码、证书、API key 等数据。
- Compose secrets 会以文件形式挂载到容器 `/run/secrets/<secret_name>`。
- 服务必须显式声明 `secrets` 才能访问对应 secret。

Docker volumes 文档明确说明：

- volume 是 Docker 管理的持久化数据存储。
- volume 生命周期独立于容器，容器删除后 volume 仍保留。
- volume 通常比直接写容器 writable layer 更适合持久化数据。
- 如果需要宿主机直接访问文件，则 bind mount 更合适。

### Node 官方镜像事实

Node Docker 官方镜像由 Node 社区维护，是 Docker Official Image。

官方镜像说明中关键事实：

- `node:<version>` 是默认镜像，基于 `buildpack-deps`，包含较多常用 Debian 包，体积较大但方便。
- `node:<version>-slim` 只包含运行 Node 所需的最小包，适合需要控制体积的场景。
- `node:alpine` 更小，但 Alpine 使用 musl libc，不是 Debian 使用的 glibc；为 Debian/glibc 构建的应用可能不能直接运行。
- `node:alpine` 默认不包含 `git`、`bash` 等工具。
- 生产应用应使用 LTS 版本。

Node release schedule 当前显示：

```text
Node 22: LTS，维护到 2027-04-30
Node 24: LTS，维护到 2028-04-30
Node 26: 已发布，但 2026-10-28 才进入 LTS
```

因此，2026-07-11 时不建议第一版使用 Node 26 作为生产基线。

### Codex CLI 容器运行相关事实

Codex manual 说明：

- `CODEX_HOME` 默认是 `~/.codex`。
- `CODEX_HOME` 保存 Codex config、auth、logs、sessions、skills、standalone package metadata 等状态。
- 如果设置 `CODEX_HOME`，目录必须已存在。
- Codex CLI 的 `auth.json` 可能以明文文件形式保存在 `CODEX_HOME/auth.json`，应当像密码一样处理。
- headless / Docker 环境可以通过先在有浏览器机器上登录，再把 `auth.json` 复制进容器对应 `CODEX_HOME`。
- standalone installer 支持 `CODEX_NON_INTERACTIVE=1`，可用于脚本安装。

这意味着 Docker 服务中运行 Codex CLI 时，不能把 `CODEX_HOME` 当普通临时目录随容器销毁；也不能把 `auth.json` 打进镜像。`CODEX_HOME` 应作为单独持久化挂载，并且权限收紧。

## 镜像选择分析

### 方案 A：直接运行官方 `node:<version>` 镜像

示例：

```text
node:24
```

优点：

- 官方维护，依赖完整，很多常见工具已具备。
- 对新手友好，构建失败概率低。

缺点：

- 体积偏大。
- 镜像中会包含第一版不一定需要的通用包。
- 不符合“镜像小但够用”的目标。

结论：不推荐作为最终运行镜像，但可作为临时排障或本地验证基线。

### 方案 B：官方 `node:<version>-bookworm-slim` + 自定义运行镜像

示例：

```text
node:24-bookworm-slim
node:22-bookworm-slim
```

优点：

- 官方维护，安全更新来源清晰。
- Debian + glibc，兼容性比 Alpine 更稳。
- 比默认 Node 镜像小。
- 可以只安装当前确实需要的系统包。
- 适合 multi-stage build。

缺点：

- 需要自己补充 `git`、`openssh-client`、`curl` 等工具。
- 如果后续 bug_fix 场景要跑不同项目测试，可能逐步需要增加语言和系统依赖。

结论：推荐。

### 方案 C：`node:<version>-alpine`

优点：

- 体积更小。

缺点：

- musl libc 兼容性风险。
- 默认缺少 `git`、`bash` 等工具。
- Codex CLI、native Node addon、企业内部工具、预编译二进制更容易遇到兼容问题。
- 省下的镜像体积可能换来更多运行期排障成本。

结论：不推荐第一版使用。

### 方案 D：从 `debian:bookworm-slim` 自己安装 Node

优点：

- 最可控。
- 可以完全按组织内部规范安装 Node、Yarn、Codex、证书和工具。

缺点：

- 自己承担 Node 安装、升级、漏洞修复、架构适配和维护成本。
- 第一版没有必要。

结论：不推荐第一版。除非公司后续有统一基础镜像规范，再迁移。

## 推荐运行镜像

第一版推荐写成自定义 Dockerfile，但 base 使用官方 Node slim：

```dockerfile
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS runtime
```

如果担心 Node 24 与当前代码或依赖兼容性，先用：

```dockerfile
ARG NODE_IMAGE=node:22-bookworm-slim
```

推荐迁移策略：

1. 当前实现先用 `node:22-bookworm-slim`，因为项目声明 `>=22`，风险最小。
2. 在 CI 或本地 Docker 验证 `yarn test`、`yarn build`、WeCom 脚本、Jira polling 脚本、Codex smoke test。
3. 验证通过后改成 `node:24-bookworm-slim`，作为长期基线。
4. 不使用 `node:lts-slim` 这种浮动 tag 作为生产基础镜像。可以在调研和验证阶段使用，但生产镜像最好固定 major。

正式落地 Dockerfile 时，还应该在仓库根目录添加 `.dockerignore`，至少排除：

```text
.git
.codex
.agents
.easemob-agent
node_modules
dist
dist-test
coverage
secrets
*.pem
*.key
```

调研目录提供了参考文件：

```text
docs/research/docker/dockerignore.example
```

## Codex CLI 安装策略

Codex CLI 是本服务的 Runtime Adapter 关键依赖。第一版有两个可选安装策略。

### 策略 A：构建镜像时安装 Codex CLI

优点：

- 容器启动快。
- 运行时环境稳定。
- 健康检查可以直接执行 `codex --version`。

缺点：

- 构建镜像需要联网访问 Codex installer 或 npm/standalone 包源。
- 需要明确版本锁定和升级策略。

推荐作为生产方案，但正式实现时必须固定安装方式和版本，不要让构建结果不可追踪。

### 策略 B：容器启动时检查并安装 Codex CLI

优点：

- 镜像更简单。
- 可以在挂载的 `CODEX_HOME` 中复用 standalone package cache。

缺点：

- 服务启动依赖外网或内部镜像源。
- 失败点后移到运行期。
- 不利于稳定部署。

不推荐第一版生产使用，只可用于早期验证。

### Codex 状态挂载要求

无论哪种安装策略，都应单独挂载：

```text
CODEX_HOME=/home/node/.codex
```

其中可能包含：

```text
config.toml
auth.json
logs
sessions
skills
plugins
standalone package metadata
```

注意：

- `auth.json` 是敏感文件，不进镜像、不进 git。
- 如果用 API key，也不要写入镜像层或普通日志。
- 自动化任务默认可以用 `codex exec --ephemeral` 减少 session 文件堆积。
- 需要 resume 的任务再持久化 session，并通过 Task Store 记录 `codex_thread_id`。

## 配置注入

用户提出的问题是：环境变量非常多时，是否可以写一个 `config.json`，把变量放到文件里导入。

结论：Docker 支持这种运行模式，但应区分“业务配置”和“敏感密钥”。

推荐第一版采用三层配置：

```text
1. 少量启动级环境变量
2. 只读挂载的业务 config.json
3. Docker Compose secrets 或只读 secret 文件
```

### 1. 启动级环境变量

只保留少量路径和模式开关：

```text
NODE_ENV=production
APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json
APP_DATA_DIR=/var/lib/easemob-sdk-agent
CODEX_HOME=/home/node/.codex
```

这些值适合放在 Compose `environment` 或 `env_file` 中。

不要把下面内容直接作为普通环境变量长期传递：

```text
Jira 密码 / token
企业微信 secret
OpenAI / Codex token
GitHub token
私钥内容
```

原因是 Docker 官方文档也提醒，环境变量可能被进程、调试日志、inspect 输出等路径暴露。

### 2. 业务 `config.json`

可以使用 `config.json` 管理大量非敏感或低敏配置，例如：

```json
{
  "jira": {
    "baseUrl": "https://jira.example.com",
    "polling": {
      "enabled": true,
      "intervalSeconds": 60,
      "assignee": "jira-user"
    }
  },
  "codex": {
    "home": "/home/node/.codex",
    "workspaceRoot": "/workspaces"
  }
}
```

挂载方式：

```yaml
volumes:
  - ./config.production.json:/etc/easemob-sdk-agent/config.json:ro
```

建议：

- `config.json` 不复制进镜像。
- 生产真实 `config.json` 不提交 git。
- 仓库只提交 `config.example.json` 或字段说明。
- 程序启动时校验配置 schema，缺少关键字段时快速失败。
- 配置文件里可以放 secret 文件路径，不直接放 secret 明文。

### 3. secrets

Compose secrets 适合敏感值：

```yaml
services:
  app:
    secrets:
      - jira_password
      - wecom_bot_secret

secrets:
  jira_password:
    file: ./secrets/jira_password.txt
  wecom_bot_secret:
    file: ./secrets/wecom_bot_secret.txt
```

容器内读取：

```text
/run/secrets/jira_password
/run/secrets/wecom_bot_secret
```

对应用配置的建议：

```json
{
  "secrets": {
    "jiraPasswordFile": "/run/secrets/jira_password",
    "wecomBotSecretFile": "/run/secrets/wecom_bot_secret"
  }
}
```

这样应用启动后从文件读取 secret，而不是从环境变量读取。

### `.env` / `env_file` 的位置

`.env` 或 `env_file` 可以用于非敏感环境变量和部署差异：

```text
APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json
APP_DATA_DIR=/var/lib/easemob-sdk-agent
CODEX_HOME=/home/node/.codex
```

不建议把所有真实密钥放进 `.env`。如果运维流程暂时只能使用 `.env`，至少要：

- 文件权限收紧。
- 不提交 git。
- 不打印完整环境。
- 后续迁移到 secrets 或运维平台密钥管理。

## 持久化存储设计

第一版至少拆分三类挂载。

### 1. 应用数据和任务日志

路径：

```text
/var/lib/easemob-sdk-agent
```

内容：

```text
Task Store
任务状态
幂等记录
Jira webhook / polling checkpoint
结果回写记录
业务日志或 JSONL 事件摘要
```

建议：

- 使用 Docker named volume 或明确宿主机 bind mount。
- 如果运维需要直接查看、备份、迁移，用 bind mount 更直观。
- 如果只由 Docker 管理，用 named volume 更简单。

### 2. Codex 状态

路径：

```text
/home/node/.codex
```

内容：

```text
config.toml
auth.json
skills
plugins
sessions
logs
standalone package metadata
```

建议：

- 单独 volume。
- 权限只给运行用户读写。
- 不和业务 Task Store 混放。
- 定期清理 sessions，优先依赖 `--ephemeral` 降低增长。

### 3. 任务工作区

路径：

```text
/workspaces
```

用途：

```text
bug_fix 场景 clone / checkout 代码仓库
Codex workspace-write 修改代码
运行测试
生成 diff / patch / PR 信息
```

建议：

- 单独 volume 或 bind mount。
- 每个 task 使用独立子目录。
- 完成后按 Task Store 状态清理。
- 不把业务配置、Codex auth、Jira token 放入该目录。

### 4. 日志

容器 stdout/stderr 仍然应该是主日志出口，方便 `docker logs` 和日志平台采集。

需要审计的结构化任务事件可以写入：

```text
/var/lib/easemob-sdk-agent/tasks/<task_id>/
```

不建议把所有运行日志只写文件而不打 stdout，否则 Docker 运维体验会变差。

## Compose 参考形态

调研目录提供了一个非生产样例：

```text
docs/research/docker/compose.runtime.example.yaml
```

核心结构：

```yaml
services:
  easemob-sdk-agent:
    environment:
      APP_CONFIG_FILE: /etc/easemob-sdk-agent/config.json
      APP_DATA_DIR: /var/lib/easemob-sdk-agent
      CODEX_HOME: /home/node/.codex
    volumes:
      - ./config.production.json:/etc/easemob-sdk-agent/config.json:ro
      - easemob_agent_data:/var/lib/easemob-sdk-agent
      - codex_home:/home/node/.codex
      - task_workspaces:/workspaces
    secrets:
      - jira_password
      - wecom_bot_secret
      - codex_auth_json
```

注意：

- `codex_auth_json` 是否通过 Compose secret 注入，还需要结合 Codex CLI 实际认证维护方式决定。
- 如果 Codex CLI 需要运行中刷新 `auth.json`，单纯挂载为 read-only secret 可能不够；更稳的方式是把 `CODEX_HOME` 做成受保护 volume，并在部署初始化时把 `auth.json` 放进去。
- 如果使用 API key 登录，推荐通过部署平台 secret 注入，并确保应用/Runtime Adapter 不打印该值。

## 安全边界

第一版要明确避免这些做法：

```text
不要把真实 config.json COPY 进镜像
不要把 .easemob-agent/config.json COPY 进镜像
不要把 Jira / WeCom / GitHub / OpenAI token 写入 Dockerfile ENV
不要把 Codex auth.json 提交 git
不要让 bug_fix 工作区和密钥目录共用一个挂载
不要默认给容器挂载宿主机 Docker socket
不要默认 root 用户运行服务
```

推荐：

```text
USER node
只读挂载 config.json
secrets 走 /run/secrets
业务数据、Codex 状态、任务工作区分开挂载
Codex 执行默认 read-only sandbox
只有 bug_fix 任务使用 workspace-write，且工作目录限定在 /workspaces/<task_id>
```

## 验证方法

第一版正式 Dockerfile 落地后，应至少验证：

```bash
docker build --pull -t easemob-sdk-agent:local .
docker run --rm easemob-sdk-agent:local node --version
docker run --rm easemob-sdk-agent:local yarn --version
docker run --rm easemob-sdk-agent:local git --version
docker run --rm easemob-sdk-agent:local codex --version
```

如果使用 Compose：

```bash
docker compose config
docker compose up -d
docker compose logs -f easemob-sdk-agent
docker compose exec easemob-sdk-agent node --version
docker compose exec easemob-sdk-agent codex --version
docker compose exec easemob-sdk-agent test -r /etc/easemob-sdk-agent/config.json
docker compose exec easemob-sdk-agent test -d /var/lib/easemob-sdk-agent
docker compose exec easemob-sdk-agent test -d /home/node/.codex
docker compose exec easemob-sdk-agent test -d /workspaces
```

业务验证：

- Jira polling 脚本能读取配置并访问 Jira。
- 企业微信长连接脚本能接收和回复消息。
- Codex smoke test 能运行 `codex exec --json`，并能输出 `thread.started.thread_id`。
- bug_fix 场景能在 `/workspaces/<task_id>` 中 clone / checkout / test，不污染应用目录。

## 第一版推荐决策

推荐做法：

```text
1. 使用官方 node:22-bookworm-slim 启动第一版，验证所有现有脚本和 build/test。
2. Dockerfile 使用 multi-stage build。
3. 运行阶段只安装 ca-certificates、curl、git、openssh-client、tini。
4. 真实配置用 /etc/easemob-sdk-agent/config.json 只读挂载。
5. 密钥用 /run/secrets 文件读取，不写入镜像和普通环境变量。
6. 挂载 /var/lib/easemob-sdk-agent、/home/node/.codex、/workspaces 三类数据。
7. Codex CLI 和 Codex auth 作为部署前置条件显式验证。
8. Node 24 作为通过验证后的长期升级目标。
```

不建议第一版：

```text
使用 alpine
使用 latest/current 浮动 tag
自建 Debian + Node 安装链路
把所有配置都塞进环境变量
把所有数据混在一个 volume
把 Codex auth.json 烘进镜像
```

## 后续待确认

这些属于架构或运维决策，需要后续确认后再落地到正式 Dockerfile / Compose：

1. 生产基线最终使用 `node:22-bookworm-slim` 还是 `node:24-bookworm-slim`。
2. Codex CLI 的安装方式和版本锁定策略。
3. Codex 认证采用 `auth.json` 持久化、API key，还是企业工作区 access token。
4. Task Store 第一版使用文件、SQLite，还是外部数据库。
5. 生产部署时使用 Docker named volume 还是宿主机 bind mount。
6. bug_fix 场景是否需要额外语言工具链镜像，还是每个代码仓库按需扩展。
