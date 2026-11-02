// check-output fixture：仅当信封 output.content === "正文内容" 时通过（验证主程序产出注入）
import { readFileSync, writeSync } from "node:fs";

const env = JSON.parse(readFileSync(0, "utf8"));
const out = env.output;
const pass =
  out !== null &&
  typeof out === "object" &&
  !Array.isArray(out) &&
  out.content === "正文内容";
writeSync(
  1,
  JSON.stringify(
    pass
      ? { contract_version: "v1", ok: true, output: {} }
      : {
          contract_version: "v1",
          ok: false,
          reason: `产出不符合契约：${JSON.stringify(out)}`,
        },
  ) + "\n",
);
process.exit(pass ? 0 : 1);
