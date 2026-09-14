# @codeproxy/cli 验证报告 & Docker 落地实施方案

> 日期：2026-07-15
> 状态：✅ 已实测验证

---

## 1. 实测结果

```
$ codeproxy --base-url https://api.deepseek.com/v1 \
    --model deepseek-v4-pro \
    --apikey "sk-..." \
    --port 18787 &

Proxy listening on http://127.0.0.1:18787
Upstream format: auto-inferred
Upstream URL: https://api.deepseek.com/v1

$ curl http://127.0.0.1:18787/v1/responses \
    -H 'content-type: application/json' \
    -d '{"input":"Say hello in one word.","stream":false}'

HTTP 200
{"id":"f4472cbc-...","object":"response","model":"deepseek-v4-pro",
 "status":"completed","output":[{"type":"output_text","text":"Hello."}],
 "usage":{"input_tokens":10,"output_tokens":57,"total_tokens":67}}
```

**结论**：协议转换完全正常，DeepSeek V4 Pro 返回标准 Responses API 格式响应，与 Codex CLI 期望的格式一致。

---

## 2. @codeproxy/cli 关键信息

| 属性 | 值 |
|---|---|
| npm 包 | `@codeproxy/cli@0.2.9` |
| CLI 名 | `codeproxy` |
| Node.js | >= 18（Docker 用 node:24 ✅） |
| 依赖 | 仅 `@codeproxy/core` |
| 健康检查 | ❌ 无 `/health` 端点，用 TCP 端口检测替代 |
| SIGTERM | ✅ 正常响应 ("Received SIGTERM, shutting down...") |
| 上游格式 | 自动推断（`/v1` → `openai-chat`） |

---

## 3. 实施方案

### 3.1 改动概览

```
改动的文件：5 个
新增的文件：2 个（docker-entrypoint.sh, docker-codeproxy.json）
修改的文件：3 个（Dockerfile, .codex/config.docker.toml, src/config.ts）
```

### 3.2 Dockerfile

```dockerfile
FROM node:24-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.142.5
RUN npm install -g @codeproxy/cli              # ← 新增

WORKDIR /app

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

# 复制 entrypoint 脚本
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json
ENV CODEX__HOME=/home/node/.codex

RUN mkdir -p /app/.easemob-agent/data /app/.easemob-agent/codex-workdir \
  && chown -R node:node /app/.easemob-agent

USER node
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]   # ← 改为 entrypoint 脚本
```

### 3.3 docker-entrypoint.sh（新增）

```bash
#!/bin/bash
set -e

# 检查必需的环境变量
if [ -z "$DEEPSEEK_API_KEY" ]; then
  echo "ERROR: DEEPSEEK_API_KEY is not set"
  exit 1
fi

echo "Starting codeproxy (DeepSeek bridge)..."
codeproxy \
  --base-url https://api.deepseek.com/v1 \
  --model deepseek-v4-pro \
  --apikey "$DEEPSEEK_API_KEY" \
  --port 8787 &
PROXY_PID=$!

# 等待 codeproxy 就绪（TCP 端口检测）
echo "Waiting for codeproxy on port 8787..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null -X POST "http://127.0.0.1:8787/v1/responses" \
    -H 'content-type: application/json' \
    -d '{"input":"ping"}' 2>/dev/null; then
    echo "codeproxy ready after ${i}s"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "ERROR: codeproxy failed to start within 30s"
    exit 1
  fi
  sleep 1
done

echo "Starting main application..."
# 前台运行主服务，退出后清理 codeproxy
node dist/bin/cli.js
EXIT_CODE=$?

echo "Shutting down codeproxy..."
kill $PROXY_PID 2>/dev/null || true
wait $PROXY_PID 2>/dev/null || true

exit $EXIT_CODE
```

### 3.4 .codex/config.docker.toml

```toml
# Docker Codex 配置 — 通过 codeproxy 桥接 DeepSeek

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

### 3.5 src/config.ts（改动）

`buildCodexEnv()` 新增 DeepSeek API Key 注入：

```typescript
export function buildCodexEnv(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };

  // Jira MCP env vars（现有逻辑，不变）
  for (const key of JIRA_MCP_ENV_KEYS) {
    const value = getConfigString(config, key);
    if (value) {
      next[key] = value;
    }
  }

  // 注入 DeepSeek API Key 供 codeproxy + Codex 使用
  const deepseekKey = getConfigString(config, "MODEL__API_KEY");
  if (deepseekKey) {
    next.DEEPSEEK_API_KEY = deepseekKey;
  }

  return next;
}
```

---

## 4. 容器内进程模型

```
tini (PID 1)
  └── docker-entrypoint.sh
        ├── codeproxy (后台, :8787) ──→ DeepSeek API
        └── node dist/bin/cli.js (前台)
              └── codex exec (子进程) ──→ codeproxy :8787
```

信号流：
1. Docker → SIGTERM → tini → node（前台进程）
2. node 退出 → entrypoint 继续执行 → `kill $PROXY_PID` → codeproxy 退出
3. 容器正常停止

---

## 5. Docker 运行时

```bash
docker run --rm \
  -e APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json \
  -v "$PWD/.easemob-agent/config.json:/etc/easemob-sdk-agent/config.json:ro" \
  -v "$PWD/.easemob-agent/data:/app/.easemob-agent/data" \
  -v "$PWD/.easemob-agent/codex-workdir:/app/.easemob-agent/codex-workdir" \
  easemob-sdk-agent-v2
```

`DEEPSEEK_API_KEY` 由 `buildCodexEnv()` 从 config.json 的 `MODEL__API_KEY` 自动注入，无需额外 `-e` 参数。

---

## 6. 与现有的差异总结

| 文件 | 操作 | 说明 |
|---|---|---|
| `Dockerfile` | 修改 | +1 行 `npm install -g @codeproxy/cli`，entrypoint 改脚本 |
| `docker-entrypoint.sh` | **新增** | 启动 codeproxy + 主服务，处理退出清理 |
| `.codex/config.docker.toml` | 修改 | 添加 `[model_providers.deepseek]` 块（+10 行） |
| `src/config.ts` | 修改 | `buildCodexEnv()` 加 4 行注入 `DEEPSEEK_API_KEY` |

**不改动的**：`src/server.ts`、`src/runtime/codex-cli-adapter.ts`、`src/agent/*`、所有测试、`.easemob-agent/config.json` 已有的 `MODEL__*` 字段。

---

## 7. 未解决的问题 & 待验证

1. **Codex 0.142.5 的 `wire_api = "responses"` 兼容性** — 文档说 Codex 0.128.0+ 支持，0.142.5 远超此版本，应该没问题。但极端情况下`base_url` 可能在旧版本行为不同，需实际验证。

2. **多轮工具调用稳定性** — DeepSeek V4 的工具调用格式是否能被 codeproxy 正确转换并还原为 Codex 期望的格式。简单对话已验证通过，复杂 Agent 场景（MCP 工具调用、文件操作）需端到端测试。

3. **流式响应中的 tool_use 块** — Codex 的 Responses API 流式事件中包含 `tool_use`、`apply_patch` 等专用事件类型，codeproxy 需将这些从 Chat Completions 的 `tool_calls` 还原。如果这部分转换不完整，Codex 会报解析错误。

4. **上下文窗口配置** — 当前 local `config.toml` 设了 `model_context_window = 1050000`，Docker 环境也应该加上类似配置。

5. **镜像大小** — `@codeproxy/cli` 仅 2 个 npm 包（`@codeproxy/core`），预估增量 < 3MB。
