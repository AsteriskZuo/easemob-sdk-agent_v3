#!/usr/bin/env bash
# codex-cli 链路：单轮审查工单 + 脱敏/还原（调研用，与 pi 版 run-all.sh 对照）
#
# 链路设计（按 codex hook 语义调整，不同于 pi 版）：
#   平台拉工单 → prompt 只携带文件路径（不含工单原文）
#   → LLM 用 shell cat 读取 original.json
#   → PostToolUse hook 拦截工具结果：脱敏 + kv 落盘 + 替换模型可见内容
#   → 模型只见脱敏内容，输出审查结论（含 [ACCOUNT_n] 等 token）
#   → codex exec 结束后，平台侧用 ../restore.ts + kv.json 还原最终输出
#     （codex 的 Stop hook 不能改写最终文本，还原必须在平台侧做——本脚本实证此差异）
#
# 用法: bash codex-run-all.sh [ISSUE_KEY]   （默认 HIM-23706）
# 凭据运行时从 .easemob-agent/config.json 读取，只进进程环境，不落盘、不进 git。
# 隔离：CODEX_HOME 指向本目录 tmp-codex-home/，不触碰 ~/.codex。
set -euo pipefail

ISSUE_KEY="${1:-HIM-23706}"
BASE="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$(dirname "$BASE")"                                  # pi 版目录（复用 jira-tool/masking/restore）
REPO_ROOT="$(cd "$BASE/../../../.." && pwd)"
CONFIG="$REPO_ROOT/.easemob-agent/config.json"
RESULTS="$BASE/results"
export CODEX_HOME="$BASE/tmp-codex-home"                     # 隔离的 codex home
WORKSPACE="$BASE/workspace"
BRIDGE_PORT=18787

mkdir -p "$RESULTS" "$CODEX_HOME" "$WORKSPACE"

# ---- 0. 覆盖式清理中间产物（保证脚本可重复执行）----
rm -f "$RESULTS"/{original.json,masked.json,kv.json,.masked-sha256,hooks.jsonl,stream.jsonl,last-message.txt,final.txt,prompt.txt,codex-stderr.log,debug-tool-response.txt,audit-corpus-files.txt}
rm -rf "$CODEX_HOME/sessions" "$CODEX_HOME/log"

# ---- 1. 模型配置：deepseek（MODEL__*），经 codeproxy 桥接为 Responses API ----
# codex 0.154 已移除 wire_api="chat"，deepseek 原生仅 chat/completions，
# 故用 @codeproxy/cli 做本地协议桥（同 docs/researches/codex-cli/2026-07-15 调研结论）。
MODEL_RAW="$(jq -r '.MODEL__DEFAULT_MODEL' "$CONFIG")"       # 形如 deepseek:deepseek-v4-pro
MODEL_ID="${MODEL_RAW##*:}"
BASE_URL="$(jq -r '.MODEL__BASE_URL' "$CONFIG")"
export DEEPSEEK_API_KEY="$(jq -r '.MODEL__API_KEY' "$CONFIG")"   # 仅存在于进程环境

if ! (exec 3<>"/dev/tcp/127.0.0.1/$BRIDGE_PORT") 2>/dev/null; then
  echo "== 1. 启动 codeproxy 桥（127.0.0.1:${BRIDGE_PORT} → ${BASE_URL}，model=${MODEL_ID}）=="
  nohup npx --yes @codeproxy/cli --base-url "$BASE_URL/v1/chat/completions" \
    --model "$MODEL_ID" --apikey "$DEEPSEEK_API_KEY" -p "$BRIDGE_PORT" \
    > "$RESULTS/codeproxy.log" 2>&1 &
  BRIDGE_PID=$!
  trap 'kill "$BRIDGE_PID" 2>/dev/null || true' EXIT          # 本脚本启动的桥，退出时回收
  for _ in $(seq 1 20); do
    (exec 3<>"/dev/tcp/127.0.0.1/$BRIDGE_PORT") 2>/dev/null && break
    sleep 0.5
  done
else
  echo "== 1. 复用已在监听的 codeproxy 桥（127.0.0.1:${BRIDGE_PORT}）=="
fi

cat > "$CODEX_HOME/config.toml" <<EOF
model = "$MODEL_ID"
model_provider = "deepseek"
# codex 默认会把超长工具输出「掐头去尾」（…N tokens truncated…），
# 会破坏工单 JSON 完整性、触发 hook 的 fail-closed 阻断；这里放宽到足够容纳工单原文。
tool_output_token_limit = 30000

[model_providers.deepseek]
name = "DeepSeek via codeproxy"
base_url = "http://127.0.0.1:$BRIDGE_PORT/v1"
wire_api = "responses"
EOF

# ---- 2. hooks 配置：PostToolUse 拦截工具结果做脱敏（用户层 hooks.json）----
NODE_BIN="$(command -v node)"
cat > "$CODEX_HOME/hooks.json" <<EOF
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$NODE_BIN $BASE/hooks/mask_tool_output.mjs $RESULTS $ISSUE_KEY $RESULTS/original.json",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
EOF

# ---- 3. 拉取真实工单（原始，未脱敏；复用 pi 版工具）----
echo "== 3. 拉取工单 $ISSUE_KEY =="
node "$PI_DIR/jira-tool.ts" "$ISSUE_KEY" > "$RESULTS/original.json"
jq -r '"   key=\(.key) summary=\(.summary[0:40])... comments=\(.comments|length)"' "$RESULTS/original.json"

# ---- 4. 构造 prompt：只给路径，不含工单原文 ----
cat > "$RESULTS/prompt.txt" <<EOF
你是工单审查助手。Jira 工单 $ISSUE_KEY 的完整 JSON 在本机文件：$RESULTS/original.json
请先用 shell 命令 cat 完整读取该文件（不要用 head/sed 截断），然后做单轮审查，直接输出审查结论，包含：
1. 问题摘要（一句话）
2. 涉及的相关方（联系人/负责人，引用工单中的标识）
3. 关键线索（URL/域名/IP/账号等，逐条引用工单中出现的值）
4. 风险与处理建议
要求：结论中引用的标识/URL 等必须原样照抄工单中的写法（包括形如 [ACCOUNT_1] 的占位标识），不要改写、不要补全。
EOF

# ---- 5. 无头跑 codex exec（信任门控放开 + JSONL 事件流 + 落盘最终消息）----
echo "== 5. codex exec（模型 deepseek/${MODEL_ID}，经 codeproxy 桥）=="
(cd "$WORKSPACE" && codex exec --skip-git-repo-check -s read-only \
  --dangerously-bypass-hook-trust \
  --json -o "$RESULTS/last-message.txt" \
  "$(cat "$RESULTS/prompt.txt")" > "$RESULTS/stream.jsonl" 2> "$RESULTS/codex-stderr.log")
echo "   exit=$?"

# ---- 6. fail-closed 校验：hook 必须真的执行过脱敏，否则整链失败 ----
if [ ! -s "$RESULTS/kv.json" ] || [ ! -s "$RESULTS/masked.json" ]; then
  echo "   [FAIL] kv.json/masked.json 未生成——PostToolUse 脱敏 hook 未生效，终止（fail-closed）"
  exit 1
fi
echo "== 6. hook 脱敏已执行（hooks.jsonl 摘要）=="
jq -r '"   \(.event) tool=\(.tool // "-") kvCount=\(.kvCount // "-")"' "$RESULTS/hooks.jsonl" | sort -u

# ---- 7. 平台侧还原（codex 内无法改写最终输出，由平台在 exec 结束后做）----
echo "== 7. 平台侧还原 =="
node "$PI_DIR/restore.ts" "$RESULTS/kv.json" < "$RESULTS/last-message.txt" > "$RESULTS/final.txt" || true
# 注：restore 遇到无映射 token 会以退出码 1 告警，这里不中断脚本，交由 8a 的残留 token 校验判定
wc -c "$RESULTS/final.txt" | awk '{print "   final.txt bytes=" $1}'

# ---- 8. 校验 ----
echo "== 8. 校验 =="
# 8a. 还原完整性：最终输出不应残留可编号 token
if grep -oE '\[(ACCOUNT|URL|IP|HOST|PHONE|APPKEY)_[0-9]+\]' "$RESULTS/final.txt"; then
  echo "   [FAIL] 最终输出残留未还原 token（见上）"
else
  echo "   [OK] 最终输出无残留编号 token"
fi
# 8b. 泄漏审计：kv 中每个原值都不应出现在模型可见内容里
#     （codex 无 LLM 请求体落盘 hook，审计源 = session transcript rollout + --json 事件流）
node - "$RESULTS" "$CODEX_HOME" <<'EOF'
const fs = require("fs"), path = require("path");
const [results, codexHome] = process.argv.slice(2);
const kv = JSON.parse(fs.readFileSync(`${results}/kv.json`, "utf8"));
// 收集审计语料：rollout（sessions/**/*.jsonl）+ stream.jsonl + last-message.txt（还原前）
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith(".jsonl") ? [path.join(dir, e.name)] : []);
}
const rollouts = walk(path.join(codexHome, "sessions"));
let corpus = rollouts.map(f => fs.readFileSync(f, "utf8")).join("\n");
for (const f of ["stream.jsonl", "last-message.txt"]) {
  const p = `${results}/${f}`;
  if (fs.existsSync(p)) corpus += "\n" + fs.readFileSync(p, "utf8");
}
fs.writeFileSync(`${results}/audit-corpus-files.txt`, rollouts.join("\n") + "\n");
let leaks = 0, checked = 0;
for (const cats of Object.values(kv)) for (const tokens of Object.values(cats))
  for (const [token, original] of Object.entries(tokens)) {
    checked++;
    if (original.length >= 4 && corpus.includes(original)) {
      leaks++;
      console.log(`   [LEAK] ${token} 的原值出现在模型可见语料中`);
    }
  }
console.log(leaks === 0
  ? `   [OK] 模型可见语料（rollout×${rollouts.length} + stream + last-message）中 0 泄漏（共检查 ${checked} 个原值）`
  : `   [FAIL] ${leaks}/${checked} 个原值泄漏到模型可见语料`);
// 正对照：脱敏 token 确实进入了模型可见内容（证明语料确实覆盖了模型输入）
const masked = fs.readFileSync(`${results}/masked.json`, "utf8");
const sampleToken = (masked.match(/\[(ACCOUNT|URL|IP|HOST|PHONE|APPKEY)_\d+\]/) || [])[0];
if (sampleToken) {
  console.log(corpus.includes(sampleToken)
    ? `   [OK] 正对照：脱敏 token ${sampleToken} 出现在模型可见语料中`
    : `   [FAIL] 正对照：脱敏 token ${sampleToken} 未出现在语料中，审计语料可能不完整`);
}
EOF
# 8c. 还原正确性：抽样原值应出现在最终输出中
node - "$RESULTS" <<'EOF'
const fs = require("fs");
const dir = process.argv[2];
const kv = JSON.parse(fs.readFileSync(`${dir}/kv.json`, "utf8"));
const final = fs.readFileSync(`${dir}/final.txt`, "utf8");
const flat = Object.assign({}, ...Object.values(kv).flatMap(c => Object.values(c)));
const masked = fs.readFileSync(`${dir}/masked.json`, "utf8");
let hit = 0, total = 0;
for (const [token, original] of Object.entries(flat)) {
  if (!masked.includes(token)) continue; // 只核对确实被用过的 token
  total++;
  if (final.includes(original)) hit++;
}
console.log(`   [信息] kv 共 ${Object.keys(flat).length} 项；最终输出回填命中 ${hit} 个原值（token 是否出现在审查结论中取决于模型输出）`);
EOF

echo "== 完成，产物在 codex/results/ =="
ls -1 "$RESULTS"
