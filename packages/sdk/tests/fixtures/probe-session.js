import { sdk } from "../../dist/index.js";

try {
  await sdk.session.compact();
  await sdk.session.clear();
  sdk.return("done");
} catch (err) {
  sdk.fail(err.message);
}
