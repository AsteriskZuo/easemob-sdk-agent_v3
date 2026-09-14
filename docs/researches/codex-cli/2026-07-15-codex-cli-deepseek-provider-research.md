# Codex CLI 接入 DeepSeek API 调研报告

> 调研日期：2026-07-15
> 目标：让 codex-cli（当前 v0.142.5）在 Docker 容器中通过 DeepSeek API Key 运行

---

## 1. 当前状态分析

### 1.1 项目架构

```
easemob-sdk-agent_v2 (TypeScript, Node 22+)
├── src/runtime/codex-cli-adapter.ts  ← 启动 codex CLI 子进程
├── src/config.ts                     ← 加载 config.json，构建子进程 env
├── src/server.ts                     ← 组装 Runtime Adapter
├── .codex/config.toml                ← 本地 Codex 配置（已指向 DeepSeek）
├── .codex/config.docker.toml         ← Docker Codex 配置（**无 Provider 配置**）
├── .easemob-agent/config.json        ← 应用配置（含 DeepSeek Key，**未使用**）
└── Dockerfile                        ← 安装 @openai/codex@0.142.5
```

### 1.2 当前 Codex CLI 调用方式

```bash
# 新会话
codex --ask-for-approval never exec \
  --sandbox read-only -C <workdir> \
  --json --output-last-message <file> <prompt>

# 恢复会话
codex --ask-for-approval never exec resume <thread_id> \
  --json --output-last-message <file> <prompt>
```

### 1.3 本地开发环境（已工作）

`.codex/config.toml`:
```toml
model_provider = "pucoding"
model = "gpt-5.4"
wire_api = "responses"

[model_providers.pucoding]
name = "OpenAI"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
```

**当前本地方案**：通过 CC Switch（本地协议桥接工具，默认端口 15721）将 Codex 的 Responses API 请求翻译为 DeepSeek 的 Chat Completions API 请求。

### 1.4 Docker 环境（问题所在）

`.codex/config.docker.toml`:
```toml
# 只有 MCP Server 配置，**完全没有 model_provider！**
[mcp_servers.jira]
command = "node"
cwd = "/home/node/.agents/mcps/jira"
args = ["dist/server.js"]
...
```

Docker 镜像中没有安装 CC Switch，配置文件中也没有 model_provider。代码中也没有将 DeepSeek API Key 注入子进程环境变量。

### 1.5 已有的（未使用的）配置

`.easemob-agent/config.json`:
```json
{
  "MODEL__API_KEY": "sk-9b01db3979a448d4b56cb5c900d52c97",
  "MODEL__BASE_URL": "https://api.deepseek.com",
  "MODEL__DEFAULT_MODEL": "deepseek:deepseek-v4-pro",
  "MODEL__FLASH_MODEL": "deepseek:deepseek-v4-flash"
}
```

这些配置键存在于本地 config.json 中，但 **`src/config.ts` 完全未读取它们**。`buildCodexEnv()` 只处理 Jira MCP 的环境变量。

### 1.6 模型目录已有 DeepSeek

`.codex/cc-switch-model-catalog.json` 中已包含：
- `deepseek-v4-flash` — DeepSeek V4 Flash
- `deepseek-v4-pro` — DeepSeek V4 Pro

---

## 2. 核心问题：协议鸿沟

### 2.1 协议差异

| | Codex CLI（默认） | DeepSeek API |
|---|---|---|
| API 风格 | **Responses API** (`/v1/responses`) | **Chat Completions** (`/v1/chat/completions`) |
| 请求路径 | `/v1/responses` | `/v1/chat/completions` |
| 消息结构 | Responses 格式 | Chat Completions 格式 |
| tool_calls | Responses 风格 | Chat Completions 风格 |
| 流式事件 | Responses SSE | Chat Completions SSE |

直接改 `base_url` 指向 `https://api.deepseek.com` **不会工作**——Codex 发出的请求和 DeepSeek 能理解的请求是两套不同的协议。

### 2.2 Codex 配置在哪个层级有效？

⚠️ **关键**: `model_provider`、`model_providers.*` 这类机器级 provider 和认证配置**只在用户级 `~/.codex/config.toml` 或全局 `/etc/codex/config.toml` 生效**，项目级 `.codex/config.toml` 可能不会覆盖这些字段。

Docker 容器中 `CODEX_HOME=/home/node/.codex`，所以最终生效的配置路径是 `/home/node/.codex/config.toml`。

---

## 3. 三种接入方案

### 方案 A：直连 Chat Completions（`wire_api = "chat"`）

**原理**：让 Codex CLI 自动降级，使用 Chat Completions 协议与 DeepSeek 通信。

**配置**：
```toml
# /home/node/.codex/config.toml
model = "deepseek-v4-pro"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "chat"
```

环境变量：`DEEPSEEK_API_KEY=sk-xxx`

**优点**：
- 无额外进程，配置最简单
- 链路最短，延迟最低
- Docker 中无需安装任何桥接工具

**缺点**：
- `wire_api = "chat"` 会丢失 Responses API 的高级特性（如结构化 tool_calls、patch 生成、多轮上下文管理）
- Codex 版本 0.142.5 是否完全支持 `wire_api = "chat"` 需要实测验证
- 复杂的多轮 Agent 任务可能不稳定
- 可能需要调整模型名（`deepseek-chat` vs `deepseek-v4-pro`）

**改动范围**：仅需修改配置文件和环境变量，无需改代码或 Dockerfile。

---

### 方案 B：本地协议桥接（CC Switch 进 Docker）

**原理**：CC Switch 作为本地代理，完成 Responses ↔ Chat Completions 的双向翻译。Codex 不知道自己连的是 DeepSeek。

```
Codex CLI ──Responses──→ CC Switch (127.0.0.1:15721) ──Chat──→ DeepSeek API
```

**配置**：
```toml
# /home/node/.codex/config.toml
model_provider = "ccx-bridge"
model = "deepseek-v4-pro"

[model_providers.ccx-bridge]
name = "CCX Bridge"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
```

**优点**：
- Codex 的完整 Agent 能力（Responses API 所有特性）全部保留
- 多轮工具调用、文件操作、补丁生成稳定
- 与本地开发环境一致的体验，排查问题时可对比
- CC Switch 还能管理 GLM、Kimi、MiniMax 等其他国产模型

**缺点**：
- Docker 中需常驻一个 CC Switch 进程
- 增加了一跳延迟（本地 loopback，影响极小）
- 需要修改 Dockerfile 和启动逻辑
- 需要处理进程生命周期管理

**Docker 改造范围**：
1. 在 Dockerfile 中安装 CC Switch
2. 启动脚本中先启动 CC Switch，再启动主服务
3. 处理 CC Switch 的配置（DeepSeek Key、模型选择）
4. 或使用 supervisor/s6-overlay 管理多进程

---

### 方案 C：OpenRouter BYOK

**原理**：OpenRouter 作为在线中转，自带协议转换。

```
Codex CLI ──Responses──→ OpenRouter ──Chat──→ DeepSeek API
```

**配置**：
```toml
model_provider = "openrouter"
model = "deepseek/deepseek-chat"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

**优点**：
- 零本地部署，只改配置
- OpenRouter 已做好协议转换
- 可以随时切换多个上游模型

**缺点**：
- 中间增加了一层在线服务，排障需同时关注三方
- 从国内访问 OpenRouter 延迟可能偏高
- DeepSeek Key 需要绑定到 OpenRouter 后台
- 数据经过第三方，有隐私顾虑
- 成本 = DeepSeek API 费 + OpenRouter 可能的溢价

---

## 4. 方案对比

| 维度 | 方案 A (wire_api=chat) | 方案 B (CC Switch) | 方案 C (OpenRouter) |
|---|---|---|---|
| 配置复杂度 | ★☆☆ | ★★☆ | ★☆☆ |
| Docker 改动 | 仅配置文件 | 需修改 Dockerfile | 仅配置文件 |
| 协议兼容性 | 部分（Chat API） | 完整（Responses） | 完整（OpenRouter 兼容） |
| Agent 能力 | 可能降级 | 完整保留 | 基本完整 |
| 延迟 | 最低 | 极低（本地 loopback） | 较高（经海外节点） |
| 国内访问 | 优 | 优 | 中 |
| 稳定性 | 需实测 | 已验证（本地在用） | 依赖第三方 |
| 数据隐私 | 直连 DeepSeek | 直连 DeepSeek | 经 OpenRouter |

---

## 5. 推荐方案及实施步骤

### 推荐：方案 A 优先尝试，方案 B 为保底

**理由**：
1. 方案 A 改动最小 — 仅需修改 Docker 配置文件和注入环境变量
2. 如果方案 A 在 0.142.5 版本上可行，就是最优解
3. 方案 A 不行则回退到方案 B（当前本地已验证可用）

### 5.1 方案 A 快速验证（本地）

```bash
# 1. 设置环境变量
export DEEPSEEK_API_KEY="sk-你的Key"

# 2. 临时启动 codex 测试
codex --model-provider deepseek --model deepseek-v4-pro "say hello"

# 或直接改 ~/.codex/config.toml 后测试
codex exec "分析当前目录"
```

### 5.2 方案 A Docker 改造

**第一步：修改 `config.docker.toml`**，添加 model_provider 配置：
```toml
model = "deepseek-v4-pro"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "chat"

# 保留原有 MCP 配置
[mcp_servers.jira]
...
```

**第二步：修改 `src/config.ts`**，在 `buildCodexEnv()` 中注入 DeepSeek Key：
```typescript
export function buildCodexEnv(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  // ... 现有 Jira 逻辑 ...

  // 注入 DeepSeek API Key
  const deepseekKey = getConfigString(config, "MODEL__API_KEY");
  if (deepseekKey) {
    next.DEEPSEEK_API_KEY = deepseekKey;
  }

  return next;
}
```

**第三步：Docker 启动时提供 config.json**（已包含 `MODEL__API_KEY`）：
```bash
docker run --rm \
  -e APP_CONFIG_FILE=/etc/easemob-sdk-agent/config.json \
  -v "$PWD/.easemob-agent/config.json:/etc/easemob-sdk-agent/config.json:ro" \
  ...
```

### 5.3 方案 B Docker 改造（如方案 A 不可行）

**Dockerfile 改造**：
```dockerfile
# 安装 CC Switch（具体安装方式需根据 CC Switch 官方文档）
# 例如下载二进制或 npm 安装
RUN npm install -g cc-switch  # 或具体包名

# 添加启动脚本
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
```

**docker-entrypoint.sh**：
```bash
#!/bin/bash
# 启动 CC Switch（后台运行，配置从环境变量读取）
cc-switch --api-key "$DEEPSEEK_API_KEY" --base-url "$DEEPSEEK_BASE_URL" &
CC_PID=$!

# 等待 CC Switch 就绪
sleep 2

# 启动主服务
exec node dist/bin/cli.js
```

---

## 6. 注意事项

### 6.1 API Key 安全

- `CODEX_API_KEY` 环境变量仅对 `codex exec` 有效，非交互模式专用
- ⚠️ 不要在 job 级别设置 `CODEX_API_KEY`，应在单次 `codex exec` 调用时内联设置
- 推荐使用 `env_key` 机制：配置文件只写环境变量名，不写 Key 值
- Docker 中 API Key 应通过 volume mount 或 Docker secrets 传入

### 6.2 模型名问题

- DeepSeek 推荐使用 `deepseek-v4-flash` / `deepseek-v4-pro`（V4 系列）
- `deepseek-chat` / `deepseek-reasoner` 是旧别名，2026-07-24 后将废弃
- Codex 有模型名白名单，不支持的模型名会直接报错
- 本地模型目录 `.codex/cc-switch-model-catalog.json` 已有 `deepseek-v4-flash` 和 `deepseek-v4-pro`

### 6.3 超时设置

DeepSeek 等第三方 API 首包延迟可能比 OpenAI 官方高（300ms-800ms），建议在 config.toml 中显式设置：
```toml
request_timeout = 60
```

### 6.4 上下文窗口

DeepSeek V4 系列可达 1M token，但实际使用时需根据具体模型档位在 config 中设置：
```toml
model_context_window = 1000000
model_auto_compact_token_limit = 900000
```

### 6.5 Codex 登录态

如果容器中 Codex 仍尝试 OpenAI 登录，先执行 `codex logout` 清除持久化登录态，然后确认配置的 `model_provider` 被正确读取。

---

## 7. 参考资料

- [Codex CLI Custom Provider Setup — MCSA Guru](https://mcsaguru.com/codex-cli-custom-provider-setup)
- [Codex 接入 DeepSeek V4 实战 — SegmentFault](https://segmentfault.com/a/1190000047834494)
- [Codex 配置 DeepSeek 详细教程 — 掘金](https://juejin.cn/post/7659715700894810138)
- [Codex 接入第三方 API — AI Pulse Lab](https://ai-pulse-lab.com/tips/codex%E6%8E%A5%E5%85%A5%E7%AC%AC%E4%B8%89%E6%96%B9api-%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F%E4%B8%8E%E8%87%AA%E5%AE%9A%E4%B9%89%E6%A8%A1%E5%9E%8B.html)
- [OpenAI Codex CLI 官方文档 — Non-interactive Mode](https://developers.openai.com/codex/guides/autofix-ci/)
- [OpenAI Codex CLI GitHub](https://github.com/openai/codex)
