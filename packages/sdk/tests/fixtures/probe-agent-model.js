import { sdk } from "../../dist/index.js";

// agent 调用携带 model（provider/id）：请求行应原样透传
try {
  const out = await sdk.agent({
    skills: ["summarize"],
    input: { text: "hi" },
    mode: "fresh",
    model: "ollama/qwen3:8b",
  });
  sdk.return({ agentOut: out });
} catch (err) {
  sdk.fail(err.message);
}
