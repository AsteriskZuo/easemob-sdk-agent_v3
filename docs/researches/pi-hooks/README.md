# pi hooks 调研 demo

本目录是 pi 0.87.1 hooks（extension）能力调研的实验产物，报告见
[`2026-09-26-pi-hooks-research.md`](./2026-09-26-pi-hooks-research.md)。

## 目录结构

- `demo-extension/hook-logger.ts` — demo extension：记录所有 hook 触发到 JSONL，
  并演示前置阻断（input）、工具调用阻断/入参改写（tool_call）、结果改写（tool_result）、
  输出改写（message_end）。行为由环境变量控制（见文件头注释）。
- `scripts/run-all.sh` — 一键复现全部 9 个实验。
- `sdk-test/sdk-inline-hook.mjs` — SDK 内联 extension 冒烟测试（实验9）。
- `results/` — 各实验的 hook 日志（`*-hooks.jsonl`）与 JSON 模式事件流（`*-stream.jsonl`）。
- `tmp-agentdir/`、`tmp-agentdir-bizA/` — 隔离的 agent 目录（`PI_CODING_AGENT_DIR`），
  内含最小 ollama `models.json`（`apiKey` 为哑值，不含任何真实凭据），避免污染 `~/.pi/agent/`。
- `tmp-project/` — 实验6c 用的项目目录（`.pi/extensions/`）。

## 运行前提

1. 本机运行 ollama 且有 `qwen3.6:latest` 模型（实验用本地模型，不消耗云端额度）；
   换其他模型请修改 `scripts/run-all.sh` 里的 `MODEL` 与 `tmp-agentdir/models.json`。
2. `pi` 在 PATH 中，或通过 `PI=/path/to/pi bash scripts/run-all.sh` 指定。
3. sdk-test 需要先建立包软链（已在仓库内）：
   `mkdir -p sdk-test/node_modules/@earendil-works && ln -sfn <pi安装目录> sdk-test/node_modules/@earendil-works/pi-coding-agent`

## 运行

```bash
bash scripts/run-all.sh
```

或单独跑一个最小例子（前置阻断演示）：

```bash
export PI_CODING_AGENT_DIR=$PWD/tmp-agentdir
PI_HOOK_LOG=$PWD/results/demo.jsonl \
  pi -p --no-session -e ./demo-extension/hook-logger.ts \
  --model ollama/qwen3.6:latest "BLOCK_THIS_INPUT do something"
# 预期: 无任何输出，exit=0，results/demo.jsonl 中可见 input_blocked，且无 agent_start
```
