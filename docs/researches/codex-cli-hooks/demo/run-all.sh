#!/bin/bash
# codex-cli hooks 行为一键复现脚本（codex-cli 0.154.0 实测）
#
# 用法：bash run-all.sh
# 说明：
#   - 全程使用 mktemp 临时目录作为 CODEX_HOME，不污染用户全局 ~/.codex
#   - 为能真实调用模型，会把 ~/.codex/auth.json 与 config.toml 复制进临时 CODEX_HOME
#     （只复制、不读取、不修改原文件；若你的环境用 API key/其他 provider，请自行改写）
#   - 所有 hook 事件 JSON 落盘到 $WORKDIR/hook-log.jsonl
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(mktemp -d /tmp/codex-hooks-lab.XXXXXX)"
export CODEX_HOME="$WORKDIR/home"
export HOOK_LOG="$WORKDIR/hook-log.jsonl"
mkdir -p "$CODEX_HOME" "$WORKDIR/proj"
: > "$HOOK_LOG"

# 复制认证与 provider 配置（不读取内容）
cp ~/.codex/auth.json "$CODEX_HOME/auth.json"
grep -vE 'key|token|secret' ~/.codex/config.toml > "$CODEX_HOME/config.toml"

echo "== 实验目录: $WORKDIR"

# ---------- 实验 1：六类事件全部触发 ----------
cat > "$CODEX_HOME/hooks.json" <<EOF
{"hooks": {
  "SessionStart":     [{"hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/capture.sh", "timeout": 10}]}],
  "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/capture.sh", "timeout": 10}]}],
  "PreToolUse":       [{"matcher": "*", "hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/capture.sh", "timeout": 10}]}],
  "PostToolUse":      [{"matcher": "*", "hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/capture.sh", "timeout": 10}]}],
  "Stop":             [{"hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/capture.sh", "timeout": 10}]}],
  "SessionEnd":       [{"hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/capture.sh", "timeout": 3}]}]
}}
EOF
cd "$WORKDIR/proj"
echo "== 实验1a：不带 --dangerously-bypass-hook-trust（hook 应静默不触发）"
codex exec --skip-git-repo-check -s read-only "请运行 echo t1，然后回复 DONE" >/dev/null 2>&1 || true
echo "   hook 事件数（预期 0）: $(wc -l < "$HOOK_LOG")"

echo "== 实验1b：带 --dangerously-bypass-hook-trust（6 类事件应全部触发）"
codex exec --skip-git-repo-check -s read-only --dangerously-bypass-hook-trust \
  "请运行 echo t1，然后回复 DONE" >/dev/null 2>&1 || true
echo "   hook 事件数（预期 6）: $(wc -l < "$HOOK_LOG")"

# ---------- 实验 2：PreToolUse 阻断 ----------
cat > "$CODEX_HOME/hooks.json" <<EOF
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "$DEMO_DIR/hooks/deny_bash.sh", "timeout": 10}]}]}}
EOF
: > "$HOOK_LOG"
echo "== 实验2：PreToolUse deny（命令不应执行，exec 退出码仍为 0）"
codex exec --skip-git-repo-check -s read-only --dangerously-bypass-hook-trust \
  "请运行 echo SHOULD-NOT-RUN 并告诉我输出" 2>&1 | tail -2

# ---------- 实验 3：-c 动态注入 hook（无需 hooks.json）----------
rm -f "$CODEX_HOME/hooks.json"
: > "$HOOK_LOG"
echo "== 实验3：-c 内联 TOML 注入 PreToolUse hook"
codex exec --skip-git-repo-check -s read-only --dangerously-bypass-hook-trust \
  -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="'"$DEMO_DIR"'/hooks/capture.sh",timeout=10}]}]' \
  "请运行 echo dash-c，然后回复 DONE" >/dev/null 2>&1 || true
echo "   hook 事件数（预期 1）: $(wc -l < "$HOOK_LOG")"

# ---------- 实验 4：profile 按业务注入 ----------
cat > "$CODEX_HOME/bizA.config.toml" <<EOF
[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "$DEMO_DIR/hooks/deny_bash.sh"
timeout = 10
EOF
echo "== 实验4：-p bizA profile 注入 deny hook（命令应被阻断）"
codex exec --skip-git-repo-check -s read-only --dangerously-bypass-hook-trust -p bizA \
  "请运行 echo profileA 并告诉我输出" 2>&1 | tail -2

echo "== 完成。hook 原始事件日志: $HOOK_LOG"
