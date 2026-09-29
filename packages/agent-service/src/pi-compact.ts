import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { CategoryLogger } from "@easemob/agent-logger";
import type { AgentServeContext, AgentServiceDeps } from "./index.js";
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
 *  {type:'response', command:'compact'}，成功后杀进程。
 *  通道无映射会话时 no-op（ok:true, output:null，不 spawn）。 */
export async function runCompactOp(
  deps: AgentServiceDeps,
  ctx: AgentServeContext,
  procs: Set<ChildProcess>,
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
    ...whitelistFlags(),
  ];

  const child = spawn(deps.pi_cli_path, args, {
    cwd: ctx.workspace,
    env: buildPiEnv(deps, ctx),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.add(child);

  return new Promise<ServiceResponse>((resolve) => {
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      finish(fail("agent_failed: compact timeout"));
    }, COMPACT_TIMEOUT_MS);

    function finish(resp: ServiceResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      procs.delete(child);
      try {
        child.kill("SIGTERM"); // compact 已完成/失败，长驻 RPC 进程不再保留
      } catch {
        // 已退出，忽略
      }
      resolve(resp);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
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
          finish(
            e.success === true
              ? OK_NULL
              : fail(
                  `agent_failed: compact 失败${e.error !== undefined ? `: ${String(e.error)}` : ""}`,
                ),
          );
          return;
        }
      }
    });
    child.on("error", (err) => {
      if (!settled) finish(fail(`agent_failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (!settled) finish(fail(`agent_failed: compact 进程退出 code=${code}`));
    });

    child.stdin.write(JSON.stringify({ id: "c1", type: "compact" }) + "\n");
  });
}
