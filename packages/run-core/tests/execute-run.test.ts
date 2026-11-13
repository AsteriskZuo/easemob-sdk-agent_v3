import { describe, expect, it, jest } from "@jest/globals";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import type {
  AgentServeContext,
  AgentService,
  RunningAgentService,
} from "@asteriskzuo/agent-service";
import type {
  RunOutcome,
  RunRequest,
  WorkflowRunner,
} from "@asteriskzuo/agent-workflow-runner";
import { executeRun } from "../src/index.js";
import type { ExecuteRunRequest } from "../src/index.js";

const SECRET = "sk-test-secret";

function makeRequest(
  overrides: Partial<ExecuteRunRequest> = {},
): ExecuteRunRequest {
  const event: EventEnvelope = {
    contract_version: "v1",
    source: "manual",
    event_id: "evt_run_core",
    event_type: "test.run",
    timestamp: "2026-11-06T00:00:00.000Z",
    session_id: "session-1",
    correlation_id: "evt_run_core",
    hop_count: 0,
    payload: { issue_key: "HIM-1" },
  };
  return {
    context: {
      business_id: "b_review",
      channel_id: "manual__session-1__b_review",
      program: "/assets/package/dist/apps/main/index.js",
      programs: {
        main: "/assets/package/dist/apps/main/index.js",
        "jira-fetch": "/assets/tools/dist/apps/jira-fetch/index.js",
      },
      prompt: "审查工单",
      skills: [{ name: "review", path: "/assets/skills/review" }],
      model: "qwen/qwen3.8-max",
      pi_agent_dir: "/assets/business/cache/pi/agent",
      vars: { region: "cn" },
      secrets: { api_key: SECRET },
      quota: { timeout_minutes: 12, max_agent_calls: 3 },
    },
    event,
    run_id: "run_01KDF8W0W4F7D6E8W0W4F7D6E8",
    workspace: "/workspace/businesses/b_review/runs/manual/session-1/run",
    session_dir:
      "/workspace/businesses/b_review/cache/agent-sessions/manual/session-1",
    audit_log_path: "/workspace/audit/llm-requests.jsonl",
    ...overrides,
  };
}

function makeOutcome(status: RunOutcome["status"] = "success"): RunOutcome {
  if (status === "success") {
    return { status, output: { review: "passed" } };
  }
  return {
    status,
    output: undefined,
    reason: status === "timeout" ? "main timeout" : "business failed",
    ...(status === "timeout" ? { failed_at: "main" as const } : {}),
  };
}

function makeFixture(
  overrides: {
    request?: ExecuteRunRequest;
    serveImpl?: AgentService["serve"];
    runImpl?: WorkflowRunner["run"];
    closeImpl?: RunningAgentService["close"];
  } = {},
) {
  const calls: string[] = [];
  const request = overrides.request ?? makeRequest();
  const recorder: { serveArg?: AgentServeContext; runArg?: RunRequest } = {};
  const handle: RunningAgentService = {
    endpoint: { socket_path: "/tmp/run-core.sock", token: "token-1" },
    close: async () => {
      calls.push("close");
      await overrides.closeImpl?.();
    },
  };
  const agentService: AgentService = {
    serve: async (context) => {
      calls.push("serve");
      recorder.serveArg = context;
      return overrides.serveImpl ? overrides.serveImpl(context) : handle;
    },
  };
  const runner: WorkflowRunner = {
    run: async (runRequest) => {
      calls.push("runner");
      recorder.runArg = runRequest;
      return overrides.runImpl
        ? overrides.runImpl(runRequest)
        : makeOutcome("success");
    },
  };
  const onServeError = jest.fn<(error: unknown) => void>();
  const onRunnerError = jest.fn<(error: unknown) => void>(() => {
    calls.push("runner-hook");
  });
  return {
    request,
    recorder,
    calls,
    deps: { agentService, runner },
    hooks: { onServeError, onRunnerError },
  };
}

describe("executeRun 参数与正常时序", () => {
  it("按 serve → runner → close 执行，完整映射参数并返回原 outcome", async () => {
    const fixture = makeFixture();
    const outcome = await executeRun(
      fixture.request,
      fixture.deps,
      fixture.hooks,
    );

    expect(fixture.calls).toEqual(["serve", "runner", "close"]);
    expect(outcome).toEqual(makeOutcome("success"));
    expect(fixture.hooks.onServeError).not.toHaveBeenCalled();
    expect(fixture.hooks.onRunnerError).not.toHaveBeenCalled();

    const { context } = fixture.request;
    expect(fixture.recorder.serveArg).toEqual({
      run_id: fixture.request.run_id,
      channel_id: context.channel_id,
      workspace: fixture.request.workspace,
      prompt: context.prompt,
      skills: context.skills,
      model: context.model,
      session_dir: fixture.request.session_dir,
      audit_log_path: fixture.request.audit_log_path,
      quota: { max_agent_calls: 3 },
      pi_agent_dir: context.pi_agent_dir,
    });

    const runArg = fixture.recorder.runArg!;
    expect(runArg).toEqual({
      program: context.program,
      programs: context.programs,
      event: fixture.request.event,
      business_id: context.business_id,
      config: context.vars,
      secrets: context.secrets,
      endpoint: { socket_path: "/tmp/run-core.sock", token: "token-1" },
      quota: { timeout_minutes: 12 },
      run_id: fixture.request.run_id,
    });
    expect(runArg.event).toBe(fixture.request.event);
  });

  it("pi_agent_dir 为 undefined 时不向 serve 添加该字段", async () => {
    const request = makeRequest();
    delete request.context.pi_agent_dir;
    const fixture = makeFixture({ request });

    await executeRun(fixture.request, fixture.deps);

    expect(fixture.recorder.serveArg).toBeDefined();
    expect("pi_agent_dir" in fixture.recorder.serveArg!).toBe(false);
  });

  it("pi_tools 声明时向 serve 透传；未声明时不添加该字段", async () => {
    const withTools = makeRequest();
    withTools.context.pi_tools = ["read", "grep", "glob"];
    const declared = makeFixture({ request: withTools });
    await executeRun(declared.request, declared.deps);
    expect(declared.recorder.serveArg?.pi_tools).toEqual([
      "read",
      "grep",
      "glob",
    ]);

    const undeclared = makeFixture();
    await executeRun(undeclared.request, undeclared.deps);
    expect(undeclared.recorder.serveArg).toBeDefined();
    expect("pi_tools" in undeclared.recorder.serveArg!).toBe(false);
  });

  it.each(["success", "failed", "timeout"] as const)(
    "runner 返回 %s 时 close 恰好一次且不触发错误 hook",
    async (status) => {
      const outcome = makeOutcome(status);
      const fixture = makeFixture({ runImpl: async () => outcome });

      const result = await executeRun(
        fixture.request,
        fixture.deps,
        fixture.hooks,
      );

      expect(result).toBe(outcome);
      expect(fixture.calls).toEqual(["serve", "runner", "close"]);
      expect(fixture.hooks.onServeError).not.toHaveBeenCalled();
      expect(fixture.hooks.onRunnerError).not.toHaveBeenCalled();
    },
  );
});

describe("executeRun 失败与清理特征", () => {
  it("serve 失败触发 onServeError，原错误上抛且不执行 runner/close", async () => {
    const serveError = new Error("serve unavailable");
    const fixture = makeFixture({
      serveImpl: async () => {
        throw serveError;
      },
    });

    await expect(
      executeRun(fixture.request, fixture.deps, fixture.hooks),
    ).rejects.toBe(serveError);
    expect(fixture.calls).toEqual(["serve"]);
    expect(fixture.hooks.onServeError).toHaveBeenCalledWith(serveError);
    expect(fixture.hooks.onRunnerError).not.toHaveBeenCalled();
  });

  it("runner 抛错时按 onRunnerError → close 执行，close 成功则原错误上抛", async () => {
    const runnerError = new Error("runner platform error");
    const fixture = makeFixture({
      runImpl: async () => {
        throw runnerError;
      },
    });

    await expect(
      executeRun(fixture.request, fixture.deps, fixture.hooks),
    ).rejects.toBe(runnerError);
    expect(fixture.calls).toEqual(["serve", "runner", "runner-hook", "close"]);
    expect(fixture.hooks.onRunnerError).toHaveBeenCalledWith(runnerError);
    expect(fixture.hooks.onServeError).not.toHaveBeenCalled();
  });

  it("runner 已返回后 close 失败时上抛 close 错误，不触发错误 hook", async () => {
    const closeError = new Error("close failed");
    const fixture = makeFixture({
      closeImpl: async () => {
        throw closeError;
      },
    });

    await expect(
      executeRun(fixture.request, fixture.deps, fixture.hooks),
    ).rejects.toBe(closeError);
    expect(fixture.calls).toEqual(["serve", "runner", "close"]);
    expect(fixture.hooks.onServeError).not.toHaveBeenCalled();
    expect(fixture.hooks.onRunnerError).not.toHaveBeenCalled();
  });

  it("runner 与 close 均失败时保持现状：close 错误覆盖 runner 原错", async () => {
    const runnerError = new Error("runner failed first");
    const closeError = new Error("close failed second");
    const fixture = makeFixture({
      runImpl: async () => {
        throw runnerError;
      },
      closeImpl: async () => {
        throw closeError;
      },
    });

    await expect(
      executeRun(fixture.request, fixture.deps, fixture.hooks),
    ).rejects.toBe(closeError);
    expect(fixture.calls).toEqual(["serve", "runner", "runner-hook", "close"]);
    expect(fixture.hooks.onRunnerError).toHaveBeenCalledWith(runnerError);
  });

  it.each(["serve", "runner", "close"] as const)(
    "%s 错误文本不由核心添加 secrets",
    async (phase) => {
      const error = new Error(`${phase} failed`);
      const fixture = makeFixture({
        ...(phase === "serve"
          ? {
              serveImpl: async () => {
                throw error;
              },
            }
          : {}),
        ...(phase === "runner"
          ? {
              runImpl: async () => {
                throw error;
              },
            }
          : {}),
        ...(phase === "close"
          ? {
              closeImpl: async () => {
                throw error;
              },
            }
          : {}),
      });

      let caught: unknown;
      try {
        await executeRun(fixture.request, fixture.deps, fixture.hooks);
      } catch (caughtError) {
        caught = caughtError;
      }
      expect(caught).toBe(error);
      expect((caught as Error).message).not.toContain(SECRET);
    },
  );
});
