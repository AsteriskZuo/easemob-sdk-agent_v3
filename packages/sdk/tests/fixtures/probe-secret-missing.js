import { sdk } from "../../dist/index.js";

// secret 未注入名 → 抛错
try {
  sdk.secret("nope");
  sdk.return({ threw: false });
} catch (err) {
  sdk.return({ threw: true, message: err.message });
}
