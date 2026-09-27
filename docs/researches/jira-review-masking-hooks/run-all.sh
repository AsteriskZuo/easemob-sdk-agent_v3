#!/usr/bin/env bash
# 工单审查 + 脱敏/还原 hook 完整链路验证（调研用）
# 用法: bash run-all.sh [ISSUE_KEY]   （默认 HIM-23706）
# 凭据运行时从 .easemob-agent/config.json 读取，不落盘、不进 git。
set -euo pipefail

ISSUE_KEY="${1:-HIM-23706}"
BASE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$BASE/../../.." && pwd)"
CONFIG="$REPO_ROOT/.easemob-agent/config.json"
PI="${PI:-/Users/asterisk/.local/state/fnm_multishells/44659_1790414121698/bin/pi}"
RESULTS="$BASE/results"
AGENT_DIR="$BASE/tmp-agentdir"

mkdir -p "$RESULTS" "$AGENT_DIR"

# ---- 0. 模型配置：deepseek（OpenAI 兼容），apiKey 用 $VAR 插值，不写进文件 ----
MODEL_RAW="$(jq -r '.MODEL__DEFAULT_MODEL' "$CONFIG")"          # 形如 deepseek:deepseek-v4-pro
MODEL_ID="${MODEL_RAW##*:}"                                     # 去掉 provider 前缀
BASE_URL="$(jq -r '.MODEL__BASE_URL' "$CONFIG")"
export DEEPSEEK_API_KEY="$(jq -r '.MODEL__API_KEY' "$CONFIG")"  # 仅存在于进程环境
cat > "$AGENT_DIR/models.json" <<EOF
{
  "providers": {
    "deepseek": {
      "baseUrl": "$BASE_URL",
      "api": "openai-completions",
      "apiKey": "\$DEEPSEEK_API_KEY",
      "models": [{ "id": "$MODEL_ID" }]
    }
  }
}
EOF

# ---- 1. 拉取真实工单（原始，未脱敏）----
echo "== 1. 拉取工单 $ISSUE_KEY =="
node "$BASE/jira-tool.ts" "$ISSUE_KEY" > "$RESULTS/original.json"
jq -r '"   key=\(.key) summary=\(.summary[0:40])... comments=\(.comments|length)"' "$RESULTS/original.json"

# ---- 2. 构造审查 prompt（约定分隔标记包裹工单 JSON）----
echo "== 2. 构造 prompt =="
{
  cat <<'EOF'
你是工单审查助手。本消息末尾有一个以 ISSUE_JSON 标记包裹的 Jira 工单（JSON）。
请做单轮审查，直接输出审查结论，包含：
1. 问题摘要（一句话）
2. 涉及的相关方（联系人/负责人，引用工单中的标识）
3. 关键线索（URL/域名/IP/账号等，逐条引用工单中出现的值）
4. 风险与处理建议
要求：结论中引用的标识/URL 等必须原样照抄工单中的写法，不要改写。
EOF
  echo "<<<ISSUE_JSON"
  cat "$RESULTS/original.json"
  echo ">>>"
} > "$RESULTS/prompt.txt"

# ---- 3. 无头跑 pi：隔离 agent 目录 + 只显式加载本扩展 ----
echo "== 3. pi -p --mode json（模型 deepseek/${MODEL_ID}）=="
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export MASK_RESULTS_DIR="$RESULTS"
rm -f "$RESULTS"/{kv.json,masked.json,hooks.jsonl,llm-payload.jsonl,restored.txt}
"$PI" -p --mode json --no-session --no-skills --no-prompt-templates --no-context-files \
  --no-extensions -e "$BASE/extension/masking-hooks.ts" \
  --model "deepseek/$MODEL_ID" --no-tools \
  "$(cat "$RESULTS/prompt.txt")" > "$RESULTS/stream.jsonl" 2> "$RESULTS/pi-stderr.log"
echo "   exit=$?"

# ---- 4. 提取最终 assistant 输出（已经被 message_end hook 还原过）----
echo "== 4. 提取最终输出 =="
jq -r 'select(.type=="message_end" and .message.role=="assistant") | .message.content[] | select(.type=="text") | .text' \
  "$RESULTS/stream.jsonl" | tail -n +1 > "$RESULTS/final-all.txt"
# 最后一条 assistant 消息 = 审查结论
jq -rs '[.[] | select(.type=="message_end" and .message.role=="assistant")] | last | .message.content[] | select(.type=="text") | .text' \
  "$RESULTS/stream.jsonl" > "$RESULTS/final.txt"
wc -c "$RESULTS/final.txt" | awk '{print "   final.txt bytes=" $1}'

# ---- 5. 校验 ----
echo "== 5. 校验 =="
# 5a. 还原完整性：最终输出不应残留可编号 token（[REDACTED] 除外——但审查结论中本不该出现）
if grep -oE '\[(ACCOUNT|URL|IP|HOST|PHONE|APPKEY)_[0-9]+\]' "$RESULTS/final.txt"; then
  echo "   [FAIL] 最终输出残留未还原 token（见上）"
else
  echo "   [OK] 最终输出无残留编号 token"
fi
# 5b. LLM 请求体泄漏检查：kv 中每个原值都不应出现在 llm-payload.jsonl
node - "$RESULTS" <<'EOF'
const fs = require("fs");
const dir = process.argv[2];
const kv = JSON.parse(fs.readFileSync(`${dir}/kv.json`, "utf8"));
const payload = fs.readFileSync(`${dir}/llm-payload.jsonl`, "utf8");
let leaks = 0, checked = 0;
for (const cats of Object.values(kv)) for (const tokens of Object.values(cats))
  for (const [token, original] of Object.entries(tokens)) {
    checked++;
    if (original.length >= 4 && payload.includes(original)) {
      leaks++;
      console.log(`   [LEAK] ${token} 的原值出现在 LLM 请求体中`);
    }
  }
console.log(leaks === 0
  ? `   [OK] LLM 请求体中 0 泄漏（共检查 ${checked} 个原值）`
  : `   [FAIL] ${leaks}/${checked} 个原值泄漏到 LLM 请求体`);
EOF
# 5c. 还原正确性：抽样原值应出现在最终输出中
node - "$RESULTS" <<'EOF'
const fs = require("fs");
const dir = process.argv[2];
const kv = JSON.parse(fs.readFileSync(`${dir}/kv.json`, "utf8"));
const final = fs.readFileSync(`${dir}/final.txt`, "utf8");
const flat = Object.assign({}, ...Object.values(kv).flatMap(c => Object.values(c)));
const tokensInMasked = fs.readFileSync(`${dir}/masked.json`, "utf8");
let hit = 0, total = 0;
for (const [token, original] of Object.entries(flat)) {
  if (!tokensInMasked.includes(token)) continue; // 只核对确实被用过的 token
  total++;
  if (final.includes(original)) hit++;
}
console.log(`   [信息] kv 共 ${Object.keys(flat).length} 项；最终输出回填命中 ${hit} 个原值（token 是否出现在审查结论中取决于模型输出）`);
EOF

echo "== 完成，产物在 results/ =="
ls -1 "$RESULTS"
