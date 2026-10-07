import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelList } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-models-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 写一份 models.json（伪造的占位内容），返回所在目录 */
function writeModelsJson(content: unknown): string {
  const dir = join(tmpDir, `agent-dir-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return dir;
}

describe("loadModelList", () => {
  it("合法多 provider → 全量 provider/id 列表", () => {
    const dir = writeModelsJson({
      providers: {
        "provider-a": {
          baseUrl: "https://a.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-fake-placeholder-a",
          models: [{ id: "model-1" }, { id: "model-2" }],
        },
        "provider-b": {
          baseUrl: "https://b.example.com/v1",
          api: "anthropic-messages",
          apiKey: "sk-fake-placeholder-b",
          models: [{ id: "model-3" }],
        },
      },
    });
    expect(loadModelList(dir)).toEqual([
      "provider-a/model-1",
      "provider-a/model-2",
      "provider-b/model-3",
    ]);
  });

  it("非法 JSON → 抛错说明原因", () => {
    const dir = writeModelsJson("{ not json");
    expect(() => loadModelList(dir)).toThrow(/不是合法 JSON/);
  });

  it("providers 非对象 / 空 providers → 抛错", () => {
    expect(() => loadModelList(writeModelsJson({}))).toThrow(
      /providers 必须是对象/,
    );
    expect(() => loadModelList(writeModelsJson({ providers: [] }))).toThrow(
      /providers 必须是对象/,
    );
    expect(() => loadModelList(writeModelsJson({ providers: {} }))).toThrow(
      /无可用模型/,
    );
  });

  it("全部 provider 空 models → 抛错（全平台列表为空）", () => {
    const dir = writeModelsJson({
      providers: {
        "provider-a": { models: [] },
        "provider-b": { apiKey: "sk-fake" }, // 缺 models 字段
      },
    });
    expect(() => loadModelList(dir)).toThrow(/无可用模型/);
  });

  it("models 项缺 id → 跳过该项不算错；其余正常产出", () => {
    const dir = writeModelsJson({
      providers: {
        "provider-a": {
          models: [{ id: "model-1" }, { name: "no-id" }, { id: "" }, "junk"],
        },
      },
    });
    expect(loadModelList(dir)).toEqual(["provider-a/model-1"]);
  });
});
