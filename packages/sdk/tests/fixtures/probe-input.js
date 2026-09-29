import { sdk } from "../../dist/index.js";

// 回显全部读口：input/runInput/config/secret
sdk.return({
  input: sdk.input(),
  runInput: sdk.runInput(),
  config: sdk.config(),
  secret: sdk.secret("api_key"),
});
