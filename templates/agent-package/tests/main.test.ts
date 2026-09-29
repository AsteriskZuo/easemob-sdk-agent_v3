import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["dist/programs/main.js"], {
      input: stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

describe("main 程序契约", () => {
  it("检查未通过 → stdout ok:false + exit 1（reason 含原因）", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { payload: {} },
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    const result = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("检查未通过");
  });

  it("无注入输入（空 stdin）→ 非零退出", () => {
    const r = run("");
    expect(r.code).not.toBe(0);
  });
});
