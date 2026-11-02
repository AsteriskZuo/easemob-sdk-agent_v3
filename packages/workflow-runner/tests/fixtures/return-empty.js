// main fixture：结果行缺 output 键（等价 SDK 无参 return——JSON.stringify 丢弃 undefined 键）；
// 平台须接受为空产出（归一 null），不得判 missing result
import { writeSync } from "node:fs";

writeSync(1, JSON.stringify({ contract_version: "v1", ok: true }) + "\n");
process.exit(0);
