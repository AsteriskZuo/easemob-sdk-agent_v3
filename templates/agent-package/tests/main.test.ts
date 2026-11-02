import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["dist/apps/main/index.js"], {
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

describe("main 程序（主流程薄壳；入口/出口检查归 check 程序）", () => {
  it("无注入输入（空 stdin）→ 非零退出", () => {
    const r = run("");
    expect(r.code).not.toBe(0);
  });

  it("无 endpoint 的 mock 信封 → agent 边界抛错，非零退出且 stdout 无结果行（fail-closed）", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { payload: { text: "hello" } },
        workspace: ".",
      }),
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('"ok":true');
    expect(r.stdout).not.toContain('"ok":false');
  });
});
