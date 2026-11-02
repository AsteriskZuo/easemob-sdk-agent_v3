import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveDefaultModel,
  enumerateModels,
  prepareBusinessPiModels,
  validateBusinessPiModels,
} from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-models-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateBusinessPiModels（业务原生配置校验，spec §9.2）", () => {
  it("合法配置（含内置 provider 字段简写 baseUrl/apiKey 省略）原样返回", () => {
    const config = {
      providers: {
        deepseek: {
          apiKey: "sk-x",
          models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
        },
      },
      extraTopLevel: { anything: true },
    };
    const result = validateBusinessPiModels(config);
    expect(result).toBe(config); // 原样返回，不重建不深合并
  });

  it("**必须显式声明非空 models**：省略/空数组均拒绝（简写形态已废除）", () => {
    expect(() =>
      validateBusinessPiModels({
        providers: { deepseek: { apiKey: "sk-x" } },
      }),
    ).toThrow(/models 必须是非空数组/);
    expect(() =>
      validateBusinessPiModels({
        providers: { deepseek: { apiKey: "sk-x", models: [] } },
      }),
    ).toThrow(/models 必须是非空数组/);
  });

  it("provider 名为纯整数形态 → 拒绝（保护默认模型派生语义）", () => {
    expect(() =>
      validateBusinessPiModels({
        providers: { "42": { models: [{ id: "m" }] } },
      }),
    ).toThrow(/纯整数形态/);
    expect(() =>
      validateBusinessPiModels({
        providers: { qwen: { models: [{ id: "m" }] } },
      }),
    ).not.toThrow();
  });

  it("空 providers、坏 provider、坏 model、重复 id 均拒绝；错误只含字段路径不泄漏 apiKey", () => {
    expect(() => validateBusinessPiModels({ providers: {} })).toThrow(
      /providers 必须是非空对象/,
    );
    expect(() => validateBusinessPiModels([])).toThrow(/JSON object/);
    expect(() => validateBusinessPiModels({ providers: { p: null } })).toThrow(
      /providers\.p 必须是对象/,
    );
    expect(() =>
      validateBusinessPiModels({
        providers: { p: { models: [{ id: "a" }, { name: "no-id" }] } },
      }),
    ).toThrow(/models\[1\]\.id 必须是非空字符串/);

    const secret = "sk-do-not-leak";
    try {
      validateBusinessPiModels({
        providers: {
          p: {
            baseUrl: 42,
            apiKey: secret,
            models: [{ id: "a" }, { id: "a" }],
          },
        },
      });
      throw new Error("应当拒绝");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("providers.p.baseUrl 必须是字符串");
      expect(message).toContain("id 重复");
      expect(message).not.toContain(secret);
    }
  });
});

describe("enumerateModels / deriveDefaultModel", () => {
  const config = {
    providers: {
      qwen: {
        apiKey: "sk-x",
        models: [{ id: "qwen3-max" }, { id: "qwen-plus" }],
      },
      ollama: {
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [{ id: "qwen3:8b" }],
      },
    },
  };

  it("枚举按声明顺序产出全部 provider/id", () => {
    expect(enumerateModels(config)).toEqual([
      "qwen/qwen3-max",
      "qwen/qwen-plus",
      "ollama/qwen3:8b",
    ]);
  });

  it("默认模型 = 第一个 provider 的第一个模型", () => {
    expect(deriveDefaultModel(config)).toBe("qwen/qwen3-max");
    // 调整 provider 顺序 → 派生结果随之变化（用户经 JSON 顺序控制默认模型）
    const reordered = {
      providers: {
        ollama: (config.providers as Record<string, unknown>).ollama,
        qwen: (config.providers as Record<string, unknown>).qwen,
      },
    } as Record<string, unknown>;
    expect(deriveDefaultModel(reordered)).toBe("ollama/qwen3:8b");
  });
});

describe("prepareBusinessPiModels（业务派生文件）", () => {
  it("原子生成 agent/models.json，目录 0700、文件 0600，返回 agent 目录", () => {
    const config = {
      providers: {
        p: {
          baseUrl: "https://x",
          api: "openai-completions",
          apiKey: "sk-x",
          models: [{ id: "m" }],
        },
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

  it("目录创建失败时抛错且不破坏既有文件", () => {
    const file = join(tmpDir, "not-a-directory");
    writeFileSync(file, "keep");
    expect(() =>
      prepareBusinessPiModels(join(file, "pi"), {
        providers: { p: { models: [{ id: "m" }] } },
      }),
    ).toThrow(/生成失败/);
    expect(readFileSync(file, "utf8")).toBe("keep");
  });
});
