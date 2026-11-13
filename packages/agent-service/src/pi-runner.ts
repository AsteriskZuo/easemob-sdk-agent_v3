import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategoryLogger } from "@asteriskzuo/agent-logger";
import { parseChannelId } from "@asteriskzuo/agent-contracts";
import { ProcessError, runProcess } from "@asteriskzuo/agent-process-runner";
import type {
  AgentServeContext,
  AgentServiceDeps,
  LlmCallSink,
  ValidatedAgentRequest,
} from "./index.js";
import type { EffectiveModels } from "./models-json.js";
import type { ServiceResponse } from "./socket-server.js";

/** 输入序列化后的体积上限（argv 长度保护） */
const MAX_INPUT_BYTES = 512 * 1024;
/** agent_failed 错误里携带的 stderr 尾部长度 */
const STDERR_TAIL_CHARS = 2048;
/** agent op 自身不设执行时限：实际界限由 run 级 wall-clock 与 AgentService.close 的 abort 控制；
 *  进程原语要求正数超时，这里给 24h 兜底（等价于迁移前的"无超时"） */
const AGENT_OP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** 平台审计 extension 的绝对路径（本包 extensions/audit.js）。
 *  dist/ 与 dist-test/src/ 布局深度不同，从本模块位置向上找 */
export function resolveAuditExtensionPath(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, "extensions", "audit.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("@asteriskzuo/agent-service: 未找到 extensions/audit.js");
}

/** 平台路径守卫 extension 的绝对路径（本包 extensions/path-guard.js）。
 *  查找逻辑与 resolveAuditExtensionPath 相同（dist/ 与 dist-test/src/ 布局深度不同，向上找） */
export function resolvePathGuardExtensionPath(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, "extensions", "path-guard.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("@asteriskzuo/agent-service: 未找到 extensions/path-guard.js");
}

/** pi 子进程 env：deps 注入的基础 env + PI_CODING_AGENT_DIR + AUDIT_LOG_PATH（不继承其他环境）。
 *  PI_CODING_AGENT_DIR 取本 run 生效的业务派生目录（模型的唯一来源，由调用方从
 *  EffectiveModels 传入；业务未配置时 agent/compact 已在 dispatch 层拦截，到不了这里） */
export function buildPiEnv(
  deps: AgentServiceDeps,
  ctx: AgentServeContext,
  agentDir: string,
): Record<string, string> {
  return {
    ...deps.pi_env,
    PI_CODING_AGENT_DIR: agentDir,
    AUDIT_LOG_PATH: ctx.audit_log_path,
  };
}

/** 白名单纪律的公共 flag（agent / compact 两种形态共用）：关闭自动发现，仅注入平台审计 extension。
 *  piTools（业务清单声明的 pi 内置工具白名单）非空时：`--no-tools` 替换为 `--tools <逗号名单>`，
 *  并在审计 extension 之后追加注入路径守卫 extension（业务不可摘除，--no-extensions 保证）；
 *  空/undefined 保持现状（恒 --no-tools） */
export function whitelistFlags(piTools?: string[]): string[] {
  if (piTools === undefined || piTools.length === 0) {
    return [
      "--no-skills",
      "--no-extensions",
      "-e",
      resolveAuditExtensionPath(),
      "--no-prompt-templates",
      "--no-context-files",
      "--no-tools",
    ];
  }
  return [
    "--no-skills",
    "--no-extensions",
    "-e",
    resolveAuditExtensionPath(),
    "-e",
    resolvePathGuardExtensionPath(),
    "--no-prompt-templates",
    "--no-context-files",
    "--tools",
    piTools.join(","),
  ];
}

/** 从 --mode json 的 stdout JSONL 事件流提取最终 assistant 文本：
 *  取最后一条 {type:'message_end', message.role:'assistant'} 的 text 内容片拼接 */
function extractAssistantOutput(stdout: string): {
  text: string;
  usage?: unknown;
} | null {
  let last: { text: string; usage?: unknown } | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // 非 JSON 行跳过
    }
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as Record<string, unknown>;
    const message = e.message as Record<string, unknown> | undefined;
    if (e.type !== "message_end" || message?.role !== "assistant") continue;
    let text = "";
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part !== "object" || part === null) continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") text += p.text;
      }
    }
    last = { text, usage: message.usage };
  }
  return last;
}

/** sink 调用记录的字段类型（契约 A 的 record 参数，一字不差对齐 LlmCallSink） */
type LlmCallRecord = Parameters<LlmCallSink["record"]>[0];

/** channel_id → business_id：业务通道取第三段；出口通道到不了 agent op、
 *  解析失败或非 business 一律兜底 "" 并 warn（统计不阻断业务） */
function resolveBusinessId(channelId: string, log: CategoryLogger): string {
  try {
    const parsed = parseChannelId(channelId);
    if (parsed.kind === "business") return parsed.businessId;
    log.warn("channel_id 非业务通道，llm_calls 的 business_id 兜底为空", {
      channel_id: channelId,
    });
    return "";
  } catch {
    log.warn("channel_id 解析失败，llm_calls 的 business_id 兜底为空", {
      channel_id: channelId,
    });
    return "";
  }
}

/** pi Usage（@earendil-works/pi-ai：input/output/cacheRead/cacheWrite/totalTokens/cost.total）
 *  → sink usage 字段一对一映射；形状不符（提取失败/模型未上报）返回 undefined——
 *  落行但用量字段缺失（由 llm.calls_without_usage 指标暴露数据质量）。
 *  reasoning / cacheWrite1h 不采（v1 无消费场景） */
function mapPiUsage(usage: unknown): LlmCallRecord["usage"] {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const cost =
    typeof u.cost === "object" && u.cost !== null
      ? (u.cost as Record<string, unknown>)
      : undefined;
  const nums = [
    u.input,
    u.output,
    u.cacheRead,
    u.cacheWrite,
    u.totalTokens,
    cost?.total,
  ];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return undefined;
  }
  return {
    input_tokens: u.input as number,
    output_tokens: u.output as number,
    cache_read_tokens: u.cacheRead as number,
    cache_write_tokens: u.cacheWrite as number,
    total_tokens: u.totalTokens as number,
    cost_total: (cost as Record<string, unknown>).total as number,
  };
}

/** agent op：装配命令行 → 经 process-runner 执行 pi（单次推理）→ 提取最终 assistant 文本。
 *  失败路径全部返回 ok:false（input_too_large / skill_not_allowed / model_not_allowed / agent_failed / agent_empty_output） */
export async function runAgentOp(
  deps: AgentServiceDeps,
  ctx: AgentServeContext,
  req: ValidatedAgentRequest,
  models: EffectiveModels,
  inflight: Set<AbortController>,
  log: CategoryLogger,
): Promise<ServiceResponse> {
  const startedAt = Date.now();
  // 实际使用模型：请求显式指定（已过白名单）或业务默认模型
  const effectiveModel = req.model ?? ctx.model;
  // 结果埋点：op/skills/model/耗时/usage?/结果前缀（best-effort，不影响契约）
  const done = (resp: ServiceResponse, usage?: unknown): ServiceResponse => {
    const durationMs = Date.now() - startedAt;
    const fields: Record<string, unknown> = {
      op: "agent",
      skills: req.skills,
      model: effectiveModel,
      duration_ms: durationMs,
      result: resp.ok ? "ok" : resp.error.split(":")[0],
    };
    if (usage !== undefined) fields.usage = usage;
    if (resp.ok) log.info("agent 服务调用", fields);
    else log.warn("agent 服务调用失败", fields);
    // LLM 调用统计落库（决策 2/3：一行 = 一次 agent op，成功带 usage、失败无 usage）。
    // fail-open：sink 异常防御 try/catch 消化（warn 后照旧返回），绝不影响 op 结果
    if (deps.llm_call_sink !== undefined) {
      try {
        const call: LlmCallRecord = {
          run_id: ctx.run_id,
          business_id: resolveBusinessId(ctx.channel_id, log),
          ts: new Date().toISOString(),
          op: "agent",
          model: effectiveModel,
          skills: [...req.skills],
          mode: req.mode,
          ok: resp.ok,
          duration_ms: durationMs,
        };
        if (resp.ok) {
          const mapped = mapPiUsage(usage);
          if (mapped !== undefined) call.usage = mapped;
        } else {
          // 与日志埋点同规则：error 取首段错误码
          call.error = resp.error.split(":")[0];
        }
        deps.llm_call_sink.record(call);
      } catch (e) {
        log.warn("llm 调用统计 sink 异常已消化", { error: String(e) });
      }
    }
    return resp;
  };
  const fail = (error: string): ServiceResponse =>
    done({ contract_version: "v1", ok: false, error });

  // 输入字符串化 + 体积保护
  const inputText =
    typeof req.input === "string" ? req.input : JSON.stringify(req.input);
  if (Buffer.byteLength(inputText, "utf8") > MAX_INPUT_BYTES) {
    return fail("input_too_large");
  }

  // 显式 model 白名单：必须命中本 run 生效配置枚举（fail-fast，不 spawn pi）
  if (req.model !== undefined && !models.allowed.has(req.model)) {
    return fail(`model_not_allowed: ${req.model}`);
  }

  // skill 白名单：逐个按 name 校验 ∈ ctx.skills，通过后把物化目录下的 SKILL.md
  // 以 --append-system-prompt 内联进系统提示词（pi 原生 --skill 是渐进披露：
  // 只注入目录、靠 read 工具按需加载，--no-tools 下内容根本到不了模型——已实证）。
  // fail-fast 存在性校验：pi 对不存在路径会把路径串按字面文本追加（静默降级），
  // 宁可该次调用失败也不消费残缺提示词。
  const byName = new Map(ctx.skills.map((s) => [s.name, s.path]));
  const skillFiles: string[] = [];
  for (const name of req.skills) {
    const dir = byName.get(name);
    if (dir === undefined) return fail(`skill_not_allowed: ${name}`);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) return fail(`skill_missing: ${name}`);
    skillFiles.push(file);
  }

  // 会话：channel 模式恢复/绑定（pi 对不存在的 --session-id 会创建，先绑安全）；fresh 每次新 id 不写映射
  let sessionId: string;
  if (req.mode === "channel") {
    const existing = deps.mapping.getAgentSession(ctx.channel_id);
    if (existing !== undefined) {
      sessionId = existing;
    } else {
      sessionId = randomUUID();
      deps.mapping.bindAgentSession(ctx.channel_id, sessionId);
    }
  } else {
    sessionId = randomUUID();
  }

  // 命令行装配（唯一形态，spec §5.1）。
  // 公共白名单 flag 与 compact 共用 whitelistFlags(ctx.pi_tools)；其首项 --no-skills 单独拼接，
  // 让 skill 注入（--append-system-prompt）紧随 --no-skills 之后，保持未声明 pi_tools 时 argv 逐字节不变
  const [, ...restWhitelistFlags] = whitelistFlags(ctx.pi_tools);
  const args = [
    "-p",
    "--mode",
    "json",
    "--session-id",
    sessionId,
    "--session-dir",
    ctx.session_dir,
    "--system-prompt",
    ctx.prompt,
    "--model",
    effectiveModel,
    "--no-skills",
    ...skillFiles.flatMap((f) => ["--append-system-prompt", f]),
    ...restWhitelistFlags,
    inputText,
  ];

  const controller = new AbortController();
  inflight.add(controller);
  try {
    const result = await runProcess(deps.pi_cli_path, args, {
      cwd: ctx.workspace,
      env: { mode: "exact", values: buildPiEnv(deps, ctx, models.agent_dir) },
      timeout_ms: AGENT_OP_TIMEOUT_MS,
      signal: controller.signal,
      max_output_bytes: null, // 迁移前聚合不设上限，保持兼容
    });
    const extracted = extractAssistantOutput(result.stdout);
    if (!extracted || extracted.text === "") {
      return fail("agent_empty_output");
    }
    return done(
      { contract_version: "v1", ok: true, output: extracted.text },
      extracted.usage,
    );
  } catch (e) {
    // 统一归类：非零退出 / close abort / 超时都回 agent_failed（stderr 有界尾部优先）
    if (e instanceof ProcessError) {
      const tail = e.stderr.slice(-STDERR_TAIL_CHARS).trim();
      return fail(
        `agent_failed: ${tail || `pi 退出异常 code=${e.code} signal=${e.signal}`}`,
      );
    }
    throw e;
  } finally {
    inflight.delete(controller);
  }
}
