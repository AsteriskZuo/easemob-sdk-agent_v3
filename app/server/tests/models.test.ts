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
