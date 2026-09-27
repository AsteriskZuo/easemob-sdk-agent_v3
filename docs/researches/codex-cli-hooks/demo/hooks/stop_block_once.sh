#!/bin/bash
# Stop hook：第一次触发时返回 decision=block 让 agent 继续一轮，
# 第二次（stop_hook_active=true）放行。验证 Stop 可拿到 last_assistant_message 并可"阻断收尾"。
set -u
input=$(cat)
: "${HOOK_LOG:?need HOOK_LOG}"
echo "$input" >> "$HOOK_LOG"
active=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("stop_hook_active"))' <<<"$input")
if [ "$active" = "True" ]; then
  echo '{"continue": true}'
else
  python3 - <<'EOF'
import json
print(json.dumps({
    "decision": "block",
    "reason": "demo: 输出门禁要求再检查一遍，确认后回复 FINAL-OK"
}))
EOF
fi
exit 0
