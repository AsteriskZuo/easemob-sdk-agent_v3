#!/usr/bin/env bash
# 模板验收：拷贝到临时目录 → sdk 依赖改 file: → 安装 → 六条检查
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$ROOT/templates/agent-package/." "$TMP/"
cd "$TMP"
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.dependencies["@asteriskzuo/agent-sdk"] = "file:" + process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
' "$ROOT/packages/sdk"
npm install --no-audit --no-fund
npm run build && npm run typecheck && npm run lint && npm run format:check && npm run circular && npm test
echo "模板验收通过"
