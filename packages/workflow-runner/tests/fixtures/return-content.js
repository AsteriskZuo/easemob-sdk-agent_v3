// main fixture：返回非空产出 { content: "正文内容" }（配合 check-output 内容断言）
import { writeSync } from "node:fs";

writeSync(
  1,
  JSON.stringify({
    contract_version: "v1",
    ok: true,
    output: { content: "正文内容" },
  }) + "\n",
);
process.exit(0);
