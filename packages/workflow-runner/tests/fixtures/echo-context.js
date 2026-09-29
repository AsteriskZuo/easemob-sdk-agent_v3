import { sdk } from "../../../sdk/dist/index.js";

// stdin 注入回显：config / secrets / runInput
sdk.return({
  config: sdk.config(),
  secretApiKey: sdk.secret("api_key"),
  runInput: sdk.runInput(),
});
