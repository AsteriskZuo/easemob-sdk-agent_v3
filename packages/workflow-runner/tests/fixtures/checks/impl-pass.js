// check 程序 fixture：入口检查通过；同时断言最小注入（纯校验纪律：check 阶段信封不得含 secrets/endpoint/programs/dataDir）
import { readFileSync, writeSync } from "node:fs";

const env = JSON.parse(readFileSync(0, "utf8"));
const forbidden = ["secrets", "endpoint", "programs", "dataDir"].filter(
  (key) => key in env,
);
if (forbidden.length > 0) {
  writeSync(
    1,
    JSON.stringify({
      contract_version: "v1",
      ok: false,
      reason: `最小注入被破坏：check 信封含 ${forbidden.join(", ")}`,
    }) + "\n",
  );
  process.exit(1);
}
writeSync(
  1,
  JSON.stringify({ contract_version: "v1", ok: true, output: {} }) + "\n",
);
process.exit(0);
