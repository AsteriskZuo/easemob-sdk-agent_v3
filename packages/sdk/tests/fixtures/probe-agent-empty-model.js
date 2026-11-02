import { sdk } from "../../dist/index.js";

// model 空串 → 本地直接抛错（不发 socket 请求）
try {
  await sdk.agent({ skills: ["a"], input: 1, model: "   " });
  sdk.return({ threw: false });
} catch (err) {
  sdk.return({ threw: true, message: err.message });
}
