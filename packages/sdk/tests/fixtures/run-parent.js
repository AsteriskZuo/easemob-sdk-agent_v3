import { sdk } from "../../dist/index.js";

// 通用子程序调用方：runInput().input = { child: 程序名, args: sdk.run 参数 }
// 程序名→物化绝对路径映射由平台 stdin 信封的 programs 注入，sdk.run 按名查表（业务不接触路径）
const { input } = sdk.runInput();
try {
  const out = await sdk.run(input.child, input.args);
  sdk.return({ runOut: out });
} catch (err) {
  sdk.fail(err.message);
}
