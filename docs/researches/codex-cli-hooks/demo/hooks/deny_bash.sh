#!/bin/bash
# PreToolUse 阻断 hook：对 Bash 工具一律返回 permissionDecision=deny
# 同时把事件记录到 $HOOK_LOG，用于验证阻断语义。
set -u
input=$(cat)
: "${HOOK_LOG:?need HOOK_LOG}"
echo "$input" >> "$HOOK_LOG"
python3 - <<'EOF'
import json
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "demo: 平台策略禁止执行 Bash 工具"
    }
}))
EOF
exit 0
