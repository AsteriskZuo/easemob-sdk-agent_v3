import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelList,
  preparePiModels,
  validatePiModelsConfig,
} from "../src/index.js";
import type { PiModelsConfig } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-models-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function validModels(): PiModelsConfig {
  return {
    providers: {
      "test-provider": {
        baseUrl: "https://test-provider.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-fake-placeholder",
        headers: { "X-Test": "preserved" },
        models: [{ id: "model-a", contextWindow: 128000 }, { id: "model-b" }],
      },
    },
  };
}

/** 写一份派生 models.json（伪造的占位内容），返回所在目录 */
function writeModelsJson(content: unknown): string {
  const dir = join(tmpDir, `agent-dir-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return dir;
}

describe("validatePiModelsConfig", () => {
  it("合法配置保留完整对象并按声明顺序产出 provider/id", () => {
    const config = validModels();
    const result = validatePiModelsConfig(config);
    expect(result.config).toBe(config);
    expect(result.models).toEqual([
      "test-provider/model-a",
      "test-provider/model-b",
    ]);
  });

  it("空 providers、坏 provider、空 models、坏 model、重复 id 均拒绝", () => {
    const invalidValues: unknown[] = [
      {},
      { providers: [] },
      { providers: {} },
      { providers: { p: null } },
      { providers: { p: { models: [{ id: "m" }] } } },
      {
        providers: {
          p: {
            baseUrl: "https://p.example.com/v1",
            api: "openai-completions",
            apiKey: "sk-fake",
            models: [],
          },
        },
      },
      {
        providers: {
          p: {
            baseUrl: "https://p.example.com/v1",
            api: "openai-completions",
            apiKey: "sk-fake",
            models: [{ id: "m" }, { name: "missing-id" }, { id: "m" }],
          },
        },
      },
    ];
    for (const value of invalidValues) {
      expect(() => validatePiModelsConfig(value)).toThrow();
    }
  });

  it("错误只含字段路径，不泄漏 apiKey", () => {
    const secret = "sk-sentinel-must-not-leak";
    const config = validModels();
    config.providers["test-provider"]!.apiKey = secret;
    config.providers["test-provider"]!.models = [];
    let message = "";
    try {
      validatePiModelsConfig(config);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("models");
    expect(message).not.toContain(secret);
  });
});

describe("preparePiModels", () => {
  it("首次生成完整文件，目录 0700、文件 0600，模型列表可读取", () => {
    const dir = join(tmpDir, "nested", "agent");
    const config = validModels();
    preparePiModels(dir, config);
    expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toEqual(
      config,
    );
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "models.json")).mode & 0o777).toBe(0o600);
    expect(loadModelList(dir)).toEqual([
      "test-provider/model-a",
      "test-provider/model-b",
    ]);
  });

  it("再次启动同步新配置，不残留临时文件", () => {
    const dir = join(tmpDir, "agent");
    preparePiModels(dir, validModels());
    const updated = validModels();
    updated.providers["test-provider"]!.apiKey = "sk-updated-placeholder";
    updated.providers["test-provider"]!.models = [{ id: "model-c" }];
    preparePiModels(dir, updated);
    expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toEqual(
      updated,
    );
    expect(loadModelList(dir)).toEqual(["test-provider/model-c"]);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("非法源配置不覆盖已有派生文件", () => {
    const dir = join(tmpDir, "agent");
    preparePiModels(dir, validModels());
    const before = readFileSync(join(dir, "models.json"), "utf8");
    const invalid = validModels();
    invalid.providers["test-provider"]!.models = [];
    expect(() => preparePiModels(dir, invalid)).toThrow(/models/);
    expect(readFileSync(join(dir, "models.json"), "utf8")).toBe(before);
  });

  it("目录创建失败时抛错且不破坏既有文件", () => {
    const file = join(tmpDir, "not-a-directory");
    writeFileSync(file, "keep");
    expect(() => preparePiModels(join(file, "agent"), validModels())).toThrow(
      /生成失败/,
    );
    expect(readFileSync(file, "utf8")).toBe("keep");
  });
});

describe("loadModelList", () => {
  it("非法 JSON → 抛错说明原因", () => {
    const dir = writeModelsJson("{ not json");
    expect(() => loadModelList(dir)).toThrow(/不是合法 JSON/);
  });

  it("派生文件存在坏 model 时严格失败，不静默跳过", () => {
    const dir = writeModelsJson({
      providers: {
        "test-provider": {
          baseUrl: "https://test-provider.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-fake-placeholder",
          models: [{ id: "model-a" }, { name: "missing-id" }],
        },
      },
    });
    expect(() => loadModelList(dir)).toThrow(/models\[1\]\.id/);
  });
});

import {
  prepareBusinessPiModels,
  validateBusinessPiModels,
} from "../src/models.js";

describe("validateBusinessPiModels（业务原生配置校验）", () => {
  it("内置 provider 简写（无 models）+ 未知字段原样保留", () => {
    const config = {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          api: "openai-completions",
          apiKey: "sk-x",
          headers: { "X-Custom": "keep" },
        },
      },
      extraTopLevel: { anything: true },
    };
    const result = validateBusinessPiModels(config, "deepseek/deepseek-chat");
    expect(result).toBe(config); // 原样返回，不重建不深合并
  });

  it("显式 models 时 id 必须归属该 provider", () => {
    const config = {
      providers: {
        dashscope: {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "sk-x",
          models: [{ id: "qwen-plus" }],
        },
      },
    };
    expect(() =>
      validateBusinessPiModels(config, "dashscope/qwen-max"),
    ).toThrow(/不在 provider\.dashscope\.models 中/);
    expect(() =>
      validateBusinessPiModels(config, "dashscope/qwen-plus"),
    ).not.toThrow();
  });

  it("model 非 provider/id、provider 不存在、坏结构均拒绝；错误不含 apiKey", () => {
    expect(() => validateBusinessPiModels({ providers: {} }, "a/b")).toThrow(
      /providers 必须是非空对象/,
    );
    expect(() => validateBusinessPiModels([], "a/b")).toThrow(/JSON object/);
    expect(() =>
      validateBusinessPiModels(
        { providers: { p: { apiKey: "sk-x" } } },
        "qwen-plus",
      ),
    ).toThrow(/provider\/id 形式/);
    expect(() =>
      validateBusinessPiModels(
        { providers: { p: { apiKey: "sk-x" } } },
        "other/m",
      ),
    ).toThrow(/provider 不在配置中: other/);
    // 坏字段类型 + 重复 id；错误不含 apiKey 值
    try {
      validateBusinessPiModels(
        {
          providers: {
            p: {
              baseUrl: 42,
              models: [{ id: "a" }, { id: "a" }],
              apiKey: "sk-do-not-leak",
            },
          },
        },
        "p/a",
      );
      throw new Error("应当拒绝");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("providers.p.baseUrl 必须是字符串");
      expect(message).toContain("id 重复");
      expect(message).not.toContain("sk-do-not-leak");
    }
  });
});

describe("prepareBusinessPiModels（业务派生文件）", () => {
  it("原子生成 agent/models.json，目录 0700、文件 0600，返回 agent 目录", () => {
    const config = {
      providers: {
        p: { baseUrl: "https://x", api: "openai-completions", apiKey: "sk-x" },
      },
    };
    const agentDir = prepareBusinessPiModels(
      join(tmpDir, "cache", "pi"),
      config,
    );
    const stat = statSync(join(agentDir, "models.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")),
    ).toEqual(config);
    // 幂等覆盖：再次生成同内容成功
    const again = prepareBusinessPiModels(join(tmpDir, "cache", "pi"), config);
    expect(again).toBe(agentDir);
  });
});
