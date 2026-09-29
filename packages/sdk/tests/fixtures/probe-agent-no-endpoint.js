import { sdk } from "../../dist/index.js";

// stdin 信封无 endpoint → agent 调用抛错
try {
  await sdk.agent({ skill: "x", input: 1 });
  sdk.return({ threw: false });
} catch (err) {
  sdk.return({ threw: true, message: err.message });
}
