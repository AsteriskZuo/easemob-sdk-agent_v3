import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
      reason: "门禁未通过",
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
        contract_version: "v1",
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
        expect(q.contract_version).toBe("v1");
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

  it("子程序信封不含 programs（工具是叶子，不能再按名组合）", async () => {
    const r = await runFixture("run-parent.js", {
      stdin: makeEnvelope({
        programs: PROGRAMS,
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
