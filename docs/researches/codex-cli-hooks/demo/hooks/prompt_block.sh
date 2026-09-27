#!/bin/bash
# UserPromptSubmit 阻断 hook：prompt 含机密关键词时阻断（exit 2 + stderr），
# 验证"前置检查"类需求能否由 UserPromptSubmit 承担。
set -u
input=$(cat)
: "${HOOK_LOG:?need HOOK_LOG}"
echo "$input" >> "$HOOK_LOG"
if grep -q 'SECRET' <<<"$input"; then
  echo "demo: prompt 包含机密关键词，已阻断" >&2
  exit 2
fi
exit 0
