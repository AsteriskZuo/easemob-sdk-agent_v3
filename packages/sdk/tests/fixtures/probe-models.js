import { sdk } from "../../dist/index.js";

// models 枚举：op 请求应发 contract_version v2；返回值原样透出
try {
  const info = await sdk.models();
  sdk.return(info);
} catch (err) {
  sdk.fail(err.message);
}
