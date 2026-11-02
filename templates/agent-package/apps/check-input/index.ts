import { checkFields, loadContract, sdk } from "@asteriskzuo/agent-sdk";

// 入口检查程序（平台三段编排第一阶段，保留程序名 check-input）：
// 解释 contract.json 的 input 契约——required 项查存在 + 类型，可选项不查（声明仅供展示）。
// 纯校验纪律：只判过/不过、不做转换（解析归 main）；平台对本阶段最小注入（无 secrets/endpoint/programs/dataDir）。
// 需要更强校验（跨字段一致性、值域、条件必填等）时，业务可自写本程序替换——平台契约（存在、过/不过语义）不变。
const { event } = sdk.input();
const contract = loadContract(
  new URL("../../../contract.json", import.meta.url),
);
if (contract.input !== null) {
  const problems = checkFields(contract.input.fields, event);
  if (problems.length > 0) sdk.fail(problems.join("；"));
}
sdk.return({});
