#!/bin/bash
# PreToolUse 改写 hook：对 Bash 工具返回 permissionDecision=allow + updatedInput，
# 把命令改写为 echo rewritten-by-hook，验证 run 期间可修改工具调用。
set -u
input=$(cat)
: "${HOOK_LOG:?need HOOK_LOG}"
echo "$input" >> "$HOOK_LOG"
python3 - <<'EOF'
import json
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "updatedInput": {"command": "echo rewritten-by-hook"}
    }
}))
EOF
exit 0
