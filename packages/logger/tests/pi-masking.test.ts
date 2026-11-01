import {
  PI_MASK_PLACEHOLDER,
  collectPiModelsSecrets,
  findPiMaskPlaceholder,
  maskPiModelsConfig,
  maskPiText,
} from "../src/index.js";

const CONFIG = {
  providers: {
    dashscope: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      apiKey: "sk-dashscope-secret",
      headers: {
        Authorization: "Bearer sk-dashscope-secret",
        "X-Api-Key": "another-secret",
        "X-Normal": "plain",
      },
      models: [
        { id: "qwen-plus", contextWindow: 128000 },
        { id: "qwen-max", apiKey: "nested-key" },
      ],
    },
  },
};

test("maskPiModelsConfig：敏感键递归掩码（含 headers 的 -api-key），非敏感字段与数组结构保留，不改原对象", () => {
  const masked = maskPiModelsConfig(CONFIG);
  const dashscope = (
    masked.providers as Record<string, Record<string, unknown>>
  ).dashscope;
  expect(dashscope.apiKey).toBe(PI_MASK_PLACEHOLDER);
  expect(dashscope.baseUrl).toBe(
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  const headers = dashscope.headers as Record<string, unknown>;
  expect(headers.Authorization).toBe(PI_MASK_PLACEHOLDER);
  expect(headers["X-Api-Key"]).toBe(PI_MASK_PLACEHOLDER);
  expect(headers["X-Normal"]).toBe("plain");
  const models = dashscope.models as Array<Record<string, unknown>>;
  expect(models[0].id).toBe("qwen-plus");
  expect(models[1].apiKey).toBe(PI_MASK_PLACEHOLDER);
  // 原对象不被修改
  expect((CONFIG.providers.dashscope as { apiKey: string }).apiKey).toBe(
    "sk-dashscope-secret",
  );
});

test("collectPiModelsSecrets：只收集敏感字段的非空字符串真值", () => {
  const secrets = collectPiModelsSecrets(CONFIG);
  expect(secrets).toContain("sk-dashscope-secret");
  expect(secrets).toContain("another-secret");
  expect(secrets).toContain("nested-key");
  expect(secrets).not.toContain("plain");
  expect(secrets).not.toContain("qwen-plus");
});

test("maskPiText：按长度从长到短替换全部出现处", () => {
  const text = "key=sk-dashscope-secret 又见 sk-dashscope-secret";
  expect(maskPiText(text, ["sk-dashscope-secret"])).toBe(
    `key=${PI_MASK_PLACEHOLDER} 又见 ${PI_MASK_PLACEHOLDER}`,
  );
  // 长短包含关系：先替换长的
  expect(maskPiText("abc-secret", ["abc", "abc-secret"])).toBe(
    PI_MASK_PLACEHOLDER,
  );
});

test("findPiMaskPlaceholder：命中掩码占位返回路径，未命中 undefined", () => {
  const dirty = {
    providers: { p: { apiKey: PI_MASK_PLACEHOLDER } },
  };
  expect(findPiMaskPlaceholder(dirty)).toBe("providers.p.apiKey");
  expect(findPiMaskPlaceholder(CONFIG)).toBeUndefined();
});
