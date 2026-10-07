import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";
import { initLogger, resetForTests } from "@easemob/agent-logger";
import type { EventEnvelope } from "@easemob/agent-contracts";
import type { EntryDriver } from "@easemob/agent-scheduler";
import type { BusinessMatch } from "@easemob/agent-registry";
import type {
  AgentServeContext,
  AgentService,
  RunningAgentService,
} from "@easemob/agent-service";
import type {
  RunOutcome,
  RunRequest,
  WorkflowRunner,
} from "@easemob/agent-workflow-runner";
import { createWorkflowRunner } from "@easemob/agent-workflow-runner";
import { createLifecycle, createLifecycleStore } from "../src/index.js";
import type { ContextLoader, RunContext } from "../src/index.js";

// EntryDriver.execute 的第一参类型（Task 归 @easemob/agent-queue，本包不直接依赖，结构取自契约）
type Task = Parameters<EntryDriver["execute"]>[0];

let tmpDir: string;
let workspaceRoot: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runtime-lifecycle-test-"));
  workspaceRoot = join(tmpDir, "workspace");
  db = openDatabase(":memory:");
  initLogger({ logsDir: join(tmpDir, "logs"), enabled: false });
});

afterEach(() => {
  resetForTests();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const BUSINESS_ID = "b_test1";

function makeEvent(): EventEnvelope {
  return {
    contract_version: "v1",
    source: "manual",
    event_id: "evt_test_1",
    event_type: "test.run",
    timestamp: new Date().toISOString(),
    session_id: "sess-1",
    correlation_id: "evt_test_1",
    hop_count: 0,
    payload: { hello: "world" },
  };
}

function makeTask(): Task {
  return {
    task_id: "task_test_1",
    event: makeEvent(),
    status: "processing",
    enqueued_at: new Date().toISOString(),
  };
}

function makeWatcher(): BusinessMatch {
  return {
    business_id: BUSINESS_ID,
    business_name: "测试业务",
    creator_id: "user-1",
    source: "manual",
    event_type: "test.run",
  };
}

function makeRunContext(over: Partial<RunContext> = {}): RunContext {
  return {
    business_id: BUSINESS_ID,
    channel_id: `manual__sess-1__${BUSINESS_ID}`,
    program: "/assets/pkg/src/main.js",
    programs: { main: "/assets/pkg/src/main.js" },
    prompt: "你是审查助手",
    skills: [{ name: "review", path: "/assets/skill/review" }],
    model: "qwen/qwen3.8-max",
    vars: { region: "cn" },
    secrets: { api_key: "sk-1" },
    quota: { timeout_minutes: 12, max_agent_calls: 3 },
    ...over,
  };
}

/** 结构 stub 三件套 + 调用记录仪（over.runner 可注入真件做集成） */
function makeStubs(
  over: {
    ctx?: RunContext;
    outcome?: RunOutcome;
    runImpl?: (req: RunRequest) => Promise<RunOutcome>;
    loadImpl?: (business_id: string, channel_id: string) => RunContext;
    runner?: WorkflowRunner;
  } = {},
) {
  const calls: string[] = [];
  const ctx = over.ctx ?? makeRunContext();
  const outcome: RunOutcome = over.outcome ?? {
    status: "success",
    output: { ok: 1 },
  };
  const recorder: { serveArg?: AgentServeContext; runArg?: RunRequest } = {};
  const loader: ContextLoader = {
    load: (business_id, channel_id) => {
      calls.push("load");
      if (over.loadImpl) return over.loadImpl(business_id, channel_id);
      return ctx;
    },
  };
  const agentService: AgentService = {
    serve: async (serveCtx) => {
      calls.push("serve");
      recorder.serveArg = serveCtx;
      const handle: RunningAgentService = {
        endpoint: { socket_path: "/tmp/fake-agent.sock", token: "tok-1" },
        close: async () => {
          calls.push("close");
        },
      };
      return handle;
    },
  };
  const runner: WorkflowRunner = over.runner ?? {
    run: async (req) => {
      calls.push("run");
      recorder.runArg = req;
      if (over.runImpl) return over.runImpl(req);
      return outcome;
    },
  };
  const lifecycle = createLifecycle({
    loader,
    runner,
    agentService,
    workspaceRoot,
    db,
  });
  return { calls, ctx, recorder, lifecycle };
}

describe("四步时序", () => {
  it("load → serve → runner.run → close 顺序与入参映射正确，run_id 全链一致", async () => {
    const { calls, ctx, recorder, lifecycle } = makeStubs();
    const task = makeTask();
    const result = await lifecycle.execute(task, makeWatcher());

    expect(calls).toEqual(["load", "serve", "run", "close"]);
    expect(result).toEqual({ status: "success", output: { ok: 1 } });

    const serveArg = recorder.serveArg!;
    expect(serveArg.run_id).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(serveArg.channel_id).toBe(`manual__sess-1__${BUSINESS_ID}`);
    expect(serveArg.workspace).toBe(
      join(
        workspaceRoot,
        "runs",
        "manual",
        "sess-1",
        BUSINESS_ID,
        serveArg.run_id,
      ),
    );
    expect(existsSync(serveArg.workspace)).toBe(true);
    expect(serveArg.prompt).toBe(ctx.prompt);
    expect(serveArg.skills).toBe(ctx.skills);
    expect(serveArg.model).toBe(ctx.model);
    expect(serveArg.session_dir).toBe(
      join(
        workspaceRoot,
        "cache",
        "agent-sessions",
        "manual",
        "sess-1",
        BUSINESS_ID,
      ),
    );
    expect(serveArg.audit_log_path).toBe(
      join(serveArg.workspace, "audit", "llm-requests.jsonl"),
    );
    expect(serveArg.quota).toEqual({ max_agent_calls: 3 });

    const runArg = recorder.runArg!;
    expect(runArg.program).toBe(ctx.program);
    expect(runArg.programs).toEqual(ctx.programs);
    expect(runArg.event).toBe(task.event);
    expect(runArg.business_id).toBe(BUSINESS_ID);
    expect(runArg.config).toBe(ctx.vars);
    expect(runArg.secrets).toBe(ctx.secrets);
    expect(runArg.endpoint).toEqual({
      socket_path: "/tmp/fake-agent.sock",
      token: "tok-1",
    });
    expect(runArg.quota).toEqual({ timeout_minutes: 12 });
    expect(runArg.run_id).toBe(serveArg.run_id);
  });
});

describe("close 无条件", () => {
  it("runner 返回 failed → close 被调且仅一次", async () => {
    const { calls, lifecycle } = makeStubs({
      outcome: { status: "failed", output: undefined, reason: "业务失败" },
    });
    const result = await lifecycle.execute(makeTask(), makeWatcher());
    expect(result.status).toBe("failed");
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });

  it("runner 抛错 → close 被调且仅一次，错误原样上抛", async () => {
    const { calls, lifecycle } = makeStubs({
      runImpl: async () => {
        throw new Error("program 不存在或不可读: /x");
      },
    });
    await expect(lifecycle.execute(makeTask(), makeWatcher())).rejects.toThrow(
      /^program 不存在或不可读/,
    );
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });

  it("runner 返回 timeout → close 被调且仅一次", async () => {
    const { calls, lifecycle } = makeStubs({
      outcome: { status: "timeout", output: undefined, reason: "timeout" },
    });
    const result = await lifecycle.execute(makeTask(), makeWatcher());
    expect(result.status).toBe("timeout");
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });
});

describe("打标", () => {
  it("成功路径：lifecycles 行 status=success 且 finished_at 有值", async () => {
    const { recorder, lifecycle } = makeStubs();
    await lifecycle.execute(makeTask(), makeWatcher());
    const store = createLifecycleStore(db);
    const record = store.get(recorder.runArg!.run_id!);
    expect(record).toBeDefined();
    expect(record?.status).toBe("success");
    expect(record?.finished_at).toBeDefined();
    expect(record?.business_id).toBe(BUSINESS_ID);
    expect(record?.event_id).toBe("evt_test_1");
    expect(record?.channel_id).toBe(`manual__sess-1__${BUSINESS_ID}`);
    expect(store.listByBusiness(BUSINESS_ID)).toHaveLength(1);
  });

  it("runner 返回 failed → 打标 failed", async () => {
    const { recorder, lifecycle } = makeStubs({
      outcome: { status: "failed", output: undefined, reason: "业务失败" },
    });
    await lifecycle.execute(makeTask(), makeWatcher());
    const record = createLifecycleStore(db).get(recorder.runArg!.run_id!);
    expect(record?.status).toBe("failed");
    expect(record?.finished_at).toBeDefined();
  });

  it("loader 抛错 → 打标 failed 且错误原样上抛", async () => {
    const { lifecycle } = makeStubs({
      loadImpl: (business_id) => {
        throw new Error(`business_not_found: ${business_id}`);
      },
    });
    await expect(lifecycle.execute(makeTask(), makeWatcher())).rejects.toThrow(
      /^business_not_found: b_test1$/,
    );
    const rows = createLifecycleStore(db).listByBusiness(BUSINESS_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].finished_at).toBeDefined();
  });
});

describe("真实 runner 集成", () => {
  it("stub agentService + 真 WorkflowRunner（fixture 程序 echo input）→ success、output 正确、workspace 按三维 + run_id 创建", async () => {
    const program = fileURLToPath(
      new URL("../../tests/fixtures/echo-input.js", import.meta.url),
    );
    const { recorder, lifecycle } = makeStubs({
      ctx: makeRunContext({ program, vars: { region: "cn" }, secrets: {} }),
      runner: createWorkflowRunner({ workspaceRoot }), // 真件 runner；agentService 仍为 stub
    });
    const task = makeTask();
    const result = await lifecycle.execute(task, makeWatcher());

    expect(result.status).toBe("success");
    const output = result.output as Record<string, any>;
    expect(output.input).toEqual(task.event);
    expect(output.config).toEqual({ region: "cn" });
    // workspace = {workspaceRoot}/runs/{source}/{session_id}/{business_id}/{run_id}（run_id 由 Lifecycle 生成并传入）
    const runId = recorder.serveArg!.run_id;
    const expectedWorkspace = join(
      workspaceRoot,
      "runs",
      "manual",
      "sess-1",
      BUSINESS_ID,
      runId,
    );
    expect(output.workspace).toBe(expectedWorkspace);
    expect(existsSync(expectedWorkspace)).toBe(true);
    // 打标终态
    const record = createLifecycleStore(db).get(runId);
    expect(record?.status).toBe("success");
  }, 15000);
});
