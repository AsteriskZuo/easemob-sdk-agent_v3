import { checkFields, loadContract, sdk } from "@asteriskzuo/agent-sdk";

// 出口校验程序（平台三段编排第三阶段，保留程序名 check-output）：
// 解释 contract.json 的 output 契约，校验主程序产出——失败 = run 失败且产出不扇出。
// 信封的 output 字段 = 主程序 sdk.return 的产出（仅本程序被注入）；其余同 check-input 的纯校验纪律。
const { output } = sdk.input();
const contract = loadContract(
  new URL("../../../contract.json", import.meta.url),
);
if (contract.output !== null) {
  const problems = checkFields(contract.output.fields, output);
  if (problems.length > 0) sdk.fail(problems.join("；"));
} else if (output !== null && output !== undefined) {
  // output: null = 声明无产出——产出非空即契约撒谎（stdout 结果行 output 键缺失或为 null 均视为空产出）
  sdk.fail("契约声明无产出（output: null），实际产出了非空值");
}
sdk.return({});
