import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLogger, logger, resetForTests } from "../src/index.js";

let tmp: string;
let logsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-logger-facade-"));
  logsDir = join(tmp, "logs");
});

afterEach(() => {
  resetForTests();
  rmSync(tmp, { recursive: true, force: true });
});

function readLines(fileName: string): Record<string, unknown>[] {
  return readFileSync(join(logsDir, fileName), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("全局外观纪律", () => {
  it("未初始化调用 logger.for → 抛错", () => {
    expect(() => logger.for({ module: "queue" })).toThrow();
  });

  it("未初始化调用 addSecrets → 抛错", () => {
    expect(() => logger.addSecrets(["some-secret-value"])).toThrow();
  });

  it("initLogger 重复调用 → 抛错", () => {
    initLogger({ logsDir });
    expect(() => initLogger({ logsDir })).toThrow();
  });

  it("fail-fast：logsDir 被同名文件占位（不可写）→ initLogger 抛错", () => {
    writeFileSync(logsDir, "not a dir");
    expect(() => initLogger({ logsDir })).toThrow();
  });
});

describe("路由", () => {
  it("entry-loop / exit-loop / 其他模块各归各位", () => {
    initLogger({ logsDir });
    logger.for({ module: "entry-loop" }).info("in-entry");
    logger.for({ module: "exit-loop" }).info("in-exit");
    logger.for({ module: "queue" }).info("in-system");
    expect(readLines("entry-loop.log")[0].message).toBe("in-entry");
    expect(readLines("exit-loop.log")[0].message).toBe("in-exit");
    expect(readLines("system.log")[0].message).toBe("in-system");
  });
});

describe("CategoryLogger", () => {
  it("绑定字段落盘：module + component + message", () => {
    initLogger({ logsDir });
    logger.for({ module: "queue", component: "take" }).info("msg");
    const line = readLines("system.log")[0];
    expect(line.module).toBe("queue");
    expect(line.component).toBe("take");
    expect(line.message).toBe("msg");
    expect(line.level).toBe("info");
    expect(typeof line.ts).toBe("string");
  });

  it("with()：继承 + 追加 + 同名覆盖；原实例不受影响", () => {
    initLogger({ logsDir });
    const base = logger.for({ module: "queue", a: 1 });
    const child = base.with({ b: 2 });
    const overwritten = child.with({ a: 10, c: 3 });
    base.info("from-base");
    child.info("from-child");
    overwritten.info("from-overwritten");
    const [l1, l2, l3] = readLines("system.log");
    expect(l1).toMatchObject({ module: "queue", a: 1, message: "from-base" });
    expect(l1.b).toBeUndefined();
    expect(l2).toMatchObject({ a: 1, b: 2, message: "from-child" });
    expect(l3).toMatchObject({
      a: 10,
      b: 2,
      c: 3,
      message: "from-overwritten",
    });
  });

  it("链式两次叠加正确", () => {
    initLogger({ logsDir });
    const chained = logger
      .for({ module: "queue" })
      .with({ event_id: "evt-1" })
      .with({ correlation_id: "corr-1" });
    chained.info("chained");
    expect(readLines("system.log")[0]).toMatchObject({
      module: "queue",
      event_id: "evt-1",
      correlation_id: "corr-1",
      message: "chained",
    });
  });

  it("增量字段自由：任意自定义字段原样落盘", () => {
    initLogger({ logsDir });
    logger
      .for({ module: "db" })
      .info("query done", { sql: "SELECT 1", tokens: 42 });
    expect(readLines("system.log")[0]).toMatchObject({
      sql: "SELECT 1",
      tokens: 42,
      message: "query done",
    });
  });

  it("等级过滤与 enabled 由全局控制共享", () => {
    initLogger({ logsDir, level: "warn" });
    const cat = logger.for({ module: "queue" });
    cat.info("skipped");
    cat.error("kept");
    const lines = readLines("system.log");
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("kept");
  });
});

describe("addSecrets（append-only）", () => {
  it("登记后的密钥在后续日志中被替换，含已创建实例的输出", () => {
    initLogger({ logsDir });
    const cat = logger.for({ module: "queue" });
    cat.info("before", { token: "runtime-secret-1" });
    logger.addSecrets(["runtime-secret-1"]);
    cat.info("after", { token: "runtime-secret-1" });
    const raw = readFileSync(join(logsDir, "system.log"), "utf8");
    const [first, second] = raw.trim().split("\n");
    expect(first).toContain("runtime-secret-1"); // 登记前不打码
    expect(second).not.toContain("runtime-secret-1");
    expect(second).toContain("***");
  });
});
