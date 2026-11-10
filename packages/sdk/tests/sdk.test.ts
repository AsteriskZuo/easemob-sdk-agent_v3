import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkFields, checkMetrics, loadContract } from "../src/contract.js";

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../tests/fixtures/${name}`, import.meta.url),
  );
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** spawn fixture 程序，可选管道喂 stdin JSON，收 stdout/stderr/exit code */
function runFixture(
  name: string,
  opts: { stdin?: string } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath(name)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/** 构造平台注入的 stdin 信封（workspace 用独立临时目录） */
function makeEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract_version: "v1",
    input: { hello: "world" },
    workspace: mkdtempSync(join(tmpdir(), "sdk-test-")),
    config: { region: "cn", flag: "on" },
    secrets: { api_key: "sk-test-abcdef123456" },
    ...over,
  });
}

/** 解析 fixture stdout 的唯一结果行 */
function parseResult(stdout: string): {
  contract_version: string;
  ok: boolean;
  output?: unknown;
  reason?: string;
} {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[0]);
}

interface FakeServer {
  socketPath: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}

/** 假 AgentService：unix socket，一行一请求，回完即关 */
function startFakeServer(
  respond: (req: Record<string, unknown>) => Record<string, unknown>,
): Promise<FakeServer> {
  const dir = mkdtempSync(join(tmpdir(), "sdk-sock-"));
  const socketPath = join(dir, "svc.sock");
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const req = JSON.parse(buf.slice(0, idx));
      requests.push(req);
      conn.end(JSON.stringify(respond(req)) + "\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        requests,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

describe("sdk 读口", () => {
  it("input/runInput/config/secret 各读口正确", async () => {
    const envelopeRaw = makeEnvelope();
    const envelope = JSON.parse(envelopeRaw);
    const r = await runFixture("probe-input.js", { stdin: envelopeRaw });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    const output = result.output as Record<string, any>;
    expect(output.input).toEqual({
      event: envelope.input,
      workspace: envelope.workspace,
    });
    expect(output.runInput).toEqual({
      input: envelope.input,
      config: envelope.config,
    });
    expect(output.config).toEqual(envelope.config);
    expect(output.secret).toBe("sk-test-abcdef123456");
  });

  it("input 透传信封 output（check-output 程序读主程序产出）；未注入时为 undefined", async () => {
    const withOutput = await runFixture("probe-input.js", {
      stdin: makeEnvelope({ output: { answer: "x" } }),
    });
    expect(withOutput.code).toBe(0);
    const outA = parseResult(withOutput.stdout).output as Record<string, any>;
    expect(outA.input.output).toEqual({ answer: "x" });

    const without = await runFixture("probe-input.js", {
      stdin: makeEnvelope(),
    });
    expect(without.code).toBe(0);
    const outB = parseResult(without.stdout).output as Record<string, any>;
    expect(outB.input.output).toBeUndefined();
  });

  it("secret 未注入名 → 抛错", async () => {
    const r = await runFixture("probe-secret-missing.js", {
      stdin: makeEnvelope(),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    const output = result.output as Record<string, any>;
    expect(output.threw).toBe(true);
    expect(output.message).toContain("nope");
  });

  it("无 stdin（空输入）→ input() 抛「无注入输入」", async () => {
    const r = await runFixture("probe-no-stdin.js");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("threw:");
    expect(r.stdout).toContain("无注入输入");
  });

  it("dataDir 注入 → 原样返回；未注入 → 抛错", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sdk-datadir-"));
    const ok = await runFixture("probe-datadir.js", {
      stdin: makeEnvelope({ dataDir }),
    });
    expect(ok.code).toBe(0);
    const okOut = parseResult(ok.stdout).output as Record<string, any>;
    expect(okOut.dataDir).toBe(dataDir);

    const missing = await runFixture("probe-datadir.js", {
      stdin: makeEnvelope(),
    });
    expect(missing.code).toBe(0);
    const missingOut = parseResult(missing.stdout).output as Record<
      string,
      any
    >;
    expect(missingOut.threw).toBe(true);
    expect(missingOut.message).toContain("dataDir");
  });
});

describe("sdk 出口", () => {
  it("return → stdout 合法 StdoutResult(ok:true) 且 exit 0", async () => {
    const r = await runFixture("probe-return.js", { stdin: makeEnvelope() });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result).toEqual({
      contract_version: "v1",
      ok: true,
      output: { answer: 42 },
    });
  });

  it("fail → ok:false + exit 1", async () => {
    const r = await runFixture("probe-fail.js", { stdin: makeEnvelope() });
    expect(r.code).toBe(1);
    const result = parseResult(r.stdout);
    expect(result).toEqual({
      contract_version: "v1",
      ok: false,
      reason: "业务处理失败",
    });
  });

  it("重复出口 → 第二次调用写错误日志行并 exit 1", async () => {
    const r = await runFixture("probe-double-exit.js", {
      stdin: makeEnvelope(),
    });
    expect(r.code).toBe(0); // fixture 汇报后自行 exit 0
    const lines = r.stdout.trim().split("\n");
    expect(JSON.parse(lines[0])).toEqual({
      contract_version: "v1",
      ok: true,
      output: { first: 1 },
    });
    // 两次出口各触发一次 exit：第一次 0，第二次（重复出口）1
    expect(JSON.parse(lines[1])).toEqual({ exits: [0, 1] });
    const errLine = r.stderr
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((l) => l.__biz_log === 1);
    expect(errLine).toBeDefined();
    expect(errLine?.level).toBe("error");
  });
});

describe("sdk.log", () => {
  it("stderr 单行 JSON 含 __biz_log，fields 合入；循环引用不崩", async () => {
    const r = await runFixture("probe-log.js", { stdin: makeEnvelope() });
    expect(r.code).toBe(0);
    const lines = r.stderr
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const infoLine = lines.find((l) => l.message === "hello world");
    expect(infoLine).toBeDefined();
    expect(infoLine?.__biz_log).toBe(1);
    expect(infoLine?.level).toBe("info");
    expect(infoLine?.fields).toEqual({ k: 1 });
    expect(typeof infoLine?.ts).toBe("string");
  });
});

describe("sdk.agent / session", () => {
  it("agent：请求行字段完整，ok:true → 返回 output", async () => {
    const server = await startFakeServer(() => ({
      contract_version: "v1",
      ok: true,
      output: "model-reply",
    }));
    try {
      const r = await runFixture("probe-agent.js", {
        stdin: makeEnvelope({
          endpoint: { socket_path: server.socketPath, token: "tok-123" },
        }),
      });
      expect(r.code).toBe(0);
      const result = parseResult(r.stdout);
      expect(result.ok).toBe(true);
      expect((result.output as any).agentOut).toBe("model-reply");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toEqual({
        contract_version: "v2",
        token: "tok-123",
        op: "agent",
        skills: ["summarize", "output-format"],
        input: { text: "hi" },
        mode: "fresh",
      });
    } finally {
      await server.close();
    }
  });

  it("agent：携带 model → 请求行透传 model 与 v2", async () => {
    const server = await startFakeServer(() => ({
      contract_version: "v1",
      ok: true,
      output: "local-model-reply",
    }));
    try {
      const r = await runFixture("probe-agent-model.js", {
        stdin: makeEnvelope({
          endpoint: { socket_path: server.socketPath, token: "tok-123" },
        }),
      });
      expect(r.code).toBe(0);
      const result = parseResult(r.stdout);
      expect(result.ok).toBe(true);
      expect((result.output as any).agentOut).toBe("local-model-reply");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toEqual({
        contract_version: "v2",
        token: "tok-123",
        op: "agent",
        skills: ["summarize"],
        input: { text: "hi" },
        mode: "fresh",
        model: "ollama/qwen3:8b",
      });
    } finally {
      await server.close();
    }
  });

  it("models：op 请求 v2，返回枚举原样透出", async () => {
    const info = {
      default: "qwen/qwen3-max",
      providers: [
        { name: "qwen", models: ["qwen3-max", "qwen-plus"] },
        { name: "ollama", models: ["qwen3:8b"] },
      ],
    };
    const server = await startFakeServer(() => ({
      contract_version: "v1",
      ok: true,
      output: info,
    }));
    try {
      const r = await runFixture("probe-models.js", {
        stdin: makeEnvelope({
          endpoint: { socket_path: server.socketPath, token: "tok-123" },
        }),
      });
      expect(r.code).toBe(0);
      const result = parseResult(r.stdout);
      expect(result.ok).toBe(true);
      expect(result.output).toEqual(info);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toEqual({
        contract_version: "v2",
        token: "tok-123",
        op: "models",
      });
    } finally {
      await server.close();
    }
  });

  it("models：无配置业务 → 空枚举原样透出", async () => {
    const server = await startFakeServer(() => ({
      contract_version: "v1",
      ok: true,
      output: { default: "", providers: [] },
    }));
    try {
      const r = await runFixture("probe-models.js", {
        stdin: makeEnvelope({
          endpoint: { socket_path: server.socketPath, token: "tok-123" },
        }),
      });
      expect(r.code).toBe(0);
      const result = parseResult(r.stdout);
      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ default: "", providers: [] });
    } finally {
      await server.close();
    }
  });

  it("model 空串 → 本地直接抛错（不发 socket 请求）", async () => {
    const r = await runFixture("probe-agent-empty-model.js", {
      stdin: makeEnvelope(),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    const output = result.output as Record<string, any>;
    expect(output.threw).toBe(true);
    expect(output.message).toContain("model");
  });

  it("agent：ok:false → 抛错（带 error）", async () => {
    const server = await startFakeServer(() => ({
      contract_version: "v1",
      ok: false,
      error: "quota exceeded",
    }));
    try {
      const r = await runFixture("probe-agent.js", {
        stdin: makeEnvelope({
          endpoint: { socket_path: server.socketPath, token: "tok-123" },
        }),
      });
      expect(r.code).toBe(1);
      const result = parseResult(r.stdout);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("quota exceeded");
    } finally {
      await server.close();
    }
  });

  it("session.compact/clear：op 正确，ok:true 正常返回", async () => {
    const server = await startFakeServer(() => ({
      contract_version: "v1",
      ok: true,
      output: null,
    }));
    try {
      const r = await runFixture("probe-session.js", {
        stdin: makeEnvelope({
          endpoint: { socket_path: server.socketPath, token: "tok-123" },
        }),
      });
      expect(r.code).toBe(0);
      expect(parseResult(r.stdout).output).toBe("done");
      expect(server.requests.map((q) => q.op)).toEqual(["compact", "clear"]);
      for (const q of server.requests) {
        expect(q.token).toBe("tok-123");
        expect(q.contract_version).toBe("v2");
      }
    } finally {
      await server.close();
    }
  });

  it("无 endpoint 调 agent → 抛错", async () => {
    const r = await runFixture("probe-agent-no-endpoint.js", {
      stdin: makeEnvelope(),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    const output = result.output as Record<string, any>;
    expect(output.threw).toBe(true);
    expect(output.message).toContain("endpoint");
  });

  it("skills 空数组 → 本地直接抛错（不发 socket 请求）", async () => {
    const r = await runFixture("probe-agent-empty-skills.js", {
      stdin: makeEnvelope(),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    const output = result.output as Record<string, any>;
    expect(output.threw).toBe(true);
    expect(output.message).toContain("skills");
  });
});

describe("sdk.run", () => {
  /** 平台注入的程序名→物化绝对路径映射（stdin 信封 programs 字段） */
  const PROGRAMS = {
    echo: fixturePath("run-child.js"),
    fail: fixturePath("run-child-fail.js"),
    slow: fixturePath("run-child-slow.js"),
    dump: fixturePath("run-child-dump-envelope.js"),
  };

  it("名命中 → 按名查表 spawn，子程序收 input/config、回 output → 返回 output", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: PROGRAMS,
        input: {
          child: "echo",
          args: { input: { n: 1 }, config: { a: "b" } },
        },
      }),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    expect((result.output as any).runOut).toEqual({
      echo: { n: 1 },
      config: { a: "b" },
    });
  });

  it("名不存在 → 抛错，消息列出全部可用程序名", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: PROGRAMS,
        input: { child: "nope", args: { input: null } },
      }),
    });
    expect(r.code).toBe(1);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("未知程序名：nope");
    expect(result.reason).toContain("echo");
    expect(result.reason).toContain("slow");
  });

  it("子程序信封不含 programs 与 dataDir（工具是叶子，不能再按名组合、无业务级持久语义）", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: PROGRAMS,
        dataDir: mkdtempSync(join(tmpdir(), "sdk-parent-datadir-")),
        input: { child: "dump", args: { input: null } },
      }),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    const runOut = (result.output as any).runOut;
    expect(runOut.has_programs).toBe(false);
    expect(runOut.keys).toEqual([
      "config",
      "contract_version",
      "input",
      "workspace",
    ]);
  });

  it("子程序 ok:false → 抛错含 reason", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: PROGRAMS,
        input: { child: "fail", args: { input: null } },
      }),
    });
    expect(r.code).toBe(1);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("子任务拒绝");
  });

  it("子程序无产出（无参 return，结果行缺 output 键）→ 归一为 null，不判 missing result", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: { ...PROGRAMS, empty: fixturePath("run-child-no-output.js") },
        input: { child: "empty", args: { input: null } },
      }),
    });
    expect(r.code).toBe(0);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(true);
    expect((result.output as any).runOut).toBeNull();
  });

  it("子程序超时（timeout_ms 小值）→ 抛错", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: PROGRAMS,
        input: {
          child: "slow",
          args: { input: null, timeout_ms: 200 },
        },
      }),
    });
    expect(r.code).toBe(1);
    const result = parseResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("超时");
  }, 15000);
});

describe("契约 API（loadContract / checkFields）", () => {
  /** 把契约内容落成临时文件，返回 file:// URL（loadContract 的入参形态） */
  function writeContract(content: unknown): URL {
    const dir = mkdtempSync(join(tmpdir(), "sdk-contract-"));
    const file = join(dir, "contract.json");
    writeFileSync(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return pathToFileURL(file);
  }

  const VALID = {
    version: 1,
    input: {
      fields: [
        { path: "payload.issue_key", type: "string", required: true },
        { path: "payload.labels", type: "string[]" },
      ],
    },
    output: null,
  };

  describe("loadContract", () => {
    it("合法契约（含显式 null 节）→ 原样返回", () => {
      expect(loadContract(writeContract(VALID))).toEqual(VALID);
    });

    it("version 缺失或非 1 / 缺 input 节 / 坏 JSON → 抛错", () => {
      expect(() =>
        loadContract(writeContract({ ...VALID, version: 2 })),
      ).toThrow(/version/);
      const noVersion: Record<string, unknown> = { ...VALID };
      delete noVersion.version;
      expect(() => loadContract(writeContract(noVersion))).toThrow(/version/);
      expect(() =>
        loadContract(writeContract({ version: 1, output: null })),
      ).toThrow(/缺少 input/);
      expect(() => loadContract(writeContract("{ not json"))).toThrow(
        /读取\/解析失败/,
      );
    });

    it("字段声明非法（type 词表外 / required 非布尔）→ 抛错列出问题", () => {
      expect(() =>
        loadContract(
          writeContract({
            version: 1,
            input: { fields: [{ path: "a", type: "int" }] },
            output: null,
          }),
        ),
      ).toThrow(/type 非法/);
      expect(() =>
        loadContract(
          writeContract({
            version: 1,
            input: null,
            output: {
              fields: [{ path: "a", type: "string", required: "yes" }],
            },
          }),
        ),
      ).toThrow(/required/);
    });
  });

  describe("checkFields", () => {
    const fields = [
      { path: "payload.issue_key", type: "string", required: true },
      { path: "payload.count", type: "number", required: true },
      { path: "payload.labels", type: "string[]" }, // 可选：不查
      { path: "payload.meta", type: "object", required: true },
    ];

    it("全部满足 → 空数组", () => {
      expect(
        checkFields(fields, {
          payload: { issue_key: "PRJ-1", count: 3, meta: {} },
        }),
      ).toEqual([]);
    });

    it("缺必填 → 报路径；类型不符 → 报期望与实际；数组不满足 object", () => {
      const problems = checkFields(fields, {
        payload: { count: "3", meta: [] },
      });
      expect(problems).toHaveLength(3);
      expect(problems[0]).toContain("缺少必填字段：payload.issue_key");
      expect(problems[1]).toContain("payload.count");
      expect(problems[1]).toContain("期望 number");
      expect(problems[1]).toContain("实际 string");
      expect(problems[2]).toContain("payload.meta");
    });

    it("可选项不查：缺失或类型错都通过", () => {
      expect(
        checkFields(fields, {
          payload: { issue_key: "PRJ-1", count: 1, meta: {}, labels: [1, 2] },
        }),
      ).toEqual([]);
    });

    it("T[] 递归校验元素；嵌套路径解析；整体缺失 → 缺必填", () => {
      const f2 = [{ path: "a.b", type: "string[]", required: true }];
      expect(checkFields(f2, { a: { b: ["x", "y"] } })).toEqual([]);
      expect(checkFields(f2, { a: { b: ["x", 1] } })).toHaveLength(1);
      expect(checkFields(f2, {})).toEqual(["缺少必填字段：a.b"]);
    });
  });

  describe("loadContract 的 metrics 节", () => {
    const WITH_METRICS = {
      ...VALID,
      metrics: {
        fields: [
          { key: "decision", type: "string", required: true },
          { key: "duration_ms", type: "number" },
        ],
      },
    };

    it("缺省 / null → 合法；合法节 → 原样返回", () => {
      expect(loadContract(writeContract(VALID))).toEqual(VALID);
      expect(loadContract(writeContract({ ...VALID, metrics: null }))).toEqual(
        { ...VALID, metrics: null },
      );
      expect(loadContract(writeContract(WITH_METRICS))).toEqual(WITH_METRICS);
    });

    it("metrics 非对象 / fields 非数组 → 抛错", () => {
      expect(() =>
        loadContract(writeContract({ ...VALID, metrics: "x" })),
      ).toThrow(/metrics 必须是 null 或 \{ fields/);
      expect(() =>
        loadContract(writeContract({ ...VALID, metrics: [] })),
      ).toThrow(/metrics 必须是 null 或 \{ fields/);
      expect(() =>
        loadContract(writeContract({ ...VALID, metrics: { fields: "x" } })),
      ).toThrow(/metrics 必须是 null 或 \{ fields/);
    });

    it("字段校验逐类：key 非法（大写开头/含连字符）、type 词表外、required 非布尔 → 抛错", () => {
      for (const key of ["Decision", "a-b", "1abc"]) {
        expect(() =>
          loadContract(
            writeContract({
              ...VALID,
              metrics: { fields: [{ key, type: "string" }] },
            }),
          ),
        ).toThrow(/key 非法/);
      }
      expect(() =>
        loadContract(
          writeContract({
            ...VALID,
            metrics: { fields: [{ key: "ok_key", type: "boolean" }] },
          }),
        ),
      ).toThrow(/type 非法/);
      expect(() =>
        loadContract(
          writeContract({
            ...VALID,
            metrics: {
              fields: [{ key: "ok_key", type: "string", required: "yes" }],
            },
          }),
        ),
      ).toThrow(/required/);
    });
  });

  describe("checkMetrics", () => {
    const fields = [
      { key: "decision", type: "string" as const, required: true },
      { key: "duration_ms", type: "number" as const, required: true },
      { key: "skill_version", type: "string" as const }, // 可选
    ];

    it("全部满足 → 空数组；可选键缺失不查", () => {
      expect(
        checkMetrics(fields, { decision: "approve", duration_ms: 12 }),
      ).toEqual([]);
      expect(
        checkMetrics(fields, {
          decision: "approve",
          duration_ms: 12,
          skill_version: "1.0.0",
        }),
      ).toEqual([]);
    });

    it("required 缺失 → 报缺少；类型不符 → 报期望与实际", () => {
      const problems = checkMetrics(fields, { duration_ms: "12" });
      expect(problems).toHaveLength(2);
      expect(problems[0]).toContain("缺少必填指标：decision");
      expect(problems[1]).toContain("duration_ms");
      expect(problems[1]).toContain("期望 number");
      expect(problems[1]).toContain("实际 string");
    });

    it("number 必须有限：NaN/Infinity 判类型不符", () => {
      expect(checkMetrics(fields, { decision: "x", duration_ms: NaN })).toHaveLength(1);
      expect(
        checkMetrics(fields, { decision: "x", duration_ms: Infinity }),
      ).toHaveLength(1);
    });

    it("可选键存在但类型错 → 报；未声明键放行", () => {
      const problems = checkMetrics(fields, {
        decision: "approve",
        duration_ms: 1,
        skill_version: 42,
        undeclared_key: { anything: true },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("skill_version");
    });

    it("metrics 为 null/undefined → 等价 {}，required 全报缺失", () => {
      expect(checkMetrics(fields, null)).toEqual([
        "缺少必填指标：decision",
        "缺少必填指标：duration_ms",
      ]);
      expect(checkMetrics(fields, undefined)).toEqual([
        "缺少必填指标：decision",
        "缺少必填指标：duration_ms",
      ]);
    });

    it("空 fields + 任意 metrics → 通过", () => {
      expect(checkMetrics([], { whatever: [1, 2] })).toEqual([]);
      expect(checkMetrics([], null)).toEqual([]);
    });
  });
});
