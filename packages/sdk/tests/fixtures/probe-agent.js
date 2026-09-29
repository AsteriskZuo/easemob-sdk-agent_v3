import { sdk } from "../../dist/index.js";

// agent 调用：endpoint 从 stdin 信封读取；失败原因经 sdk.fail 透出
try {
  const out = await sdk.agent({
    skill: "summarize",
    input: { text: "hi" },
    mode: "fresh",
  });
  sdk.return({ agentOut: out });
} catch (err) {
  sdk.fail(err.message);
}
