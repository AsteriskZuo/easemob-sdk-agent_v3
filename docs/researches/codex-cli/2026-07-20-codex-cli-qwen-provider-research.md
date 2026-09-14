# Codex CLI 接入千问（Qwen）API 调研报告

> 调研日期：2026-07-20
> 目标：让 codex-cli（当前 v0.142.5）在 Docker 容器中通过千问（Qwen / DashScope）API Key 运行
> 关联文档：[2026-07-15-codex-cli-deepseek-provider-research.md](./2026-07-15-codex-cli-deepseek-provider-research.md)（DeepSeek 调研，背景与项目架构相同，不再重复）

---

## 0. 结论摘要

1. `.easemob-agent/config.json` 中的千问凭证（`QIWEN__API_KEY` / `QIWEN__BASE_URL`）**实测有效**。
2. **Chat Completions 端点完全可用**：单轮、SSE 流式、多轮工具调用（`role=tool` / `role=function`）全部验证通过，覆盖 `qwen3-coder-plus`、`qwen3-coder-flash`、`qwen3-coder-next`、`qwen3-max`。
3. **Responses 端点存在网关侧缺陷**：单轮问答和首轮工具调用正常，但回传 `function_call_output`（工具结果）时必现 400，Agent 多轮场景不可用。
4. **codex-cli 0.142.5 已移除 `wire_api = "chat"`**（启动直接报错），DeepSeek 调研中的"方案 A（直连 Chat Completions）"已不复存在。当前 codex 只支持 `wire_api = "responses"`。
5. 因此 Docker 接入千问需要协议桥接。**`@codeproxy/cli` 桥接路线已实测通过**（见 3.6）：codex 单轮、多轮工具任务、会话恢复（`exec resume`）全部成功，为推荐落地路线；若网关修复 Responses 端点的工具结果翻译缺陷，直连 Responses 将成为更简的终态。
6. 本机 Docker daemon 不可用，容器内实测未执行；但配置机制（`CODEX_HOME` 下 `config.toml` + 环境变量注入）已在本地以相同机制验证。

---

## 1. 已有配置与项目现状

`.easemob-agent/config.json`（已存在，**未被 `src/config.ts` 读取**）：

```json
{
  "QIWEN__API_KEY": "sk-ws-H.EH...(已脱敏)",
  "QIWEN__BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1"
}
```

项目架构、Codex CLI 调用方式、Docker 配置层级（`CODEX_HOME=/home/node/.codex`，生效路径 `/home/node/.codex/config.toml`）与 DeepSeek 调研一致，见关联文档第 1、2 节。

**与 DeepSeek 调研时相比的两点变化**：

- codex-cli 0.142.5 移除了 `wire_api = "chat"` 支持（见第 3.3 节实测报错），官方说明见 [GitHub Discussion #7782](https://github.com/openai/codex/discussions/7782)。
- 千问端点原生提供 `/responses` 路径（DeepSeek 没有），但存在工具结果翻译缺陷（见第 3.2 节）。

---

## 2. 端点性质说明

`QIWEN__BASE_URL` 指向 DashScope 兼容模式地址，但实测 `/models` 返回 **229 个模型**，除 Qwen 全系列外还包含 `kimi/*`、`glm-*`、`MiniMax/*`、`xiaomi/*` 等第三方模型，Key 格式（`sk-ws-` 前缀）也不同于 DashScope 官方 Key。判断该端点是一个**聚合网关**（而非裸 DashScope），这一性质直接影响第 3.2 节的缺陷归属——缺陷在网关的 Responses 翻译层，不一定是 Qwen 模型本身或 DashScope 官方行为。

适合编码 Agent 场景的模型（实测均可正常工具调用）：

| 模型 | 定位 | 上下文 |
|---|---|---|
| `qwen3-coder-plus` | 旗舰编码模型（480B MoE / 35B 激活） | 原生 256K，可外推 1M |
| `qwen3-coder-flash` | 快速编码模型 | — |
| `qwen3-coder-next` | 新一代编码模型 | — |
| `qwen3-max` | 旗舰通用模型 | 256K |

---

## 3. 实测验证记录（2026-07-20）

所有验证均使用 `.easemob-agent/config.json` 中的 `QIWEN__API_KEY` / `QIWEN__BASE_URL`。

### 3.1 Chat Completions：全部通过 ✅

- **单轮问答**：`POST /chat/completions`，`qwen3-coder-plus` 正常返回。
- **工具调用**：返回标准 `tool_calls`（`finish_reason: tool_calls`）。
- **多轮工具结果回传**：分别用 `role="tool"` 和 `role="function"` 回传工具结果，`qwen3-coder-plus` / `qwen3-coder-flash` / `qwen3-coder-next` / `qwen3-max` **四个模型全部正常**生成后续回答。
- **SSE 流式**：`stream: true` 返回标准 `chat.completion.chunk` 序列，以 `[DONE]` 结束。

### 3.2 Responses：单轮通过，工具结果回传必现 400 ❌

- `POST /responses` 单轮问答正常，返回标准 Response 对象。
- 带 `tools` 发起请求，能正常返回 `function_call` 输出项。
- **回传 `function_call_output` 时必现 400**（三种写法均失败：字符串 output、内容数组 output、`previous_response_id` 链式）：

```json
{
  "code": "InvalidParameter",
  "message": "<400> InternalError.Algo.InvalidParameter: Agent invalid parameter.
    [1 validation error for Message\nrole\n  Value error, tool must be one of
    user,assistant,system,function [input_value='tool']]"
}
```

**根因判断**：网关将 Responses 的 `function_call_output` 翻译成 Chat 消息 `role="tool"` 后，其上游"Agent"链路的校验器只接受 `user/assistant/system/function` 四种 role，拒绝 `tool`。而直接走 `/chat/completions` 时 `role="tool"` 是被接受的（3.1 已验证）——**缺陷位于网关的 Responses→Chat 翻译/路由层**，非模型能力问题。

### 3.3 codex-cli 0.142.5 实测

测试方法：独立 `CODEX_HOME=/tmp/codex-qwen-test`，`config.toml` 配置 `model_provider = "qwen"` + `env_key = "QWEN_API_KEY"`，与 Docker 中的配置机制完全相同。

**`wire_api = "chat"` —— 已被移除，启动即报错：**

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
```

**`wire_api = "responses"` —— 单轮任务成功：**

```
model: qwen3-coder-plus
provider: qwen
user: Reply with exactly: PONG
codex: PONG
```

伴随一条警告（见 6.1）：`Model metadata for 'qwen3-coder-plus' not found. Defaulting to fallback metadata`。

**`wire_api = "responses"` —— 多轮工具任务失败：**

执行"创建文件并 cat 验证"任务时，首个 `exec` 工具调用成功（文件已写入），但 codex 回传工具结果时命中 3.2 的网关缺陷，重试 5 次后失败：

```
ERROR: stream disconnected before completion: <400> InternalError.Algo.InvalidParameter:
Agent invalid parameter. ... role ... tool must be one of user,assistant,system,function
```

**结论：codex 直连该网关当前只能完成"零工具调用"或"首轮工具调用后即终止"的任务，无法支撑 Agent 多轮场景。**

### 3.4 本地 CC Switch 桥接探测

本地 `127.0.0.1:15721` 的 CC Switch 正在运行，但其当前上游（`Pu-1x（流量）`）未开放 `qwen3-coder-plus`，返回 404"当前未开放该模型"。即本地 CC Switch 环境**尚未配置 DashScope/千问上游**；若回退到 CC Switch 桥接路线，需要先新增对应上游（`QIWEN__BASE_URL` + `QIWEN__API_KEY`）。

### 3.5 Docker 实测限制

本机 Docker daemon 不可用（`docker info` 失败），未执行容器内验证。3.3 的本地验证使用了与 Docker 完全一致的配置机制（独立 `CODEX_HOME` + `env_key` 环境变量），结论可平移；容器内差异仅剩网络可达性和镜像内工具链，风险低。

### 3.6 @codeproxy/cli 桥接实测（2026-07-20 追加）✅

参考 [2026-07-15-codex-cli-deepseek-docker-implementation.md](./2026-07-15-codex-cli-deepseek-docker-implementation.md) 中 `@codeproxy/cli` 的用法，在本地完整验证了"codex → codeproxy → 千问网关"链路：

**环境**：`@codeproxy/cli@0.2.9`（npm 隔离目录安装），配置文件模式：

```json
{
  "version": "1.0",
  "currentUpstream": "qwen",
  "upstreams": {
    "qwen": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "apiKey": "<QIWEN__API_KEY>",
      "model": "qwen3-coder-plus"
    }
  }
}
```

启动：`codeproxy --config codeproxy.json --port 8787`，监听 `http://127.0.0.1:8787/v1`。

codex 侧配置（独立 `CODEX_HOME`，与 Docker 机制一致）：

```toml
model = "qwen3-coder-plus"
model_provider = "codeproxy"

[model_providers.codeproxy]
name = "codeproxy-local"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
```

**验证结果**：

| 用例 | 结果 |
|---|---|
| `POST /v1/responses` 单轮（直连代理） | ✅ 返回标准 Response 对象 |
| codex 多轮工具任务（建文件 → `cat` 验证 → 回复 DONE） | ✅ 两次 `exec` 工具调用 + 收尾全部成功（直连网关时此用例必败，见 3.3） |
| codex `exec resume <thread_id>` 会话恢复 | ✅ 正确读回上一会话创建的文件内容 |

**注意**：`--base-url` 需指向完整的 `/chat/completions` 端点（或显式 `--upstream-format openai-chat`），否则上游格式推断可能不符合预期。

**结论：@codeproxy/cli 完整补上了网关 Responses 翻译缺陷，且与 DeepSeek 实施文档的 Docker 改造计划完全同构，是千问接入的推荐实现。**

---

## 4. 方案分析

### 方案 A：直连 Responses（`wire_api = "responses"`）—— 当前不可用，修复后最优

```toml
# /home/node/.codex/config.toml
model = "qwen3-coder-plus"
model_provider = "qwen"

[model_providers.qwen]
name = "Qwen-DashScope"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
env_key = "QWEN_API_KEY"
wire_api = "responses"
```

- **现状**：被 3.2 的网关缺陷阻断，多轮工具调用必败。
- **前提**：网关修复 `function_call_output` 的翻译（或将 `role="tool"` 透传/转为 `function`）。修复后这是改动最小、链路最短的方案。
- **行动项**：向网关提供方反馈该缺陷（3.2 的错误信息和复现载荷可直接引用）。

### 方案 B：协议桥接进 Docker（@codeproxy/cli）—— 推荐路线 ✅（已实测）

```
Codex CLI ──Responses──→ codeproxy (127.0.0.1:8787) ──Chat Completions──→ 千问网关
```

- **依据**：端到端链路已实测通过（3.6），包括多轮工具调用和会话恢复。
- **实现选择**：`@codeproxy/cli` 优先于 CC Switch——零配置一行启动、npm 同栈、镜像增量仅约 2MB、默认前台运行适配容器 init；两者详细对比见 [DeepSeek Docker 实施调研](./2026-07-15-codex-cli-deepseek-docker-implementation.md) 第 2、3 节。CC Switch 作为备用（本地 DeepSeek 场景长期验证可用，但需新增千问上游且配置步骤更多）。
- **Docker 改造**：与 [DeepSeek Docker 实施调研](./2026-07-15-codex-cli-deepseek-docker-implementation.md) 第 5 节完全同构，仅需把上游 baseUrl/model/Key 换成千问（`QIWEN__BASE_URL` + `/chat/completions`、`qwen3-coder-plus`、`QIWEN__API_KEY`）。
- **注意**：codex 会警告 qwen 模型元数据缺失并走 fallback（见 6.1），通过 config.toml 显式设置上下文窗口缓解。

### 方案 C：其他在线中转（OpenRouter 等）—— 备选

OpenRouter 提供 Qwen3 Coder 系列且自带协议兼容。缺点与 DeepSeek 调研一致：经第三方、国内访问延迟、隐私与成本考量。仅在前两条路都走不通时考虑。

### 方案对比

| 维度 | 方案 A（直连 Responses） | 方案 B（@codeproxy/cli） | 方案 C（OpenRouter） |
|---|---|---|---|
| 当前可用性 | ❌（网关缺陷阻断） | ✅（端到端已实测，3.6） | ✅ |
| Docker 改动 | 仅配置文件 | 改 Dockerfile + 启动脚本 | 仅配置文件 |
| Agent 多轮工具调用 | 修复后完整 | 完整（已验证） | 基本完整 |
| 延迟 | 最低 | 极低（本地 loopback） | 较高 |
| 依赖 | 网关修复缺陷 | npm 包 `@codeproxy/cli` | 第三方服务 |

---

## 5. 推荐实施路径

**短期（立即可做）→ 方案 B（@codeproxy/cli，已实测）**：

1. 按 [DeepSeek Docker 实施调研](./2026-07-15-codex-cli-deepseek-docker-implementation.md) 第 5 节改造 Dockerfile 与 entrypoint（`npm install -g @codeproxy/cli`，entrypoint 先起 codeproxy 再起主服务），把 codeproxy 配置中的上游换成千问（`QIWEN__BASE_URL` + `/chat/completions`、`qwen3-coder-plus`、Key 用占位符 + 启动时替换）。
2. 修改 `src/config.ts` 的 `buildCodexEnv()`，把 `QIWEN__API_KEY` 注入为 codeproxy 启动脚本可读的环境变量（与 DeepSeek Key 注入同构）。
3. `config.docker.toml` 增加 model_provider 配置（`base_url = "http://127.0.0.1:8787/v1"`、`wire_api = "responses"`）。
4. 容器内端到端跑一次完整流程验证（本地链路已在 3.6 验证，容器内仅剩网络与进程管理差异）。

**中期（并行推进）→ 方案 A 解锁**：

5. 向网关提供方反馈 Responses 端点 `function_call_output` 翻译缺陷（附 3.2 复现载荷）。
6. 网关修复后，切换为直连 Responses，移除容器内桥接进程，回退 Dockerfile 改动。

> 按 AGENTS.md 决策需确认原则：以上为推荐路径，落地前请确认走"方案 B 先行"还是"先等网关修复"。

---

## 6. 注意事项

### 6.1 模型元数据缺失警告

codex 对未知模型名会警告 `Model metadata not found. Defaulting to fallback metadata` 并可能影响性能。缓解方式（按 DeepSeek 调研 6.4 同法）在 config.toml 显式设置：

```toml
model_context_window = 256000        # qwen3-coder-plus 原生 256K
model_auto_compact_token_limit = 230000
```

若回退使用 CC Switch 桥接，另需在其模型目录中为 qwen 模型补充元数据条目（当前 `.codex/cc-switch-model-catalog.json` 仅有 deepseek 条目）；@codeproxy/cli 无模型目录概念，不受此影响。

### 6.2 API Key 安全

- 沿用 `env_key` 机制：配置文件只写环境变量名（`QWEN_API_KEY`），不写 Key 值。
- Docker 中通过 volume mount config.json 或 Docker secrets 传入，不打进镜像。

### 6.3 超时

第三方网关首包延迟可能偏高，建议 config.toml 显式设置 `request_timeout = 60`。

### 6.4 端点归属

`QIWEN__BASE_URL` 实为聚合网关（见第 2 节）。若后续改用 DashScope 官方 Key，需重新验证 Responses 端点行为——官方端点是否提供 `/responses`、是否有同样的翻译缺陷，本次调研未覆盖。

---

## 7. 参考资料

- [codex 移除 wire_api = "chat" 的说明 — GitHub Discussion #7782](https://github.com/openai/codex/discussions/7782)
- [OpenAI Codex CLI GitHub](https://github.com/openai/codex)
- [Qwen3-Coder 介绍（256K 原生上下文，可外推 1M）](https://qwen3coder.xyz/)
- [Alibaba Cloud Model Studio 模型与上下文规格](https://tokengratis.id/provider/alibaba-cloud-model-studio)
- [DashScope 地域端点说明（北京/新加坡/美东）](https://blog.spark42.tech)
- 关联调研：[2026-07-15-codex-cli-deepseek-provider-research.md](./2026-07-15-codex-cli-deepseek-provider-research.md)
- 关联调研：[2026-07-15-codex-cli-deepseek-docker-implementation.md](./2026-07-15-codex-cli-deepseek-docker-implementation.md)（@codeproxy/cli Docker 实施计划）
- [@codeproxy/cli — npm](https://www.npmjs.com/package/@codeproxy/cli) / [GitHub](https://github.com/codeproxy-ai/cli)
