#!/bin/bash
# PostToolUse 阻断 hook：命令已执行，但用 hook 反馈替换模型可见的工具结果
set -u
input=$(cat)
: "${HOOK_LOG:?need HOOK_LOG}"
echo "$input" >> "$HOOK_LOG"
echo '{"decision": "block", "reason": "demo: 该输出未通过审计，禁止模型消费原始结果"}'
exit 0
