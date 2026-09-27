# codex-cli hooks 行为验证 demo

配套报告：[`../2026-09-26-codex-cli-hooks-research.md`](../2026-09-26-codex-cli-hooks-research.md)
实测环境：macOS（arm64），codex-cli 0.154.0（`/opt/homebrew/bin/codex`），2026-09-26。

## 目录

- `run-all.sh` — 一键复现脚本：自动创建临时 `CODEX_HOME`（`mktemp`），依次验证
  「信任门控」「六类事件触发」「PreToolUse 阻断」「`-c` 动态注入」「`-p` profile 按业务注入」。
- `hooks/` — hook 脚本（均为 bash，从 stdin 读 JSON 事件）：
  - `capture.sh` — 原样记录事件 JSON 到 `$HOOK_LOG`，不做决策；
  - `deny_bash.sh` — PreToolUse 返回 `permissionDecision: "deny"`；
  - `rewrite_bash.sh` — PreToolUse 返回 `allow + updatedInput` 改写命令；
  - `stop_block_once.sh` — Stop 首次返回 `decision: "block"` 强制续跑一轮；
  - `prompt_block.sh` — UserPromptSubmit 命中关键词时 `exit 2` 阻断；
  - `posttool_block.sh` — PostToolUse 返回 `decision: "block"` 替换模型可见结果。
- `out/` — 实测留档的 hook 事件日志 / `--json` 输出（证据，供报告引用）。

## 运行

```bash
bash run-all.sh
```

前置条件：

1. `~/.codex/auth.json` 存在且可用（脚本只会**复制**它到临时目录，不读取内容、不修改原文件）。
   无认证时除实验 1 外无法真实跑模型，但「未信任 hook 静默跳过」这一结论仍可复现。
2. 脚本使用 `grep -vE 'key|token|secret'` 过滤后的 `~/.codex/config.toml` 作为临时 provider 配置；
   使用其他 provider 时请自行调整。
3. 所有实验产物写入 `mktemp -d` 临时目录，不污染 `~/.codex`。

## 关键用法速查

```bash
# 无头执行 + 放开本次 hook 信任 + JSONL 事件输出 + 落盘最终回复
CODEX_HOME=/tmp/xxx codex exec --skip-git-repo-check -s read-only \
  --dangerously-bypass-hook-trust \
  --json -o last-message.txt \
  -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="/path/hook.sh",timeout=10}]}]' \
  "任务 prompt"
```
