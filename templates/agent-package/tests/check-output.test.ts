import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/apps/check-output/index.js"],
      { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

/** check-output 阶段信封：output = 主程序产出（仅本阶段注入） */
function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract_version: "v1",
    input: { payload: { text: "hello" } },
    workspace: ".",
    ...over,
  });
}

function lastResult(stdout: string): {
  ok: boolean;
  reason?: string;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("check-output 程序（解释 contract.json 的 output 契约，校验主程序产出）", () => {
  it("output.answer 为 string → ok:true + exit 0", () => {
    const r = run(envelope({ output: { answer: "通过" } }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("缺 answer → ok:false + exit 1，reason 含缺失路径", () => {
    const r = run(envelope({ output: {} }));
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("answer");
  });

  it("output 整体未注入（undefined）→ 视同缺失，ok:false", () => {
    const r = run(envelope());
    expect(r.code).toBe(1);
    expect(lastResult(r.stdout).ok).toBe(false);
  });

  it("answer 类型错（object）→ ok:false，reason 含期望类型", () => {
    const r = run(envelope({ output: { answer: { text: "x" } } }));
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("期望 string");
  });
});
