import { sdk } from "../../dist/index.js";

// skills 空数组 → agent 调用本地直接抛错（不发 socket 请求）
try {
  await sdk.agent({ skills: [], input: 1 });
  sdk.return({ threw: false });
} catch (err) {
  sdk.return({ threw: true, message: err.message });
}
