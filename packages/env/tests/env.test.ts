import { EnvError, getBoolean, getNumber, getString } from "../src/index.js";

const NAMES = [
  "T7_STRING",
  "T7_NUMBER",
  "T7_BOOLEAN",
  "T7_UNSET",
  "T7_DEFAULTED",
  "T7_TYPED",
] as const;

afterEach(() => {
  for (const name of NAMES) delete process.env[name];
});

describe("getString", () => {
  it("正常读取已设置的值", () => {
    process.env.T7_STRING = "hello";
    expect(getString("T7_STRING")).toBe("hello");
  });

  it("未设置 + default → default", () => {
    expect(getString("T7_UNSET", { default: "fallback" })).toBe("fallback");
  });

  it("未设置 + required → EnvError（含变量名）", () => {
    expect(() => getString("T7_UNSET", { required: true })).toThrow(EnvError);
    expect(() => getString("T7_UNSET", { required: true })).toThrow(
      "环境变量 T7_UNSET 未设置",
    );
  });

  it("未设置、无 default、无 required → undefined", () => {
    expect(getString("T7_UNSET")).toBeUndefined();
  });

  it("空串视为未设置", () => {
    process.env.T7_STRING = "";
    expect(getString("T7_STRING")).toBeUndefined();
    process.env.T7_STRING = "   ";
    expect(getString("T7_STRING")).toBeUndefined();
    expect(getString("T7_STRING", { default: "d" })).toBe("d");
  });
});

describe("getNumber", () => {
  it("正常解析数字", () => {
    process.env.T7_NUMBER = "8080";
    expect(getNumber("T7_NUMBER")).toBe(8080);
    process.env.T7_NUMBER = "-1.5";
    expect(getNumber("T7_NUMBER")).toBe(-1.5);
  });

  it("'12abc' → EnvError", () => {
    process.env.T7_NUMBER = "12abc";
    expect(() => getNumber("T7_NUMBER")).toThrow(EnvError);
    expect(() => getNumber("T7_NUMBER")).toThrow("非法数字");
  });

  it("min/max 越界 → EnvError", () => {
    process.env.T7_NUMBER = "5";
    expect(() => getNumber("T7_NUMBER", { min: 10 })).toThrow(EnvError);
    expect(() => getNumber("T7_NUMBER", { min: 10 })).toThrow("越界");
    expect(() => getNumber("T7_NUMBER", { max: 3 })).toThrow(EnvError);
    expect(getNumber("T7_NUMBER", { min: 5, max: 5 })).toBe(5);
  });

  it("未设置三分支：default / required / undefined", () => {
    expect(getNumber("T7_UNSET", { default: 42 })).toBe(42);
    expect(() => getNumber("T7_UNSET", { required: true })).toThrow(
      "环境变量 T7_UNSET 未设置",
    );
    expect(getNumber("T7_UNSET")).toBeUndefined();
  });
});

describe("getBoolean", () => {
  it("'true'/'1'/'TRUE' → true", () => {
    for (const raw of ["true", "1", "TRUE", "True"]) {
      process.env.T7_BOOLEAN = raw;
      expect(getBoolean("T7_BOOLEAN")).toBe(true);
    }
  });

  it("'false'/'0' → false", () => {
    for (const raw of ["false", "0", "FALSE"]) {
      process.env.T7_BOOLEAN = raw;
      expect(getBoolean("T7_BOOLEAN")).toBe(false);
    }
  });

  it("'yes' 等其他值 → EnvError", () => {
    for (const raw of ["yes", "no", "on", "2"]) {
      process.env.T7_BOOLEAN = raw;
      expect(() => getBoolean("T7_BOOLEAN")).toThrow(EnvError);
      expect(() => getBoolean("T7_BOOLEAN")).toThrow("非法布尔");
    }
  });

  it("未设置三分支：default / required / undefined", () => {
    expect(getBoolean("T7_UNSET", { default: true })).toBe(true);
    expect(() => getBoolean("T7_UNSET", { required: true })).toThrow(
      "环境变量 T7_UNSET 未设置",
    );
    expect(getBoolean("T7_UNSET")).toBeUndefined();
  });
});

describe("类型收窄（重载签名）", () => {
  it("required: true 调用返回非 undefined 类型", () => {
    process.env.T7_TYPED = "x";
    const s: string = getString("T7_TYPED", { required: true });
    process.env.T7_TYPED = "1";
    const n: number = getNumber("T7_TYPED", { required: true });
    const b: boolean = getBoolean("T7_TYPED", { required: true });
    expect([s, n, b]).toEqual(["x", 1, true]);
  });

  it("带 default 调用返回非 undefined 类型", () => {
    const s: string = getString("T7_DEFAULTED", { default: "d" });
    const n: number = getNumber("T7_DEFAULTED", { default: 1 });
    const b: boolean = getBoolean("T7_DEFAULTED", { default: false });
    expect([s, n, b]).toEqual(["d", 1, false]);
  });

  it("无 options 调用返回 `| undefined` 类型", () => {
    const s: string | undefined = getString("T7_UNSET");
    const n: number | undefined = getNumber("T7_UNSET");
    const b: boolean | undefined = getBoolean("T7_UNSET");
    expect([s, n, b]).toEqual([undefined, undefined, undefined]);
  });
});
