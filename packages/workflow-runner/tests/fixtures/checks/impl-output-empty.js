// check-output fixture：仅当信封 output 为空（null/键缺失）时通过（契约 output: null 的判定语义）
import { readFileSync, writeSync } from "node:fs";

const env = JSON.parse(readFileSync(0, "utf8"));
const pass = env.output === null || env.output === undefined;
writeSync(
  1,
  JSON.stringify(
    pass
      ? { contract_version: "v1", ok: true, output: {} }
      : {
          contract_version: "v1",
          ok: false,
          reason: "契约声明无产出（output: null），实际产出了非空值",
        },
  ) + "\n",
);
process.exit(pass ? 0 : 1);
