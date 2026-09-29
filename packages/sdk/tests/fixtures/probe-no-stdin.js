import { sdk } from "../../dist/index.js";

// 无 stdin（空输入）→ input() 抛错；捕获后经 stdout 汇报（不走 sdk.return，避免污染判定）
try {
  sdk.input();
  process.stdout.write("no-throw\n");
} catch (err) {
  process.stdout.write(`threw:${err.message}\n`);
}
