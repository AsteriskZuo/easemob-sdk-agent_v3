import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import type {
  ExecuteRunHooks,
  ExecuteRunRequest,
} from "@asteriskzuo/agent-run-core";
import type { RunContext } from "@asteriskzuo/agent-run-core";
import type { RunOutcome } from "@asteriskzuo/agent-workflow-runner";
import { runLocal } from "../src/cli.js";

/**
 * CLI 测试（spec §10.4 的子命令层）：
 * argv 解析错误、export-event 错误路径、diff 的 0/1/2 退出码（临时目录造两侧资产）、
 * run 的退出码映射（注入假 executeRun 覆盖 success/failed/timeout/抛错四态）与目录派生断言。
 *
 * 夹具：临时目录下
 *   pkg/                  # package 资产（agent-package.json + dist/main.js）
 *   platform/main.js      # diff 用的「平台侧」程序产物（与 pkg 侧同内容、不同路径）
 *   config.json           # 本地配置文件（pi_cli_path 指 /bin/true，避开 node_modules 缺省解析）
 *   event.json            # 合法回放事件
 */

let dir: string;

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** 捕获终端输出的注入 deps。 */
function makeIo(): {
  out: string[];
  err: string[];
  stdout: (text: string) => void;
  stderr: (text: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
}

/** 写本地配置文件（默认值可被 overrides 覆盖），返回路径。 */
function writeConfig(overrides: Record<string, unknown> = {}): string {
  const config = {
    business_id: "jira-ticket-review",
    channel_id: "jira:HIM-12345",
    prompt: "审查工单",
    entry_program: "main",
    model: "qwen/qwen3.8-max",
    assets: { package: { path: "./pkg" } },
    vars: { JIRA_PROJECT: "HIM" },
    secrets: { JIRA_PASSWORD: "s3cret" },
    quota: { timeout_minutes: 30, max_agent_calls: 50 },
    workspace_root: "./ws",
    // 显式指定，避免走 node_modules 缺省解析（测试环境无需真实 pi）
    pi_cli_path: "/bin/true",
    ...overrides,
  };
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function validEnvelope(): EventEnvelope {
  return {
    contract_version: "v1",
    source: "jira",
    event_id: "jira:HIM-12345:2026-11-08T10:00:00.000Z",
    event_type: "jira:issue_updated",
    timestamp: "2026-11-08T10:00:00.000+08:00",
    session_id: "HIM-12345",
    correlation_id: "jira:HIM-12345:2026-11-08T10:00:00.000Z",
    hop_count: 0,
    payload: { issue_key: "HIM-12345" },
  };
}

function writeEventFile(): string {
  const eventPath = path.join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(validEnvelope()));
  return eventPath;
}

/** 平台侧快照（RunContext JSON）：路径指向 platform/ 根，内容与本地侧一致。 */
function makeSnapshot(overrides: Partial<RunContext> = {}): RunContext {
  return {
    business_id: "jira-ticket-review",
    channel_id: "jira:HIM-12345",
    program: path.join(dir, "platform", "main.js"),
    programs: { main: path.join(dir, "platform", "main.js") },
    prompt: "审查工单",
    skills: [],
    model: "qwen/qwen3.8-max",
    vars: { JIRA_PROJECT: "HIM" },
    secrets: { JIRA_PASSWORD: "s3cret" },
    quota: { timeout_minutes: 30, max_agent_calls: 50 },
    ...overrides,
  };
}

function writeSnapshot(snapshot: unknown): string {
  const snapshotPath = path.join(dir, "snapshot.json");
  writeFileSync(
    snapshotPath,
    typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
  );
  return snapshotPath;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "local-runner-cli-"));
  write(
    "pkg/agent-package.json",
    JSON.stringify({
      name: "jira-ticket-review",
      programs: { main: "dist/main.js" },
    }),
  );
  write("pkg/dist/main.js", "console.log('main');\n");
  // 平台侧程序产物：内容相同、路径不同（验证 digest 比较与路径无关）
  write("platform/main.js", "console.log('main');\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("argv 解析", () => {
  it("无子命令：exit 2 且 stderr 含用法", async () => {
    const io = makeIo();
    const code = await runLocal([], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("缺少子命令");
    expect(io.err.join("")).toContain("agent-local run");
  });

  it("未知子命令：exit 2 且 stderr 含用法", async () => {
    const io = makeIo();
    const code = await runLocal(["nope"], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("未知子命令：nope");
  });

  it("run 缺 --event：exit 2", async () => {
    const io = makeIo();
    const code = await runLocal(["run", "--config", "x.json"], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("缺少必填参数 --event");
  });

  it("diff 缺 --snapshot：exit 2", async () => {
    const io = makeIo();
    const code = await runLocal(["diff", "--config", "x.json"], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("缺少必填参数 --snapshot");
  });

  it("export-event 缺 --out：exit 2", async () => {
    const io = makeIo();
    const code = await runLocal(
      ["export-event", "--db", "a.db", "--event-id", "e1"],
      io,
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("缺少必填参数 --out");
  });

  it("未知选项：exit 2 且报参数非法", async () => {
    const io = makeIo();
    const code = await runLocal(["diff", "--bogus", "1"], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("参数非法");
  });
});

describe("export-event", () => {
  it("db 不存在：exit 2，stderr 含错误消息", async () => {
    const io = makeIo();
    const code = await runLocal(
      [
        "export-event",
        "--db",
        path.join(dir, "no-such.db"),
        "--event-id",
        "e1",
        "--out",
        path.join(dir, "out.json"),
      ],
      io,
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("平台数据库不存在");
  });

  it("正常导出：exit 0 且目标文件为合法信封", async () => {
    const envelope = validEnvelope();
    const dbPath = path.join(dir, "platform.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TABLE entry_tasks (task_id TEXT PRIMARY KEY, event_id TEXT, event TEXT)",
      );
      db.prepare(
        "INSERT INTO entry_tasks (task_id, event_id, event) VALUES (?, ?, ?)",
      ).run("task_0", envelope.event_id, JSON.stringify(envelope));
    } finally {
      db.close();
    }
    const outPath = path.join(dir, "events", "out.json");
    const io = makeIo();

    const code = await runLocal(
      ["export-event", "--db", dbPath, "--event-id", envelope.event_id, "--out", outPath],
      io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(envelope);
    expect(io.out.join("")).toContain(envelope.event_id);
  });
});

describe("diff", () => {
  it("全等（两侧路径不同内容一致）：exit 0，输出「全部字段相等」", async () => {
    const configPath = writeConfig();
    const snapshotPath = writeSnapshot(makeSnapshot());
    const io = makeIo();

    const code = await runLocal(
      ["diff", "--config", configPath, "--snapshot", snapshotPath],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("全部字段相等");
    // 默认只打非 equal 字段：全等时不应出现字段行
    expect(io.out.join("")).not.toContain("different");
  });

  it("有差异：exit 1，按格式打印非 equal 字段行", async () => {
    const configPath = writeConfig();
    const snapshotPath = writeSnapshot(
      makeSnapshot({ model: "qwen/other-model" }),
    );
    const io = makeIo();

    const code = await runLocal(
      ["diff", "--config", configPath, "--snapshot", snapshotPath],
      io,
    );

    expect(code).toBe(1);
    const out = io.out.join("");
    expect(out).toContain(
      "different  model  platform=qwen/other-model  local=qwen/qwen3.8-max",
    );
    expect(out).toContain("1 个字段有差异");
    // 默认不打相等字段
    expect(out).not.toContain("equal  business_id");
  });

  it("--all：全等时也打印全部字段（含 equal 行）", async () => {
    const configPath = writeConfig();
    const snapshotPath = writeSnapshot(makeSnapshot());
    const io = makeIo();

    const code = await runLocal(
      ["diff", "--config", configPath, "--snapshot", snapshotPath, "--all"],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain(
      "equal  business_id  platform=jira-ticket-review  local=jira-ticket-review",
    );
    // secrets 展示值恒脱敏
    expect(io.out.join("")).toContain("secrets.JIRA_PASSWORD  platform=***  local=***");
    expect(io.out.join("")).not.toContain("s3cret");
  });

  it("快照不是合法 JSON：exit 2", async () => {
    const configPath = writeConfig();
    const snapshotPath = writeSnapshot("{ broken");
    const io = makeIo();

    const code = await runLocal(
      ["diff", "--config", configPath, "--snapshot", snapshotPath],
      io,
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("快照文件不是合法 JSON");
  });

  it("快照形状非法（缺 RunContext 必填字段）：exit 2", async () => {
    const configPath = writeConfig();
    const snapshotPath = writeSnapshot({ business_id: "jira-ticket-review" });
    const io = makeIo();

    const code = await runLocal(
      ["diff", "--config", configPath, "--snapshot", snapshotPath],
      io,
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("不是合法 RunContext");
  });

  it("配置文件非法：exit 2", async () => {
    const snapshotPath = writeSnapshot(makeSnapshot());
    const io = makeIo();

    const code = await runLocal(
      ["diff", "--config", path.join(dir, "missing.json"), "--snapshot", snapshotPath],
      io,
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("配置文件不存在");
  });
});

describe("run", () => {
  /** 构造捕获请求的假 executeRun。 */
  function fakeExecuteRun(result: RunOutcome): {
    fn: (request: ExecuteRunRequest) => Promise<RunOutcome>;
    requests: ExecuteRunRequest[];
  } {
    const requests: ExecuteRunRequest[] = [];
    return {
      requests,
      fn: async (request) => {
        requests.push(request);
        return result;
      },
    };
  }

  it("success：exit 0，目录按 §6.3 派生并已创建，输出 RunOutcome 与日志路径", async () => {
    const configPath = writeConfig();
    const eventPath = writeEventFile();
    const fake = fakeExecuteRun({ status: "success", output: { reviewed: true } });
    const io = makeIo();

    const code = await runLocal(
      ["run", "--config", configPath, "--event", eventPath],
      { ...io, executeRun: fake.fn },
    );

    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    // run_id 形：run_ + 26 位 Crockford base32 ULID（与平台同规则）
    expect(request.run_id).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);

    const businessRoot = path.join(dir, "ws", "businesses", "jira-ticket-review");
    const workspace = path.join(
      businessRoot,
      "runs",
      "jira",
      "HIM-12345",
      request.run_id,
    );
    const sessionDir = path.join(
      businessRoot,
      "cache",
      "agent-sessions",
      "jira",
      "HIM-12345",
    );
    expect(request.workspace).toBe(workspace);
    expect(request.session_dir).toBe(sessionDir);
    expect(request.audit_log_path).toBe(
      path.join(workspace, "audit", "llm-requests.jsonl"),
    );
    // 执行核契约要求调用方创建的三处目录
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(sessionDir)).toBe(true);
    expect(existsSync(path.dirname(request.audit_log_path))).toBe(true);
    // 日志全局外观已初始化（initLogger 的 fail-fast 会建 logsDir）
    expect(
      existsSync(path.join(dir, "ws", "logs", "local-runner")),
    ).toBe(true);

    // 装配产物进请求（stub_tools 为空 = 等值上下文原样）
    expect(request.context.business_id).toBe("jira-ticket-review");
    expect(request.context.program).toBe(
      path.join(dir, "pkg", "dist", "main.js"),
    );

    const out = io.out.join("");
    expect(out).toContain(`run_id: ${request.run_id}`);
    expect(out).toContain('"status": "success"');
    expect(out).toContain('"reviewed": true');
    expect(out).toContain(
      `业务日志: ${path.join(businessRoot, "logs", "jira", "HIM-12345", `${request.run_id}.log`)}`,
    );
    expect(out).toContain(`审计日志: ${request.audit_log_path}`);
  });

  it("failed：exit 1，输出 reason 与 failed_at", async () => {
    const configPath = writeConfig();
    const eventPath = writeEventFile();
    const fake = fakeExecuteRun({
      status: "failed",
      output: undefined,
      reason: "exit code 1 (duration_ms=12)",
      failed_at: "main",
    });
    const io = makeIo();

    const code = await runLocal(
      ["run", "--config", configPath, "--event", eventPath],
      { ...io, executeRun: fake.fn },
    );

    expect(code).toBe(1);
    const out = io.out.join("");
    expect(out).toContain('"status": "failed"');
    expect(out).toContain('"failed_at": "main"');
    expect(out).toContain("exit code 1");
  });

  it("timeout：exit 1", async () => {
    const configPath = writeConfig();
    const eventPath = writeEventFile();
    const fake = fakeExecuteRun({
      status: "timeout",
      output: undefined,
      reason: "timeout after 30 minutes (duration_ms=1800000)",
      failed_at: "main",
    });
    const io = makeIo();

    const code = await runLocal(
      ["run", "--config", configPath, "--event", eventPath],
      { ...io, executeRun: fake.fn },
    );

    expect(code).toBe(1);
    expect(io.out.join("")).toContain('"status": "timeout"');
  });

  it("executeRun 抛错：exit 2，stderr 含错误；hooks 错误先打 stderr", async () => {
    const configPath = writeConfig();
    const eventPath = writeEventFile();
    const io = makeIo();
    const throwing = async (
      _request: ExecuteRunRequest,
      _deps: unknown,
      hooks?: ExecuteRunHooks,
    ): Promise<RunOutcome> => {
      hooks?.onRunnerError?.(new Error("runner boom"));
      throw new Error("execute boom");
    };

    const code = await runLocal(
      ["run", "--config", configPath, "--event", eventPath],
      { ...io, executeRun: throwing },
    );

    expect(code).toBe(2);
    const err = io.err.join("");
    expect(err).toContain("runner 平台错误");
    expect(err).toContain("runner boom");
    expect(err).toContain("execute boom");
  });

  it("回放事件文件非法：exit 2", async () => {
    const configPath = writeConfig();
    const io = makeIo();
    const code = await runLocal(
      ["run", "--config", configPath, "--event", path.join(dir, "missing.json")],
      io,
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("回放事件文件不存在");
  });

  it("stub_tools 拼写错误：exit 2（装配期 fail-fast，护栏不静默失效）", async () => {
    const configPath = writeConfig({ stub_tools: ["wecom-notfi"] });
    const eventPath = writeEventFile();
    const fake = fakeExecuteRun({ status: "success", output: null });
    const io = makeIo();

    const code = await runLocal(
      ["run", "--config", configPath, "--event", eventPath],
      { ...io, executeRun: fake.fn },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("stub_tools 中的工具名不在解析后的 programs 中");
    expect(fake.requests).toHaveLength(0);
  });
});
