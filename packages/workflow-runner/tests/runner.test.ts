import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkflowRunner } from "../src/index.js";
import { extractMetrics } from "../src/runner.js";
import type { RunRequest } from "../src/index.js";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../tests/fixtures/${name}`, import.meta.url),
  );
}

const SECRET_VALUE = "sk-live-abcdef123456"; // >= 8 字符，参与脱敏替换

function makeEvent(sessionId = "sess-1"): EventEnvelope {
  return {
    contract_version: "v1",
    source: "manual",
    event_id: "evt_test_1",
    event_type: "test.run",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    correlation_id: "evt_test_1",
    hop_count: 0,
    payload: { hello: "world" },
  };
}

function makeReq(program: string, over: Partial<RunRequest> = {}): RunRequest {
  return {
    program: fixturePath(program),
    programs: {},
    event: makeEvent(),
    business_id: "biz-1",
    config: { region: "cn", flag: "on" },
    secrets: { api_key: SECRET_VALUE },
    endpoint: { socket_path: "/tmp/nonexistent-agent.sock", token: "tok" },
    quota: { timeout_minutes: 5 },
    ...over,
  };
}

/** 每个用例独立 workspaceRoot，返回 { root, runner } */
function setup(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wf-runner-"));
  const runner = createWorkflowRunner({ workspaceRoot: root, ...over });
  return { root, runner };
}

/** run 工作区根：{root}/businesses/{business_id}/runs/{source}/{session_id}（console-design §6 布局） */
function runsRootOf(root: string, sessionId = "sess-1"): string {
  return join(root, "businesses", "biz-1", "runs", "manual", sessionId);
}

/** 业务日志目录：{root}/businesses/{business_id}/logs/{source}/{session_id} */
function logsRootOf(root: string, sessionId = "sess-1"): string {
  return join(root, "businesses", "biz-1", "logs", "manual", sessionId);
}

describe("WorkflowRunner", () => {
  it("1. 成功：回显 input + cwd 是工作区，目录按三维路径创建", async () => {
    const { root, runner } = setup();
    const req = makeReq("success.js");
    const outcome = await runner.run(req);
    expect(outcome.status).toBe("success");
    const output = outcome.output as Record<string, any>;
    expect(output.event).toEqual(req.event);
    // cwd = 注入的 workspace = {root}/businesses/biz-1/runs/manual/sess-1/{run_id}
    // （macOS /var→/private/var 符号链接：cwd 是真实路径，比较前 realpath）
    expect(output.cwd).toBe(realpathSync(output.workspace));
    const runsDir = runsRootOf(root);
    expect(existsSync(runsDir)).toBe(true);
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    expect(runDirs[0]).toMatch(/^run_/);
    expect(output.workspace).toBe(join(runsDir, runDirs[0]));
    expect(existsSync(output.workspace)).toBe(true);
  });

  it("2. stdin 注入：config/secrets 经 sdk 读口回显一致", async () => {
    const { runner } = setup();
    const req = makeReq("echo-context.js");
    const outcome = await runner.run(req);
    expect(outcome.status).toBe("success");
    const output = outcome.output as Record<string, any>;
    expect(output.config).toEqual(req.config);
    expect(output.secretApiKey).toBe(SECRET_VALUE);
    expect(output.runInput).toEqual({ input: req.event, config: req.config });
  });

  it("2b. 信封携带 programs 映射原样到达业务进程", async () => {
    const { runner } = setup();
    const programs = {
      "jira-fetch": "/platform/cache/assets/ast_x/programs/fetch.js",
    };
    const outcome = await runner.run(makeReq("echo-programs.js", { programs }));
    expect(outcome.status).toBe("success");
    expect((outcome.output as Record<string, any>).programs).toEqual(programs);
  });

  it("2c. 信封含 dataDir 且目录已建：{root}/businesses/{business_id}/data/{source}/{session_id}", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(makeReq("echo-datadir.js"));
    expect(outcome.status).toBe("success");
    const output = outcome.output as Record<string, any>;
    const expected = join(
      root,
      "businesses",
      "biz-1",
      "data",
      "manual",
      "sess-1",
    );
    expect(output.dataDir).toBe(expected);
    expect(output.exists).toBe(true);
    expect(existsSync(expected)).toBe(true);
  });

  it("2d. 信封含 cacheDir 且目录已建：{root}/businesses/{business_id}/cache", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(makeReq("echo-cachedir.js"));
    expect(outcome.status).toBe("success");
    const output = outcome.output as Record<string, any>;
    const expected = join(root, "businesses", "biz-1", "cache");
    expect(output.cacheDir).toBe(expected);
    expect(output.exists).toBe(true);
    expect(existsSync(expected)).toBe(true);
  });

  it("3. 业务失败：sdk.fail → failed、reason 含原因", async () => {
    const { runner } = setup();
    const outcome = await runner.run(makeReq("biz-fail.js"));
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("业务处理失败");
  });

  it("4. 异常退出：exit 非零无合法结果 → failed、reason 含 exit code", async () => {
    const { runner } = setup();
    const outcome = await runner.run(makeReq("crash.js"));
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("exit code 1");
  });

  it("5. 超时：quota 到点强杀 → timeout", async () => {
    const { runner } = setup({ killGraceMs: 200 });
    const outcome = await runner.run(
      makeReq("sleep.js", { quota: { timeout_minutes: 0.002 } }), // 120ms
    );
    expect(outcome.status).toBe("timeout");
    expect(outcome.reason).toContain("timeout");
  }, 15000);

  it("6. 输出上限：超 maxOutputBytes → failed('output too large')", async () => {
    const { runner } = setup({ maxOutputBytes: 1024, killGraceMs: 200 });
    const outcome = await runner.run(makeReq("flood.js"));
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("output too large");
  }, 15000);

  it("7. exit 0 无结果 → failed('missing result')", async () => {
    const { runner } = setup();
    const outcome = await runner.run(makeReq("silent.js"));
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("missing result");
  });

  it("8. 业务日志：结构化行 + 原样行落盘，secrets 值被脱敏", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(makeReq("biz-log.js"));
    expect(outcome.status).toBe("success");
    const logsDir = logsRootOf(root);
    const logFiles = readdirSync(logsDir);
    expect(logFiles).toHaveLength(1);
    expect(logFiles[0]).toMatch(/^run_.*\.log$/);
    const content = readFileSync(join(logsDir, logFiles[0]), "utf8");
    // secrets 值不出现在日志文件（被替换为 ***）
    expect(content).not.toContain(SECRET_VALUE);
    expect(content).toContain("***");
    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // 结构化行：level/message + fields 独立字段（不打平进 message）
    const structured = lines.find(
      (l) => typeof l.message === "string" && l.message.includes(" masked "),
    );
    expect(structured).toBeDefined();
    expect(structured?.level).toBe("info");
    expect(structured?.fields).toEqual({ k: 1 });
    // JSON 字符串字段值嵌套为对象；数字形字符串保真不转
    const nested = lines.find((l) => l.message === "nested");
    expect(nested?.fields).toEqual({ payload: { a: 1 }, id: "12345" });
    // 非结构化行：原样透传
    const raw = lines.find(
      (l) =>
        typeof l.message === "string" && l.message.includes("raw noise line"),
    );
    expect(raw).toBeDefined();
  });

  it("9. 路径安全：session_id 含 '/' → run 抛错（不进目录创建）", async () => {
    const { root, runner } = setup();
    await expect(
      runner.run(makeReq("success.js", { event: makeEvent("bad/segment") })),
    ).rejects.toThrow();
    expect(existsSync(join(root, "runs"))).toBe(false);
  });

  it("10. 只认一次：第一个合法结果被采信，其后垃圾与第二个结果忽略", async () => {
    const { runner } = setup();
    const outcome = await runner.run(makeReq("double-result.js"));
    expect(outcome.status).toBe("success");
    expect(outcome.output).toBe("first");
  });

  it("平台错误：program 不存在 → 抛错", async () => {
    const { runner } = setup();
    await expect(runner.run(makeReq("no-such-program.js"))).rejects.toThrow(
      "program 不存在或不可读",
    );
  });

  it("11. 传入 run_id → 跳过内部生成，workspace/业务日志按传入值派生", async () => {
    const { root, runner } = setup();
    const runId = "run_0123456789ABCDEFGHJKMNPQRS";
    const outcome = await runner.run(makeReq("biz-log.js", { run_id: runId }));
    expect(outcome.status).toBe("success");
    expect(existsSync(join(runsRootOf(root), runId))).toBe(true);
    expect(existsSync(join(logsRootOf(root), `${runId}.log`))).toBe(true);
  });

  it("12. 非法 run_id 形 → 抛错（平台自身错误），不建目录", async () => {
    const { root, runner } = setup();
    await expect(
      runner.run(makeReq("success.js", { run_id: "not-a-run-id" })),
    ).rejects.toThrow(/^invalid run_id: not-a-run-id$/);
    // 小写/含排除字符/长度不符同样非法
    await expect(
      runner.run(
        makeReq("success.js", { run_id: "run_0123456789abcdefghijklmnop" }),
      ),
    ).rejects.toThrow(/^invalid run_id/);
    expect(existsSync(join(root, "runs"))).toBe(false);
  });
});

describe("三段编排（契约检查）", () => {
  /** 指定 fixture 包目录的保留名 programs 映射（平铺布局：check-*.js 直接位于包根，contract.json 同级） */
  function pkgPrograms(pkg: string): Record<string, string> {
    return {
      "check-input": fixturePath(`${pkg}/check-input.js`),
      "check-output": fixturePath(`${pkg}/check-output.js`),
    };
  }

  /** 读该 run 的业务日志全文（断言跳过/警告日志用） */
  function readRunLog(root: string): string {
    const logsDir = logsRootOf(root);
    const logFiles = readdirSync(logsDir);
    expect(logFiles).toHaveLength(1);
    return readFileSync(join(logsDir, logFiles[0]), "utf8");
  }

  it("13. 三段成功：check-input 过（最小注入，无 secrets/endpoint/programs/dataDir）→ main → check-output 收到产出", async () => {
    const { runner } = setup();
    // 多层嵌套布局：check 程序在 pkg-full/apps/<name>/index.js，contract.json 在两级之上的包根（验证近端祖先定位）
    const outcome = await runner.run(
      makeReq("return-content.js", {
        programs: {
          "check-input": fixturePath("pkg-full/apps/check-input/index.js"),
          "check-output": fixturePath("pkg-full/apps/check-output/index.js"),
        },
      }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.failed_at).toBeUndefined();
    expect(outcome.output).toEqual({ content: "正文内容" });
  });

  it("14. check-input 失败 → run 失败 failed_at=check-input，不进 main", async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("return-content.js", { programs: pkgPrograms("pkg-input-fail") }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("check-input");
    expect(outcome.reason).toContain("缺少必填字段 payload.issue_key");
  });

  it("15. check-output 失败 → run 失败 failed_at=check-output，产出不扇出", async () => {
    const { runner } = setup();
    // 契约要求 content 非空，但 main 产出为空（结果行缺 output 键）
    const outcome = await runner.run(
      makeReq("return-empty.js", {
        programs: {
          "check-input": fixturePath("pkg-full/apps/check-input/index.js"),
          "check-output": fixturePath("pkg-full/apps/check-output/index.js"),
        },
      }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("check-output");
    expect(outcome.reason).toContain("产出不符合契约");
    expect(outcome.output).toBeUndefined();
  });

  it("16. 契约 input:null → 跳过 check-input（即使该程序会失败），main 与 check-output 照常", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(
      makeReq("return-content.js", { programs: pkgPrograms("pkg-input-null") }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.output).toEqual({ content: "正文内容" });
    expect(readRunLog(root)).toContain("跳过 check-input 阶段");
  });

  it("17. 契约 output:null + main 空产出（结果行缺 output 键）→ 成功，产出归一为 null", async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("return-empty.js", {
        programs: pkgPrograms("pkg-output-null"),
      }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.output).toBeNull();
  });

  it("18. 契约 output:null + main 非空产出 → check-output 失败 failed_at=check-output", async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("return-content.js", {
        programs: pkgPrograms("pkg-output-null"),
      }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("check-output");
    expect(outcome.reason).toContain("实际产出了非空值");
  });

  it("19. main 失败 → failed_at=main（check-input 已通过）", async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("biz-fail.js", {
        programs: {
          "check-input": fixturePath("pkg-full/apps/check-input/index.js"),
          "check-output": fixturePath("pkg-full/apps/check-output/index.js"),
        },
      }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("main");
    expect(outcome.reason).toContain("业务处理失败");
  });

  it("20. 有 check 程序但无 contract.json → 按旧结构资产跳过两个 check 阶段（记 warn）", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(
      makeReq("return-content.js", {
        programs: pkgPrograms("pkg-no-contract"),
      }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.output).toEqual({ content: "正文内容" });
    expect(readRunLog(root)).toContain("未找到 contract.json");
  });

  it("21. contract.json 非法 JSON → 按旧结构资产跳过两个 check 阶段（记 warn）", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(
      makeReq("return-content.js", {
        programs: pkgPrograms("pkg-bad-contract"),
      }),
    );
    expect(outcome.status).toBe("success");
    expect(readRunLog(root)).toContain("读取/解析失败");
  });

  it("22. check 阶段超时（60s 平台常量，测试注入小值）→ run 失败 failed_at=check-input", async () => {
    const { runner } = setup({ checkTimeoutMs: 200, killGraceMs: 50 });
    const outcome = await runner.run(
      makeReq("return-content.js", { programs: pkgPrograms("pkg-sleep") }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("check-input");
    expect(outcome.reason).toContain("timeout after 200ms");
  }, 15000);
});

describe("phases: main-only（定时任务专用，spec 2026-11-13 D4）", () => {
  /** 读该 run 的业务日志全文（断言跳过日志用） */
  function readRunLog(root: string): string {
    const logsDir = logsRootOf(root);
    const logFiles = readdirSync(logsDir);
    expect(logFiles).toHaveLength(1);
    return readFileSync(join(logsDir, logFiles[0]), "utf8");
  }

  it("有 check 程序的资产也只跑 main：跳过日志落盘、产出正常解析、无 failed_at", async () => {
    const { root, runner } = setup();
    // pkg-full 契约要求 payload.issue_key（事件 payload 没有）：三段编排必被 check-input 误杀，
    // main-only 直接跳过契约探测与两段 check
    const outcome = await runner.run(
      makeReq("return-content.js", {
        programs: {
          "check-input": fixturePath("pkg-full/apps/check-input/index.js"),
          "check-output": fixturePath("pkg-full/apps/check-output/index.js"),
        },
        phases: "main-only",
      }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.failed_at).toBeUndefined();
    expect(outcome.output).toEqual({ content: "正文内容" });
    expect(readRunLog(root)).toContain(
      "main-only 模式：跳过契约校验阶段（定时任务）",
    );
  });

  it("main-only 下 metrics 保留键仍从 main 产出剥离", async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("return-metrics.js", { phases: "main-only" }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.metrics).toEqual({
      decision: "pass",
      classification: "contact-group",
      score: 0.98,
    });
    expect(outcome.output).toEqual({ content: "正文内容" });
  });

  it("main-only 下 main 失败 → failed_at 恒 main", async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("biz-fail.js", {
        programs: {
          "check-input": fixturePath("pkg-full/apps/check-input/index.js"),
        },
        phases: "main-only",
      }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("main");
  });

  it('显式 phases: "all" → 与缺省逐点一致（check-input 失败 failed_at=check-input，不进 main）', async () => {
    const { runner } = setup();
    const outcome = await runner.run(
      makeReq("return-content.js", {
        programs: {
          "check-input": fixturePath("pkg-input-fail/check-input.js"),
          "check-output": fixturePath("pkg-input-fail/check-output.js"),
        },
        phases: "all",
      }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failed_at).toBe("check-input");
    expect(outcome.reason).toContain("缺少必填字段 payload.issue_key");
  });
});

describe("metrics 保留键剥离（契约 D / spec 决策 7）", () => {
  /** 读该 run 的业务日志全文（断言 warn 用） */
  function readRunLog(root: string): string {
    const logsDir = logsRootOf(root);
    const logFiles = readdirSync(logsDir);
    expect(logFiles).toHaveLength(1);
    return readFileSync(join(logsDir, logFiles[0]), "utf8");
  }

  const VALID_METRICS = {
    decision: "pass",
    classification: "contact-group",
    score: 0.98,
  };

  it("23. 合法 metrics → 提取进 outcome.metrics，output 删键，run 成功且不告警", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(makeReq("return-metrics.js"));
    expect(outcome.status).toBe("success");
    expect(outcome.metrics).toEqual(VALID_METRICS);
    expect(outcome.output).toEqual({ content: "正文内容" });
    expect(readRunLog(root)).not.toContain("metrics 形状非法");
  });

  it("24. 非法形状逐类（非对象/数组/null/键名非法/超 50 键/布尔值/嵌套对象/超 200 字符）→ 丢弃 + warn + run 仍成功 + output 删键", async () => {
    const cases = [
      "not-object",
      "array",
      "null",
      "bad-key",
      "too-many",
      "bool-value",
      "nested-value",
      "long-string",
    ];
    for (const c of cases) {
      const { root, runner } = setup();
      const outcome = await runner.run(
        makeReq("return-metrics-invalid.js", { config: { case: c } }),
      );
      expect(outcome.status).toBe("success");
      expect(outcome.metrics).toBeUndefined();
      // 保留键任何情况下都不进出口（产出其余部分原样保留）
      expect(outcome.output).toEqual({ content: "正文内容" });
      expect(readRunLog(root)).toContain("metrics 形状非法，已丢弃");
    }
  });

  it("25. 无 metrics 键的产出原样（对象产出与非对象产出都不动）", async () => {
    const { runner } = setup();
    const objOutcome = await runner.run(makeReq("return-content.js"));
    expect(objOutcome.status).toBe("success");
    expect(objOutcome.output).toEqual({ content: "正文内容" });
    expect(objOutcome.metrics).toBeUndefined();
    // 非 plain object 产出（字符串）原样返回
    const strOutcome = await runner.run(makeReq("double-result.js"));
    expect(strOutcome.status).toBe("success");
    expect(strOutcome.output).toBe("first");
    expect(strOutcome.metrics).toBeUndefined();
  });

  it("26. 剥离点位置：check-output 注入信封仍含 metrics 原始键，最终产出已剥离", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(
      makeReq("return-metrics.js", {
        programs: {
          "check-output": fixturePath("pkg-metrics/check-output.js"),
        },
      }),
    );
    expect(outcome.status).toBe("success");
    // check-output 把收到的信封 output 落盘在 run 工作区：必须看到含 metrics 的原始产出
    const runDir = readdirSync(runsRootOf(root))[0];
    const saw = JSON.parse(
      readFileSync(
        join(runsRootOf(root), runDir, "check-saw-output.json"),
        "utf8",
      ),
    );
    expect(saw).toEqual({ content: "正文内容", metrics: VALID_METRICS });
    // 最终 RunOutcome：metrics 已提取、output 无保留键
    expect(outcome.metrics).toEqual(VALID_METRICS);
    expect(outcome.output).toEqual({ content: "正文内容" });
  });

  it("27. extractMetrics 纯函数边界：NaN/Infinity、键数与字符串长边界、空 metrics、非 plain 产出同一引用", () => {
    // NaN / Infinity 无法经 stdout JSON 线构造（JSON 序列化为 null），只能直测纯函数
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = extractMetrics({ a: 1, metrics: { x: bad } });
      expect(r.invalid).toBe(true);
      expect(r.metrics).toBeUndefined();
      expect(r.output).toEqual({ a: 1 });
    }
    // 键数边界：50 合法、51 非法
    const keys = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `k${String(i).padStart(2, "0")}`,
          i,
        ]),
      );
    expect(extractMetrics({ metrics: keys(50) })).toEqual({
      output: {},
      metrics: keys(50),
      invalid: false,
    });
    expect(extractMetrics({ metrics: keys(51) }).invalid).toBe(true);
    // 字符串长边界：200 合法、201 非法
    expect(
      extractMetrics({ metrics: { s: "x".repeat(200) } }).invalid,
    ).toBe(false);
    expect(
      extractMetrics({ metrics: { s: "x".repeat(201) } }).invalid,
    ).toBe(true);
    // 空 metrics 对象：形状合法，提取为空表
    expect(extractMetrics({ a: 1, metrics: {} })).toEqual({
      output: { a: 1 },
      metrics: {},
      invalid: false,
    });
    // 非 plain object / 无 metrics 键：同一引用原样返回
    for (const raw of ["s", null, [1], { a: 1 }]) {
      const r = extractMetrics(raw);
      expect(r).toEqual({ output: raw, invalid: false });
      expect(r.output).toBe(raw);
    }
  });
});
