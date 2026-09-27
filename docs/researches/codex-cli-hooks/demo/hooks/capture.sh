#!/bin/bash
# 通用 hook 捕获脚本：把 stdin 收到的完整 JSON 追加到 $HOOK_LOG（每行一个事件）
# 用于验证 hook 的触发时机与输入格式。不产生任何决策输出（exit 0，无 stdout）。
set -u
input=$(cat)
: "${HOOK_LOG:?need HOOK_LOG}"
echo "$input" >> "$HOOK_LOG"
exit 0
