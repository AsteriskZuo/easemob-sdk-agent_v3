import type { CategoryLogger } from "@asteriskzuo/agent-logger";
import { ProcessError, runProcess } from "@asteriskzuo/agent-process-runner";
import type { AgentServeContext, AgentServiceDeps } from "./index.js";
import type { EffectiveModels } from "./models-json.js";
import type { ServiceResponse } from "./socket-server.js";
import { buildPiEnv, whitelistFlags } from "./pi-runner.js";

/** compact RPC 响应超时：30 秒无响应杀进程回 agent_failed */
const COMPACT_TIMEOUT_MS = 30_000;

const OK_NULL: ServiceResponse = {
  contract_version: "v1",
  ok: true,
  output: null,
};

/** compact op：pi 无 headless CLI 入口，走 --mode rpc 长驻进程：
 *  stdin 写一行 {"id":"c1","type":"compact"}，读 stdout 按行匹配
 *  {type:'response', command:'compact'}，成功后 abort 收尾。
 *  通道无映射会话时 no-op（ok:true, output:null，不 spawn）。 */
export async function runCompactOp(
  deps: AgentServiceDeps,
  ctx: AgentServeContext,
  models: EffectiveModels,
  inflight: Set<AbortController>,
  log: CategoryLogger,
): Promise<ServiceResponse> {
  const startedAt = Date.now();
  const done = (resp: ServiceResponse): ServiceResponse => {
    const fields = {
      op: "compact",
      duration_ms: Date.now() - startedAt,
      result: resp.ok ? "ok" : resp.error.split(":")[0],
    };
    if (resp.ok) log.info("agent 服务调用", fields);
    else log.warn("agent 服务调用失败", fields);
    return resp;
  };
  const fail = (error: string): ServiceResponse =>
    done({ contract_version: "v1", ok: false, error });

  const sessionId = deps.mapping.getAgentSession(ctx.channel_id);
  if (sessionId === undefined) {
    return done(OK_NULL); // 无会话可压，no-op
  }

  const args = [
    "--mode",
    "rpc",
    "--session-id",
    sessionId,
    "--session-dir",
    ctx.session_dir,
    "--model",
    ctx.model,
    ...whitelistFlags(ctx.pi_tools),
  ];

  const controller = new AbortController();
  inflight.add(controller);
  let buffer = "";
  /** 首个 compact 响应的判定结果；判定后立即 abort 长驻 RPC 进程，由 catch 分支回收返回 */
  let outcome: ServiceResponse | null = null;

  try {
    await runProcess(deps.pi_cli_path, args, {
      cwd: ctx.workspace,
      env: { mode: "exact", values: buildPiEnv(deps, ctx, models.agent_dir) },
      stdin: JSON.stringify({ id: "c1", type: "compact" }) + "\n",
      timeout_ms: COMPACT_TIMEOUT_MS,
      signal: controller.signal,
      on_stdout: (chunk: Buffer) => {
        if (outcome !== null) return;
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          let ev: unknown;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof ev !== "object" || ev === null) continue;
          const e = ev as Record<string, unknown>;
          if (e.type === "response" && e.command === "compact") {
            // 成功路径保持迁移前行为：OK_NULL 不经 done() 埋点；失败路径经 fail() 埋点
            outcome =
              e.success === true
                ? OK_NULL
                : fail(
                    `agent_failed: compact 失败${e.error !== undefined ? `: ${String(e.error)}` : ""}`,
                  );
            controller.abort();
            return;
          }
        }
      },
    });
    // 长驻进程自行退出（exit 0）且未回响应
    return fail("agent_failed: compact 进程退出 code=0");
  } catch (e) {
    // abort 是判定完成后的主动收尾，返回已判定的结果
    if (outcome !== null) return outcome;
    if (e instanceof ProcessError) {
      if (e.kind === "timeout") return fail("agent_failed: compact timeout");
      if (e.kind === "spawn_failed") return fail(`agent_failed: ${e.message}`);
      return fail(`agent_failed: compact 进程退出 code=${e.code}`);
    }
    throw e;
  } finally {
    inflight.delete(controller);
  }
}
