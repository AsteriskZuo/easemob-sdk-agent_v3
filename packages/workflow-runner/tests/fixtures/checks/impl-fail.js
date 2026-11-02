// check 程序 fixture：恒失败（模拟入口检查/出口校验不过）
import { writeSync } from "node:fs";

writeSync(
  1,
  JSON.stringify({
    contract_version: "v1",
    ok: false,
    reason: "输入不合规：缺少必填字段 payload.issue_key",
  }) + "\n",
);
process.exit(1);
