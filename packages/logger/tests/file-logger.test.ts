import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { jest } from "@jest/globals";
import { createFileLogger } from "../src/index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-logger-file-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("createFileLogger", () => {
  it("与 console 同签名：多参数空格连接，落盘与 util.format 一致", () => {
    const file = join(tmp, "a.log");
    const log = createFileLogger(file);
    log.info("alpha", "beta", 42);
    expect(readLines(file)[0].message).toBe(format("alpha", "beta", 42));
  });

  it("与 console 同签名：%s 占位符", () => {
    const file = join(tmp, "b.log");
    const log = createFileLogger(file);
    log.warn("hello %s, %d times", "world", 3);
    expect(readLines(file)[0].message).toBe(
      format("hello %s, %d times", "world", 3),
    );
  });

  it("与 console 同签名：对象参数走 inspect", () => {
    const file = join(tmp, "c.log");
    const log = createFileLogger(file);
    const obj = { a: 1, nested: { b: "x" } };
    log.error("failed:", obj);
    expect(readLines(file)[0].message).toBe(format("failed:", obj));
  });

  it("JSONL 格式：ts/level/message 齐全", () => {
    const file = join(tmp, "d.log");
    const log = createFileLogger(file, { level: "debug" });
    log.debug("dbg");
    log.error("err");
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(typeof line.ts).toBe("string");
      expect(new Date(line.ts as string).toISOString()).toBe(line.ts);
      expect(typeof line.message).toBe("string");
    }
    expect(lines[0].level).toBe("debug");
    expect(lines[1].level).toBe("error");
  });

  it("等级过滤：level=warn 时 info/debug 静默，error/warn 落盘", () => {
    const file = join(tmp, "e.log");
    const log = createFileLogger(file, { level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    const lines = readLines(file);
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("enabled=false 全静默", () => {
    const file = join(tmp, "f.log");
    const log = createFileLogger(file, { enabled: false });
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(existsFile(file)).toBe(false);
  });

  it("脱敏：注册值在任意参数位置被替换为 ***", () => {
    const file = join(tmp, "g.log");
    const log = createFileLogger(file, { secrets: ["super-secret-token"] });
    log.info("token=%s", "super-secret-token");
    log.info("super-secret-token", { key: "super-secret-token" });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("super-secret-token");
    expect(raw).toContain("***");
  });

  it("脱敏：长度 < 8 的值不参与（防误伤）", () => {
    const file = join(tmp, "h.log");
    const log = createFileLogger(file, { secrets: ["short", ""] });
    log.info("this is short and should stay");
    expect(readLines(file)[0].message).toBe("this is short and should stay");
  });

  it("父目录自动创建", () => {
    const file = join(tmp, "deep/nested/dir/x.log");
    const log = createFileLogger(file);
    log.info("hi");
    expect(readLines(file)[0].message).toBe("hi");
  });

  it("写盘异常降级 console.error 兜底，不向上抛", () => {
    const dir = join(tmp, "blocked");
    const file = join(dir, "x.log");
    const log = createFileLogger(file);
    rmSync(dir, { recursive: true });
    writeFileSync(dir, "not a dir"); // 同名文件占位，appendFileSync 必失败
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => log.info("boom")).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

function existsFile(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
