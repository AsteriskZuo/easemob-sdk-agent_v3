#!/usr/bin/env bash
# pi hooks 调研实验一键复现脚本
# 用法: bash scripts/run-all.sh
# 前提: 本机 ollama 已运行且有 qwen3.6:latest 模型；pi 在 PATH 或修改下方 PI 变量。
set -u
PI="${PI:-pi}"
BASE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE"

# 隔离的 agent 目录（不污染 ~/.pi/agent），内含最小 ollama models.json（apiKey 是哑值，ollama 忽略）
export PI_CODING_AGENT_DIR="$BASE/tmp-agentdir"
mkdir -p "$PI_CODING_AGENT_DIR"
cat > "$PI_CODING_AGENT_DIR/models.json" <<'EOF'
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen3.6:latest" }]
    }
  }
}
EOF

MODEL="ollama/qwen3.6:latest"
COMMON="-p --no-session --no-skills --no-prompt-templates --no-context-files --model $MODEL"
EXT="-e ./demo-extension/hook-logger.ts"
mkdir -p results

run() { # $1=实验名 $2...=额外参数， prompt 从 stdin 后的最后一个参数传入
  local name="$1"; shift
  echo "=== $name ==="
  PI_HOOK_LOG="$BASE/results/$name-hooks.jsonl" "$PI" "$@" 2>"results/$name-stderr.log"
  echo "exit=$?"
}

rm -f results/*.jsonl results/*.log

# 实验1: 基础触发顺序 + tool_result 改写（JSON 模式）
run exp1 $COMMON $EXT --mode json --tools bash \
  "Use the bash tool to run exactly: echo hello-from-pi. Then report the output." > "results/exp1-stream.jsonl"

# 实验2: tool_call 阻断（命令含 FORBIDDEN）
run exp2 $COMMON $EXT --mode json --tools bash \
  "Use the bash tool to run exactly: echo FORBIDDEN_data. Then report the output." > "results/exp2-stream.jsonl"

# 实验3: tool_call 原地改写入参（REWRITE_ME -> rewritten-by-hook）
run exp3 $COMMON $EXT --mode json --tools bash \
  "Use the bash tool to run exactly: echo REWRITE_ME. Then report the exact output." > "results/exp3-stream.jsonl"

# 实验4: 前置阻断（input 返回 handled，不发起 LLM 调用）
run exp4 $COMMON $EXT --mode json --tools bash \
  "BLOCK_THIS_INPUT please do something" > "results/exp4-stream.jsonl"

# 实验5: 后置改写（message_end 替换 assistant 消息，print 模式 stdout 可见）
echo "=== exp5a 对照（不改写）==="
run exp5a $COMMON $EXT --no-tools "Reply with exactly: hello world"
echo "=== exp5b 后置改写 ==="
PI_HOOK_REWRITE_OUTPUT=1 run exp5b $COMMON $EXT --no-tools "Reply with exactly: hello world"

# 实验6a: 对照组，不加载扩展（不应产生 hook 日志）
run exp6a $COMMON --no-tools "Reply with exactly: A"

# 实验6b: --no-extensions 关闭自动发现，但显式 -e 仍生效
run exp6b $COMMON --no-extensions $EXT --no-tools "Reply with exactly: B"

# 实验6c: 项目级 .pi/extensions（无头模式需 --approve 信任项目文件）
mkdir -p tmp-project/.pi/extensions
cp demo-extension/hook-logger.ts tmp-project/.pi/extensions/biz-hook.ts
( cd tmp-project && PI_HOOK_LOG="$BASE/results/exp6c-hooks.jsonl" "$PI" $COMMON --approve --no-tools "Reply with exactly: C" )

# 实验7: 按业务 agent 目录 + settings.json 声明 extensions（无 -e）
mkdir -p tmp-agentdir-bizA
cp tmp-agentdir/models.json tmp-agentdir-bizA/models.json
cat > tmp-agentdir-bizA/settings.json <<EOF
{ "extensions": ["$BASE/demo-extension/hook-logger.ts"] }
EOF
PI_HOOK_LOG="$BASE/results/exp7-hooks.jsonl" PI_CODING_AGENT_DIR="$BASE/tmp-agentdir-bizA" \
  "$PI" $COMMON --no-tools "Reply with exactly: D"

# 实验8: tool_call handler 抛错 -> fail-safe 阻断
run exp8 $COMMON $EXT --mode json --tools bash \
  "Use the bash tool to run exactly: echo THROW_ME. Then report the output." > "results/exp8-stream.jsonl"

# 实验9: SDK 内联 extension（同进程编程式注入，无需扩展文件）
( cd sdk-test && PI_CODING_AGENT_DIR="$BASE/tmp-agentdir" PI_MODEL="$MODEL" node sdk-inline-hook.mjs )

echo "全部实验完成，产物在 results/"
