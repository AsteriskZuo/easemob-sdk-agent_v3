import { writeSync } from "node:fs";
import { sdk } from "../../dist/index.js";

// 重复出口：拦截 process.exit 以观察两次调用（不真正退出），汇报 exit 码序列后自行退出
const exits = [];
const origExit = process.exit.bind(process);
process.exit = (code) => {
  exits.push(code);
};
try {
  sdk.return({ first: 1 });
} catch {
  // exit 被拦截后 sdk 以防禦性 throw 终止出口路径，忽略
}
try {
  sdk.fail("second");
} catch {
  // 同上
}
writeSync(1, JSON.stringify({ exits }) + "\n");
process.exit = origExit;
process.exit(0);
