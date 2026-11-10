// check-output fixture：把注入信封里的 output 落盘到 workspace，供测试断言剥离点位置
// （check 阶段必须看到含 metrics 保留键的原始产出，剥离发生在 check-output 之后）
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const env = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(
  join(env.workspace, "check-saw-output.json"),
  JSON.stringify(env.output === undefined ? null : env.output),
);
writeSync(
  1,
  JSON.stringify({ contract_version: "v1", ok: true, output: {} }) + "\n",
);
process.exit(0);
