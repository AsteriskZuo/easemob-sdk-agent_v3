import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { stubFileContent } from "../src/stub.js";

/**
 * stub 生成器测试：把 stubFileContent 生成的内容写进临时文件，
 * 用 node:child_process 真实 spawn `node <file>` 验证协议行为：
 * stdin 任意输入被消费、stdout 一行结果信封、stderr [stub] 标记、退出码 0。
 */
let dir: string;
let stubPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "local-runner-stub-"));
  stubPath = path.join(dir, "stub.js");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 把生成内容写入临时文件并真实执行，stdin 喂入给定字符串。 */
function runStub(content: string, stdinData: string) {
  writeFileSync(stubPath, content);
  return spawnSync(process.execPath, [stubPath], {
    input: stdinData,
    encoding: "utf8",
  });
}

describe("stubFileContent 生成的 stub 程序", () => {
  it("嵌套对象/数组/中文输出：退出码 0，stdout 信封 output 深等于传入值", () => {
    const output = {
      delivered: true,
      list: [1, "两", { nested: [null, false] }],
      msg: "已通知「审查组」✅",
    };
    const result = runStub(
      stubFileContent("wecom-notify", output),
      JSON.stringify({ contract_version: "v1", input: { text: "任意入参" } }),
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope).toEqual({
      contract_version: "v1",
      ok: true,
      output,
    });
    expect(result.stderr).toContain("[stub]");
    expect(result.stderr).toContain("wecom-notify");
  });

  it("output 为 {}（缺省场景，调用方传 {}）：信封 output 为 {}", () => {
    const result = runStub(stubFileContent("jira-comment", {}), "{}");

    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope).toEqual({ contract_version: "v1", ok: true, output: {} });
    expect(result.stderr).toContain("jira-comment");
  });

  it("stdin 内容被消费并截断 200 字符写入 stderr 入参摘要", () => {
    const longInput = "x".repeat(500);
    const result = runStub(stubFileContent("wecom-notify", { ok: 1 }), longInput);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`[stub] wecom-notify input=${"x".repeat(200)}`);
    expect(result.stderr).not.toContain("x".repeat(201));
  });

  it("stdin 为空也能正常出信封（消费 EOF 后忽略内容）", () => {
    const result = runStub(stubFileContent("t", 42), "");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      contract_version: "v1",
      ok: true,
      output: 42,
    });
    expect(result.stderr).toContain("[stub] t input=");
  });
});
