import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@asteriskzuo/agent-logger";
import type { CategoryLogger } from "@asteriskzuo/agent-logger";
import { createSocketServer } from "./socket-server.js";
import type { ServiceResponse } from "./socket-server.js";
import { runAgentOp } from "./pi-runner.js";
import { runCompactOp } from "./pi-compact.js";

/** skill 引用：上游（PackageRegistry/ContextLoader）已完成名解析与物化 */
export interface SkillRef {
  /** 白名单校验的键（sdk.agent 请求里的名） */
  name: string;
  /** 物化后的 skill 绝对路径（--skill 注入） */
  path: string;
}

/** 每 run 一次的 serve 上下文（与 BusinessContext 的字段映射归装配层 T12） */
export interface AgentServeContext {
  /** run 标识（socket 文件名、日志关联用） */
  run_id: string;
  /** 业务通道 channel_id（会话映射键；出口通道不到这里） */
  channel_id: string;
  /** run 工作目录 = pi 子进程 cwd */
  workspace: string;
  /** 提示词总纲 → --system-prompt */
  prompt: string;
  /** 本业务 skill 白名单（全集；请求选子集注入） */
  skills: SkillRef[];
  /** --model 值（provider/id 或 models.json 中的模型名） */
  model: string;
  /** pi 会话存储目录 cache/agent-sessions/{三维}/（装配根保证存在） */
  session_dir: string;
  /** 请求体审计落盘路径 runs/{三维}/{run_id}/audit/llm-requests.jsonl */
  audit_log_path: string;
  /** 按 run 计的 agent 调用上限 */
  quota: { max_agent_calls: number };
}

/** 通道会话映射最小面（T5 ChannelStore 结构兼容，本包自定义不 import） */
export interface AgentSessionMapping {
  /** 绑定 channel ↔ pi 会话 id（mode:'channel' 首调用时，spawn 前绑定） */
  bindAgentSession(channelId: string, agentSessionId: string): void;
  /** 查 channel 已绑定的 pi 会话 id；未绑定返回 undefined */
  getAgentSession(channelId: string): string | undefined;
  /** 解除 channel 的会话绑定（clear op；幂等） */
  clear(channelId: string): void;
}

/** 装配根注入的依赖 */
export interface AgentServiceDeps {
  /** pi 可执行文件绝对路径（测试指向 fixture 脚本） */
  pi_cli_path: string;
  /** PI_CODING_AGENT_DIR（models.json 所在，平台管理） */
  pi_agent_dir: string;
  /** pi 子进程基础 env（PATH/HOME/模型凭据实际值等，装配根组齐） */
  pi_env: Record<string, string>;
  /** 通道会话映射 */
  mapping: AgentSessionMapping;
}

/** serve 返回的运行句柄 */
export interface RunningAgentService {
  /** 与 T10 spec §5.4 ServiceEndpoint 同形（注入业务进程用） */
  endpoint: { socket_path: string; token: string };
  /** 幂等；杀在飞 pi、删 socket、token 失效 */
  close(): Promise<void>;
}

export interface AgentService {
  /** 每 run 调一次：监听就绪后返回（endpoint 可注入业务进程） */
  serve(ctx: AgentServeContext): Promise<RunningAgentService>;
}

/** 已通过形状校验的 agent 请求（skills 非空、input 存在、mode 已归一） */
export interface ValidatedAgentRequest {
  op: "agent";
  /** 请求选中的 skill 名（非空，逐个过白名单） */
  skills: string[];
  /** 调用输入（字符串直传，其余 JSON.stringify） */
  input: unknown;
  /** 会话模式：channel=恢复/绑定通道会话；fresh=全新会话不写映射 */
  mode: "channel" | "fresh";
}

/** 已通过形状校验的 compact/clear 请求 */
export interface ValidatedSimpleRequest {
  op: "compact" | "clear";
}

/** 校验后的请求（token/版本/op 形状均合法） */
export type ValidatedRequest = ValidatedAgentRequest | ValidatedSimpleRequest;

function invalidRequest(): ServiceResponse {
  return { contract_version: "v1", ok: false, error: "invalid_request" };
}

/** 请求形状校验：非法 JSON 之外的全部 invalid_request 判定集中在这里 */
function validateRequest(
  raw: unknown,
  token: string,
): { ok: true; req: ValidatedRequest } | { ok: false } {
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const r = raw as Record<string, unknown>;
  if (r.contract_version !== "v1") return { ok: false };
  if (r.token !== token) return { ok: false };
  if (r.op === "agent") {
    if (
      !Array.isArray(r.skills) ||
      r.skills.length === 0 ||
      !r.skills.every((s) => typeof s === "string")
    ) {
      return { ok: false };
    }
    if (!("input" in r)) return { ok: false };
    const mode = r.mode ?? "channel";
    if (mode !== "channel" && mode !== "fresh") return { ok: false };
    return {
      ok: true,
      req: { op: "agent", skills: r.skills, input: r.input, mode },
    };
  }
  if (r.op === "compact" || r.op === "clear") {
    return { ok: true, req: { op: r.op } };
  }
  return { ok: false };
}

/** 杀进程组：SIGTERM，2 秒后未退补 SIGKILL（timer unref，不拖住主进程） */
function killAll(procs: Set<ChildProcess>): void {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // 已退出，忽略
    }
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        // 已退出，忽略
      }
    }, 2000);
    timer.unref();
  }
}

/** 创建 AgentService：平台唯一 spawn pi 的地方（sdk.agent() / sdk.session.* 的另一端） */
export function createAgentService(deps: AgentServiceDeps): AgentService {
  return {
    async serve(ctx: AgentServeContext): Promise<RunningAgentService> {
      // 审计文件父目录 serve 时建一次（审计 extension 内也会 mkdir -p 兜底）
      mkdirSync(dirname(ctx.audit_log_path), { recursive: true });

      const token = randomUUID();
      // socket 放 os.tmpdir()：unix socket 路径长约 104 字符，三维 run 目录易超限
      const socketPath = join(tmpdir(), `ea-${ctx.run_id}.sock`);
      const procs = new Set<ChildProcess>(); // 在飞 pi 子进程（退出移除，close 强杀）
      const log: CategoryLogger = logger.for({
        module: "entry-loop",
        run_id: ctx.run_id,
        channel_id: ctx.channel_id,
      });
      let closed = false;
      let agentCalls = 0; // 配额计数：每次 agent 请求计 1（不论成败）

      const dispatch = async (raw: unknown): Promise<ServiceResponse> => {
        if (closed) {
          return { contract_version: "v1", ok: false, error: "service_closed" };
        }
        const v = validateRequest(raw, token);
        if (!v.ok) {
          log.warn("agent 服务请求非法", { result: "invalid_request" });
          return invalidRequest();
        }
        const req = v.req;
        if (req.op === "agent") {
          agentCalls += 1;
          if (agentCalls > ctx.quota.max_agent_calls) {
            log.warn("agent 调用配额超限", {
              op: "agent",
              quota: ctx.quota.max_agent_calls,
              result: "quota_exceeded",
            });
            return {
              contract_version: "v1",
              ok: false,
              error: "quota_exceeded",
            };
          }
          return runAgentOp(deps, ctx, req, procs, log);
        }
        if (req.op === "compact") {
          return runCompactOp(deps, ctx, procs, log);
        }
        deps.mapping.clear(ctx.channel_id);
        log.info("agent 服务调用", { op: "clear", result: "ok" });
        return { contract_version: "v1", ok: true, output: null };
      };

      const server = await createSocketServer({
        socketPath,
        isClosed: () => closed,
        onRequest: dispatch,
      });

      let closePromise: Promise<void> | null = null;
      const close = (): Promise<void> => {
        // 幂等：重复 close 返回同一个进行中的 Promise
        if (closePromise) return closePromise;
        closed = true; // token 随 closed 失效（dispatch 入口即拒）
        killAll(procs); // 杀在飞 pi：在飞的 agent/compact 以 agent_failed 收尾回完
        closePromise = server.drainAndClose();
        return closePromise;
      };

      return { endpoint: { socket_path: socketPath, token }, close };
    },
  };
}
