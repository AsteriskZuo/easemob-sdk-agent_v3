import { sdk } from "../../dist/index.js";
import { fileURLToPath } from "node:url";

// 通用子程序调用方：runInput().input = { child: 文件名, args: sdk.run 参数 }
const { input } = sdk.runInput();
const childPath = fileURLToPath(new URL(`./${input.child}`, import.meta.url));
try {
  const out = await sdk.run(childPath, input.args);
  sdk.return({ runOut: out });
} catch (err) {
  sdk.fail(err.message);
}
