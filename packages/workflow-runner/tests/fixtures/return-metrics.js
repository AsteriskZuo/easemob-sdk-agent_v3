// main fixture：产出含合法平台保留键 metrics（扁平 kv，值 string|number）
import { writeSync } from "node:fs";

writeSync(
  1,
  JSON.stringify({
    contract_version: "v1",
    ok: true,
    output: {
      content: "正文内容",
      metrics: {
        decision: "pass",
        classification: "contact-group",
        score: 0.98,
      },
    },
  }) + "\n",
);
process.exit(0);
