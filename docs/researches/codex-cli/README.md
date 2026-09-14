# Codex CLI 调研

本目录记录 Codex CLI 作为多业务场景执行框架 `Runtime Adapter` 的技术调研。

- `2026-07-11-codex-cli-runtime-research.md`: 调研结论、证据、架构建议和风险点。
- `2026-07-15-codex-cli-deepseek-provider-research.md`: 调研 Codex CLI（v0.142.5）在 Docker 中接入 DeepSeek API 的整体方案。梳理了协议鸿沟（Codex 默认 Responses API vs DeepSeek Chat Completions），对比三种接入路径（方案 A 直连 `wire_api="chat"`、方案 B 本地协议桥接 CC Switch、方案 C OpenRouter BYOK），并给出"方案 A 优先、方案 B 保底"的推荐及对应 Docker 改造步骤、API Key 安全与模型名等注意事项。
- `2026-07-15-codex-cli-deepseek-docker-implementation.md`: 方案 B（Responses↔Chat Completions 协议桥接）在 Docker 中的深入调研与实施计划。对比两个桥接实现候选 CC Switch CLI 与 @codeproxy/cli，推荐以 @codeproxy/cli 为主、CC Switch 备用，并给出 Dockerfile / docker-entrypoint.sh / docker-codeproxy.json / config.docker.toml / src/config.ts 的具体改动清单与风险评估。
- `2026-07-15-codeproxy-verification-and-plan.md`: @codeproxy/cli 的实测验证报告与 Docker 落地实施方案。记录了 `curl /v1/responses` 打通 DeepSeek V4 Pro 的实测结果、关键依赖信息、容器内进程模型（tini→entrypoint→codeproxy+node→codex）与信号清理流程，并列出兼容性、多轮工具调用、流式 tool_use 还原等仍待端到端验证的问题。
- `2026-07-20-codex-cli-qwen-provider-research.md`: Codex CLI 在 Docker 中接入千问（Qwen / DashScope 聚合网关）的实测调研。验证了网关 Chat Completions 全链路可用（单轮/流式/多轮工具调用，覆盖 qwen3-coder-plus 等四个模型）、Responses 端点 `function_call_output` 回传必现 400 的网关侧缺陷、codex 0.142.5 已移除 `wire_api="chat"`，并端到端实测通过 @codeproxy/cli 桥接路线（多轮工具任务与会话恢复均成功），推荐其为 Docker 落地方案。
- `2026-07-23-manual-codex-startup-failure-jira-mcp-cwd.md`: 手动在项目根目录启动 codex 失败（jira MCP ENOENT）的排查结论。根因是 `.codex/config.toml` 中 jira MCP 的 `cwd` 相对 codex 进程工作目录解析、本为运行时/Docker 布局设计，且 `required = true` 导致 session 初始化失败；手动调试用 `codex -c 'mcp_servers.jira.cwd = ".agents/mcps/jira"'` 覆盖即可。
- `codex-exec-smoke-test.mjs`: 在目标机器或 Docker 容器内验证 `codex exec`、JSONL 输出、最终消息文件、MCP/skill 可见性的最小脚本。

