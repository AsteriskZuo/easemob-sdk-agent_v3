# 三模型冒烟验证报告（codeproxy 桥接 + codex）

> 日期：2026-07-22
> 状态：✅ 三个模型全部通过
> 方法：与 [2026-07-20-codex-cli-qwen-provider-research.md](../codex-cli/2026-07-20-codex-cli-qwen-provider-research.md) §3.6 相同，本地以独立 `CODEX_HOME` + codeproxy（`@codeproxy/cli@0.2.9`）验证，机制与 Docker 容器一致

---

## 1. 验证对象

| 模型 | 上游 | model id 确认 |
|---|---|---|
| deepseek-v4-pro | `https://api.deepseek.com/v1`（DeepSeek 官方） | 既有验证沿用 |
| qwen3-coder-plus | `QIWEN__BASE_URL`（聚合网关） | 网关 `/models` 上架 |
| qwen3.7-plus | `QIWEN__BASE_URL`（聚合网关） | 网关 `/models` 上架（另有快照 `qwen3.7-plus-2026-05-26`） |

## 2. 验证用例与结果

每个模型跑三个用例：① 直连 codeproxy 单轮 `/v1/responses`；② codex 多轮工具任务（建文件 → `cat` 验证 → 回复 DONE）；③ `codex exec resume` 会话恢复。

| 模型 | 单轮 | 多轮工具 | resume | 结论 |
|---|---|---|---|---|
| deepseek-v4-pro | ✅ | ✅（文件创建、DONE） | ✅（见第 3 节行为差异） | 通过 |
| qwen3-coder-plus | ✅ | ✅ | ✅（直接凭会话记忆回答） | 通过 |
| qwen3.7-plus | ✅ | ✅ | ✅（相对路径失败后自行改绝对路径恢复） | 通过 |

codeproxy 启动参数与 `docker-entrypoint.sh` 一致：`--base-url <上游> --model <模型> --apikey <key> --upstream-format openai-chat --port <port>`。

## 3. 行为差异记录（非链路问题）

`codex exec resume` **不会恢复首轮会话的工作目录**（cwd 取 resume 时的当前目录）。冒烟中 resume 提示词要求 `cat smoke.txt`（相对路径）：

- qwen3.7-plus：相对路径失败后，从会话历史中找到绝对路径重试成功；
- qwen3-coder-plus：未执行命令，直接凭会话记忆回答正确内容；
- deepseek-v4-pro：两次尝试相对路径失败后如实报错；改用绝对路径重跑 resume 即正确读回内容。

对生产的影响：审查流程是只读 Jira MCP 操作，不依赖 cwd，影响可忽略；但 `src/runtime/codex-cli-adapter.ts` 的 resume 分支不传 `-C`，未来若有依赖工作目录的续聊场景需要注意。

## 4. 结论

三个模型经 codeproxy 桥接在 codex 0.142.5 上均可正常使用，Docker 镜像通过 config.json 的 `MODEL__API_KEY` / `MODEL__BASE_URL` / `MODEL__DEFAULT_MODEL` 三字段即可切换，无需改代码、无需重建镜像。
