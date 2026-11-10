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
import { parseEffectiveModels } from "./models-json.js";

/** skill 引用：上游（PackageRegistry/ContextLoader）已完成名解析与物化 */
export interface SkillRef {
  /** 白名单校验的键（sdk.agent 请求里的名） */
  name: string;
  /** 物化后的 skill 目录绝对路径（注入时取其下 SKILL.md，经 --append-system-prompt 内联） */
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
  /** --model 缺省值（provider/id，= 生效配置第一个 provider 的第一个模型）；
   *  "" = 业务未配置大模型（agent/compact 一律回 model_not_configured） */
  model: string;
  /** pi 会话存储目录 businesses/{business_id}/cache/agent-sessions/{source}/{session_id}/（装配根保证存在） */
  session_dir: string;
  /** 请求体审计落盘路径 businesses/{business_id}/runs/{source}/{session_id}/{run_id}/audit/llm-requests.jsonl */
  audit_log_path: string;
  /** 按 run 计的 agent 调用上限 */
  quota: { max_agent_calls: number };
  /** 业务自定义 Pi 配置的派生 agent 目录（含业务 models.json）——模型的唯一来源；
   *  undefined = 业务未配置大模型（agent/compact 拒绝，models 回空枚举） */
  pi_agent_dir?: string;
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

/** LLM 调用统计写口（装配根注入；缺省 = 不采集）。
 *  实现纪律：写失败必须自行消化（warn 日志），不得抛回——agent op 不因统计失败 */
export interface LlmCallSink {
  record(call: {
    run_id: string;
    business_id: string;
    ts: string;
    op: "agent";
    model: string;
    skills: string[];
    mode: "channel" | "fresh";
    ok: boolean;
    error?: string;
    duration_ms: number;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_tokens: number;
      cost_total: number;
    };
  }): void;
}

/** 装配根注入的依赖 */
export interface AgentServiceDeps {
  /** pi 可执行文件绝对路径（测试指向 fixture 脚本） */
  pi_cli_path: string;
  /** pi 子进程基础 env（仅 PATH/HOME；模型凭据走业务派生目录的 models.json） */
  pi_env: Record<string, string>;
  /** 通道会话映射 */
  mapping: AgentSessionMapping;
  /** LLM 调用统计写口（装配根注入；缺省 = 不采集，本地运行不注入）。
   *  实现必须自行消化写异常（fail-open），调用点另有一层防御 try/catch 兜底 */
  llm_call_sink?: LlmCallSink;
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
  /** 指定模型（provider/id）；undefined = 业务默认模型（ctx.model）；白名单外 → model_not_allowed */
  model?: string;
}

/** 已通过形状校验的 models 请求（查询生效配置枚举；不计配额） */
export interface ValidatedModelsRequest {
  op: "models";
}

/** 已通过形状校验的 compact/clear 请求 */
export interface ValidatedSimpleRequest {
  op: "compact" | "clear";
}

/** 校验后的请求（token/版本/op 形状均合法） */
export type ValidatedRequest =
  ValidatedAgentRequest | ValidatedModelsRequest | ValidatedSimpleRequest;

function invalidRequest(): ServiceResponse {
  return { contract_version: "v1", ok: false, error: "invalid_request" };
}

/**
 * socket 契约 v2 升级内容（2026-11-01，spec：docs/specs/2026-11-01-business-multi-model-spec.md §5）：
 *  1. agent 请求新增可选字段 model（provider/id）：指定本次调用使用的模型，缺省 = 业务默认模型；
 *     不在本业务生效配置枚举内 → model_not_allowed；
 *  2. 新增 op "models"：查询本 run 生效配置的 provider/模型枚举（只含名字与 id，绝不含敏感字段）；不计配额；
 *  3. 新增错误码：model_not_allowed、model_not_configured（业务未配置大模型）。
 *  协商规则：SDK 所有请求恒定发 "v2"；本服务端同时接受 "v1"/"v2"；v1 请求携带 model → invalid_request。
 */
function validateRequest(
  raw: unknown,
  token: string,
): { ok: true; req: ValidatedRequest } | { ok: false } {
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const r = raw as Record<string, unknown>;
  if (r.contract_version !== "v1" && r.contract_version !== "v2") {
    return { ok: false };
  }
  if (r.token !== token) return { ok: false };
  if (r.op === "agent") {
    // 防御：v1 请求携带 model 字段一律拒绝（防手工构造的客户端误以为静默生效）
    if (r.contract_version === "v1" && "model" in r) return { ok: false };
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
    let model: string | undefined;
    if (r.model !== undefined) {
      if (typeof r.model !== "string" || r.model.trim() === "") {
        return { ok: false };
      }
      model = r.model;
    }
    return {
      ok: true,
      req: {
        op: "agent",
        skills: r.skills,
        input: r.input,
        mode,
        ...(model !== undefined ? { model } : {}),
      },
    };
  }
  if (r.op === "models") {
    return { ok: true, req: { op: "models" } };
  }
  if (r.op === "compact" || r.op === "clear") {
    return { ok: true, req: { op: r.op } };
  }
  return { ok: false };
}

/** 杀在飞 pi：逐个 abort（process-runner 内部 SIGTERM，2 秒未退补 SIGKILL） */
function abortAll(inflight: Set<AbortController>): void {
  for (const controller of inflight) {
    try {
      controller.abort();
    } catch {
      // 已结束，忽略
    }
  }
}

/** 创建 AgentService：平台唯一 spawn pi 的地方（sdk.agent() / sdk.session.* 的另一端） */
export function createAgentService(deps: AgentServiceDeps): AgentService {
  return {
    async serve(ctx: AgentServeContext): Promise<RunningAgentService> {
      // 审计文件父目录 serve 时建一次（审计 extension 内也会 mkdir -p 兜底）
      mkdirSync(dirname(ctx.audit_log_path), { recursive: true });

      // 生效模型配置：serve 时解析一次（业务未配置 = undefined；解析失败抛错 → run 失败，
      // fail-fast 不消费可疑文件）。models op 视图与 agent op 白名单共用这份产物。
      const models =
        ctx.pi_agent_dir !== undefined
          ? parseEffectiveModels(ctx.pi_agent_dir)
          : undefined;

      const token = randomUUID();
      // socket 放 os.tmpdir()：unix socket 路径长约 104 字符，三维 run 目录易超限
      const socketPath = join(tmpdir(), `ea-${ctx.run_id}.sock`);
      const inflight = new Set<AbortController>(); // 在飞 pi 调用的取消器（结束移除，close 全量 abort）
      const log: CategoryLogger = logger.for({
        // 模块日志归 system.log：entry-loop.log 只留循环流转骨架（取出→
        // 挂通道→run 开始/终态→完结），agent 服务调用细节属模块内部
        module: "agent-service",
        run_id: ctx.run_id,
        channel_id: ctx.channel_id,
      });
      let closed = false;
      let agentCalls = 0; // 配额计数：每次 agent 请求计 1（不论成败；models op 不计）

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
          if (models === undefined) {
            log.warn("agent 服务调用失败", {
              op: "agent",
              result: "model_not_configured",
            });
            return {
              contract_version: "v1",
              ok: false,
              error: "model_not_configured",
            };
          }
          return runAgentOp(deps, ctx, req, models, inflight, log);
        }
        if (req.op === "models") {
          // 元数据查询：只含名字与 id（绝不含敏感字段）；未配置 = 空枚举；不计配额
          const output =
            models === undefined
              ? { default: "", providers: [] }
              : {
                  default: ctx.model,
                  providers: models.providers.map((p) => ({
                    name: p.name,
                    models: [...p.models],
                  })),
                };
          log.info("agent 服务调用", { op: "models", result: "ok" });
          return { contract_version: "v1", ok: true, output };
        }
        if (req.op === "compact") {
          if (models === undefined) {
            log.warn("agent 服务调用失败", {
              op: "compact",
              result: "model_not_configured",
            });
            return {
              contract_version: "v1",
              ok: false,
              error: "model_not_configured",
            };
          }
          return runCompactOp(deps, ctx, models, inflight, log);
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
        abortAll(inflight); // 杀在飞 pi：在飞的 agent/compact 以 agent_failed 收尾回完
        closePromise = server.drainAndClose();
        return closePromise;
      };

      return { endpoint: { socket_path: socketPath, token }, close };
    },
  };
}
