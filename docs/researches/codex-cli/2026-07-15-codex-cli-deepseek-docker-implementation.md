# 方案 B 深入调研：CC Switch / CodeProxy 协议桥接 Docker 集成方案

> 调研日期：2026-07-15
> 目标：在 Docker 容器中部署 Responses↔Chat Completions 协议桥接，让 Codex CLI 使用 DeepSeek API

---

## 1. 方案 B 的核心思路

```
┌──────────┐    Responses API     ┌──────────────┐    Chat Completions    ┌─────────────┐
│          │ ──────────────────→  │              │ ────────────────────→  │             │
│  Codex   │    /v1/responses     │  协议桥接     │    /v1/chat/          │  DeepSeek   │
│  CLI     │                      │  (本地代理)   │    completions        │  API        │
│          │ ←──────────────────  │              │ ←────────────────────  │             │
└──────────┘    Responses 格式     └──────────────┘    Chat 格式           └─────────────┘
                (Codex 理解的)                          (DeepSeek 理解的)
```

## 2. 两个桥接实现候选

### 候选 1：CC Switch CLI（你已在使用）

| 维度 | 详情 |
|---|---|
| 仓库 | https://github.com/SaladDay/cc-switch-cli |
| 最新版 | v5.9.0（2026-07-08） |
| 安装 | 单二进制文件，无依赖 |
| Linux 支持 | ✅ x64 (glibc + musl), ARM64 (glibc + musl) |
| CLI 模式 | ✅ 完整的 TUI + CLI 命令 |
| 代理前台模式 | ✅ `cc-switch proxy serve` |
| 守护进程模式 | ✅ `cc-switch daemon start/stop` |
| Provider 管理 | ✅ `cc-switch --app codex provider add` |
| 隔离配置 | ✅ `CC_SWITCH_CONFIG_DIR` 环境变量 |

**Linux 发布资产**（https://github.com/SaladDay/cc-switch-cli/releases/tag/v5.9.0）：
```
cc-switch-cli-linux-x64.tar.gz          ← glibc（适合 Debian/Ubuntu）
cc-switch-cli-linux-x64-musl.tar.gz     ← musl（适合 Alpine）
cc-switch-cli-linux-arm64.tar.gz
cc-switch-cli-linux-arm64-musl.tar.gz
```

**关键命令**：
```bash
# 设置隔离的配置目录
export CC_SWITCH_CONFIG_DIR=/home/node/.cc-switch

# 添加 DeepSeek Provider（非交互模式）
cc-switch --app codex provider add \
  --name deepseek \
  --base-url https://api.deepseek.com/v1 \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-pro

# 切换到 DeepSeek Provider
PROVIDER_ID=$(cc-switch --app codex provider list --json | jq -r '.[0].id')
cc-switch --app codex provider switch "$PROVIDER_ID"

# 启用代理并启动
cc-switch proxy enable
cc-switch proxy serve               # 前台运行，127.0.0.1:15721
# 或
cc-switch daemon start --foreground  # 守护进程前台模式
```

**优点**：
- 本地开发和 Docker 环境统一，排查问题体验一致
- 功能丰富（速率测试、流健康检查、用量统计等）
- 可管理多个 Provider，便于未来扩展

**缺点**：
- 需要下载二进制文件
- 配置步骤较多（add provider → switch → enable proxy）
- `provider add` 非交互模式的 CLI flag 文档不够完整，可能需要 trial-and-error
- 二进制较重（Rust 编译产物）

---

### 候选 2：@codeproxy/cli（专用协议桥）

| 维度 | 详情 |
|---|---|
| 仓库 | https://github.com/codeproxy-ai/cli |
| 最新版 | v0.2.9（2026-05-25） |
| 安装 | `npm install -g @codeproxy/cli` |
| 定位 | **专为 Codex + DeepSeek 量身定做** |
| CLI 模式 | ✅ 纯命令行，默认前台模式 |
| 零配置启动 | ✅ `npx @codeproxy/cli --base-url ... --apikey ... --model ...` |
| 配置文件 | ✅ JSON 配置文件，支持多 upstream |
| 编程 API | ✅ `import { startProxy } from '@codeproxy/cli'` |

**最简启动**：
```bash
npx @codeproxy/cli \
  --base-url https://api.deepseek.com/v1 \
  --model deepseek-v4-pro \
  --apikey "$DEEPSEEK_API_KEY" \
  --port 8787
# → listening on http://127.0.0.1:8787/v1
```

**配置文件模式**（推荐）：
```json
{
  "version": "1.0",
  "currentUpstream": "deepseek",
  "upstreams": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx",
      "model": "deepseek-v4-pro",
      "modelAliases": {
        "gpt-5.4": "deepseek-v4-pro",
        "gpt-4o": "deepseek-v4-flash"
      }
    }
  }
}
```

**优点**：
- 🎯 **零摩擦**：一行命令即可启动，无任何前置配置
- 📦 **同栈**：npm 生态，与项目技术栈一致
- 🔧 **轻量**：只做一件事（协议转换），没有多余功能
- 🐳 **Docker 友好**：默认前台运行，完美适配容器 init 进程
- 📝 **配置清晰**：JSON 配置文件格式简单直观
- 🔌 **编程 API**：可集成到 Node.js 启动脚本中

**缺点**：
- 功能单一，无法管理多个 Provider、MCP 等
- 社区规模比 CC Switch 小（49 stars vs 数万）
- 版本号较低（0.2.x），可能在快速迭代

---

## 3. 候选对比

| 维度 | CC Switch CLI | @codeproxy/cli |
|---|---|---|
| 安装方式 | 下载二进制 (`curl` + `tar`) | npm 安装 |
| 启动复杂度 | 需 add provider → switch → enable proxy | 一行命令 |
| 配置持久化 | SQLite 数据库 | JSON 文件 |
| Docker 镜像大小 | +~15MB（解压后二进制） | +~2MB（npm 包） |
| 功能范围 | Provider/MCP/Skills/Prompts 管理 | 纯协议转换 |
| 与本地环境一致性 | ✅ 完全一致（本地也用 CC Switch） | ❌ 不一致 |
| 学习成本 | 中（命令较多） | 低（就一个命令） |
| 维护成本 | 低（活跃项目，周更） | 中（月更） |
| 未来扩展性 | 高（多 Provider、WebDAV 同步） | 中（只做协议转换） |

---

## 4. 推荐方案：@codeproxy/cli 为主，CC Switch 备用

**推荐 @codeproxy/cli** 作为 Docker 中方案 B 的实现，理由：

1. **极简**：一行命令启动，完美的 Docker init 进程
2. **同栈**：npm 生态，Dockerfile 里直接 `npm install -g`，无需额外下载工具
3. **专用**：就是为解决 Codex + DeepSeek 的协议转换而生
4. **可编程**：如果需要，可以从 `src/config.ts` 中以编程方式启动

**如果遇到兼容性问题，再回退 CC Switch CLI**：本地已验证可用，调试时可对比行为。

---

## 5. 实施计划（@codeproxy/cli 路线）

### 5.1 Docker 架构

```
┌──────────────────────────────────────────────────┐
│ Docker Container                                  │
│                                                   │
│  ┌─────────────┐     ┌──────────────────┐        │
│  │ codeproxy   │ ←── │ codex exec       │        │
│  │ :8787       │     │ (config 指向      │        │
│  │             │     │  127.0.0.1:8787) │        │
│  └──────┬──────┘     └──────────────────┘        │
│         │                                         │
│         │ Chat Completions                        │
│         ▼                                         │
│  ┌─────────────┐                                  │
│  │ DeepSeek    │                                  │
│  │ API         │                                  │
│  └─────────────┘                                  │
│                                                   │
│  ┌─────────────┐                                  │
│  │ Node 主服务  │                                  │
│  │ (Jira/WeCom)│                                  │
│  └─────────────┘                                  │
└──────────────────────────────────────────────────┘
```

### 5.2 需要修改的文件

#### ① `Dockerfile`

```dockerfile
FROM node:24-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.142.5
RUN npm install -g @codeproxy/cli      # ← 新增

WORKDIR /app

# ... 其余保持不变 ...
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
RUN corepack enable && yarn install --immutable && yarn cache clean

COPY tsconfig.json ./
COPY src ./src
COPY --chown=node:node .agents /home/node/.agents
COPY --chown=node:node .codex /home/node/.codex
RUN cd /home/node/.agents/mcps/jira \
  && corepack enable && yarn install --immutable && yarn build && yarn cache clean
RUN cp /home/node/.codex/config.docker.toml /home/node/.codex/config.toml
RUN yarn build

# 复制启动脚本和 codeproxy 配置
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
COPY docker-codeproxy.json /home/node/.codeproxy.json
RUN chown node:node /home/node/.codeproxy.json

ENV NODE_ENV=production
ENV APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json
ENV CODEX__HOME=/home/node/.codex
ENV CODEPROXY_CONFIG=/home/node/.codeproxy.json

RUN mkdir -p /app/.easemob-agent/data /app/.easemob-agent/codex-workdir \
  && chown -R node:node /app/.easemob-agent

USER node
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
```

#### ② `docker-codeproxy.json`（新增）

```json
{
  "version": "1.0",
  "currentUpstream": "deepseek",
  "upstreams": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "__DEEPSEEK_API_KEY__",
      "model": "deepseek-v4-pro",
      "modelAliases": {
        "gpt-5.4": "deepseek-v4-pro",
        "gpt-4o": "deepseek-v4-pro"
      },
      "dropImages": true,
      "timeoutMs": 120000
    }
  }
}
```

> 注意：`apiKey` 在启动脚本中通过 `sed` 替换为环境变量值

#### ③ `docker-entrypoint.sh`（新增）

```bash
#!/bin/bash
set -e

# 替换 API Key 占位符
if [ -n "$DEEPSEEK_API_KEY" ] && [ -f "$CODEPROXY_CONFIG" ]; then
  sed -i "s/__DEEPSEEK_API_KEY__/$DEEPSEEK_API_KEY/g" "$CODEPROXY_CONFIG"
fi

# 启动 codeproxy 协议桥接（后台运行）
codeproxy --config "$CODEPROXY_CONFIG" --port 8787 &
PROXY_PID=$!

# 等待代理就绪
echo "Waiting for codeproxy to be ready..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:8787/health" 2>/dev/null; then
    echo "codeproxy ready after ${i}s"
    break
  fi
  sleep 1
done

# 启动主服务
exec node dist/bin/cli.js
```

#### ④ `src/config.ts` — 注入 DeepSeek Key

当前 `buildCodexEnv()` 只处理 Jira MCP 变量，需增加 DeepSeek Key：

```typescript
export function buildCodexEnv(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };

  // Jira MCP env vars（现有逻辑）
  for (const key of JIRA_MCP_ENV_KEYS) {
    const value = getConfigString(config, key);
    if (value) { next[key] = value; }
  }

  // 注入 DeepSeek API Key 供 codeproxy 使用  ← 新增
  const deepseekKey = getConfigString(config, "MODEL__API_KEY");
  if (deepseekKey) {
    next.DEEPSEEK_API_KEY = deepseekKey;
  }

  return next;
}
```

#### ⑤ `.codex/config.docker.toml` — 添加 Provider 配置

```toml
# Docker Codex 配置
model = "deepseek-v4-pro"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek via codeproxy"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"

# 保留原有 MCP 配置
[mcp_servers.jira]
command = "node"
cwd = "/home/node/.agents/mcps/jira"
args = ["dist/server.js"]
env_vars = [
  "APP_CONFIG_FILE",
  "TOOL__JIRA__URL",
  "TOOL__JIRA__USERNAME",
  "TOOL__JIRA__PASSWORD",
  "TOOL__JIRA__REDIRECT_USERNAME",
  "TOOL__JIRA__REDIRECT_PASSWORD",
]
required = true
startup_timeout_sec = 20
tool_timeout_sec = 60
```

### 5.3 改动清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `Dockerfile` | 修改 | 安装 `@codeproxy/cli`，添加 entrypoint 和配置 |
| `docker-entrypoint.sh` | **新增** | 启动 codeproxy + 主服务 |
| `docker-codeproxy.json` | **新增** | codeproxy 配置（含 API Key 占位符） |
| `.codex/config.docker.toml` | 修改 | 添加 `[model_providers.deepseek]` |
| `src/config.ts` | 修改 | `buildCodexEnv()` 注入 `DEEPSEEK_API_KEY` |

**无需改动的文件**：
- `src/server.ts` — 不需要改
- `src/runtime/codex-cli-adapter.ts` — 不需要改（Codex CLI 调用方式不变）
- `src/agent/*` — 不需要改
- `.easemob-agent/config.json` — 已有 `MODEL__API_KEY`
- 所有测试文件 — Codex CLI 调用接口不变

### 5.4 Docker 运行时

```bash
docker run --rm \
  -e APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json \
  -v "$PWD/.easemob-agent/config.json:/etc/easemob-sdk-agent/config.json:ro" \
  -v "$PWD/.easemob-agent/data:/app/.easemob-agent/data" \
  -v "$PWD/.easemob-agent/codex-workdir:/app/.easemob-agent/codex-workdir" \
  easemob-sdk-agent-v2
```

`DEEPSEEK_API_KEY` 会由 `buildCodexEnv()` 从 `config.json` 的 `MODEL__API_KEY` 注入到子进程环境变量，codeproxy 启动时通过 entrypoint 脚本读取。

---

## 6. 备选方案：CC Switch CLI 实施计划

如果 @codeproxy/cli 遇到兼容性问题，回退到 CC Switch CLI 的实施要点：

### Dockerfile 改动

```dockerfile
# 下载 CC Switch CLI 二进制（glibc 版本匹配 Debian）
ARG CC_SWITCH_VERSION=v5.9.0
RUN curl -fsSL \
  "https://github.com/SaladDay/cc-switch-cli/releases/download/${CC_SWITCH_VERSION}/cc-switch-cli-v5.9.0-linux-x64.tar.gz" \
  | tar -xz -C /usr/local/bin/ \
  && chmod +x /usr/local/bin/cc-switch
```

### Entrypoint 中配置并启动

```bash
#!/bin/bash
set -e

export CC_SWITCH_CONFIG_DIR=/home/node/.cc-switch

# 添加 Provider
cc-switch --app codex provider add \
  --name deepseek \
  --base-url https://api.deepseek.com/v1 \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-pro

# 获取 Provider ID 并切换
PROVIDER_ID=$(cc-switch --app codex provider list | head -1)
cc-switch --app codex provider switch "$PROVIDER_ID"

# 启动代理（前台模式）
cc-switch proxy serve &
PROXY_PID=$!

# 等待就绪
sleep 2

exec node dist/bin/cli.js
```

---

## 7. 风险评估

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| @codeproxy/cli 协议转换不完整 | 部分 Agent 功能异常 | 先用 `codex exec "say hello"` 验证基础连通性 |
| API Key 占位符替换失败 | codeproxy 无法连接 DeepSeek | entrypoint 脚本中增加 `DEEPSEEK_API_KEY` 空值检查 |
| codeproxy 健康检查端点不存在 | 启动脚本挂起 | 重试超时后跳过健康检查，直接继续；主服务有 30 分钟超时兜底 |
| 大规模请求时代理内存泄漏 | 容器 OOM | 设置 `--max-old-space-size` 限制 Node 内存 |
| CC Switch CLI `provider add` 非交互 flag 不完整 | 无法自动化配置 | 使用预先生成的 SQLite 数据库文件挂载进容器 |

---

## 8. 结论

**方案 B 完全可落地**。推荐优先使用 `@codeproxy/cli`：

- 改动范围：5 个文件（1 修改 + 3 新增 + 1 修改）
- 总代码量：约 100 行新增
- Docker 镜像增量：约 +2MB
- 与当前架构兼容：Codex CLI Runtime Adapter 无需任何改动

建议实施步骤：
1. 先在容器外验证 `@codeproxy/cli` 能否正确桥接 Codex + DeepSeek
2. 通过后，按上述计划改造 Docker 镜像
3. 在容器中端到端测试一次完整的 Jira 工单审查流程
