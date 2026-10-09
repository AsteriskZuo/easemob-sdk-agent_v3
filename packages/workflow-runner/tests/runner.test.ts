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

/** run 工作区根：{root}/runs/{source}/{session_id}/{business_id}（console-design §6 布局） */
function runsRootOf(root: string, sessionId = "sess-1"): string {
  return join(root, "runs", "manual", sessionId, "biz-1");
}

/** 业务日志目录：{root}/logs/businesses/{source}/{session_id}/{business_id} */
function logsRootOf(root: string, sessionId = "sess-1"): string {
  return join(root, "logs", "businesses", "manual", sessionId, "biz-1");
}

describe("WorkflowRunner", () => {
  it("1. 成功：回显 input + cwd 是工作区，目录按三维路径创建", async () => {
    const { root, runner } = setup();
    const req = makeReq("success.js");
    const outcome = await runner.run(req);
    expect(outcome.status).toBe("success");
    const output = outcome.output as Record<string, any>;
    expect(output.event).toEqual(req.event);
    // cwd = 注入的 workspace = {root}/runs/manual/sess-1/biz-1/{run_id}
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
    const programs = { "jira-fetch": "/cache/assets/ast_x/programs/fetch.js" };
    const outcome = await runner.run(makeReq("echo-programs.js", { programs }));
    expect(outcome.status).toBe("success");
    expect((outcome.output as Record<string, any>).programs).toEqual(programs);
  });

  it("2c. 信封含 dataDir 且目录已建：{root}/data/{source}/{session_id}/{business_id}", async () => {
    const { root, runner } = setup();
    const outcome = await runner.run(makeReq("echo-datadir.js"));
    expect(outcome.status).toBe("success");
    const output = outcome.output as Record<string, any>;
    const expected = join(root, "data", "manual", "sess-1", "biz-1");
    expect(output.dataDir).toBe(expected);
    expect(output.exists).toBe(true);
    expect(existsSync(expected)).toBe(true);
  });

  it("3. 业务失败：sdk.fail → failed、reason 含原因", async () => {
    const { runner } = setup();
    const outcome = await runner.run(makeReq("biz-fail.js"));
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("门禁未通过");
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
    // 结构化行：level/message/fields
    const structured = lines.find(
      (l) => typeof l.message === "string" && l.message.includes(" masked "),
    );
    expect(structured).toBeDefined();
    expect(structured?.level).toBe("info");
    expect(structured?.message).toContain('{"k":1}');
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
