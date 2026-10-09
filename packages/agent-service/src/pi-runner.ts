import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategoryLogger } from "@asteriskzuo/agent-logger";
import type {
  AgentServeContext,
  AgentServiceDeps,
  ValidatedAgentRequest,
} from "./index.js";
import type { ServiceResponse } from "./socket-server.js";

/** 输入序列化后的体积上限（argv 长度保护） */
const MAX_INPUT_BYTES = 512 * 1024;
/** agent_failed 错误里携带的 stderr 尾部长度 */
const STDERR_TAIL_CHARS = 2048;

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

/** pi 子进程 env：deps 注入的基础 env + PI_CODING_AGENT_DIR + AUDIT_LOG_PATH（不继承其他环境） */
export function buildPiEnv(
  deps: AgentServiceDeps,
  ctx: AgentServeContext,
): Record<string, string> {
  return {
    ...deps.pi_env,
    PI_CODING_AGENT_DIR: deps.pi_agent_dir,
    AUDIT_LOG_PATH: ctx.audit_log_path,
  };
}

/** 白名单纪律的公共 flag（agent / compact 两种形态共用）：关闭自动发现，仅注入平台审计 extension */
export function whitelistFlags(): string[] {
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

/** agent op：装配命令行 → spawn pi（单次推理）→ 提取最终 assistant 文本。
 *  失败路径全部返回 ok:false（input_too_large / skill_not_allowed / agent_failed / agent_empty_output） */
export async function runAgentOp(
  deps: AgentServiceDeps,
  ctx: AgentServeContext,
  req: ValidatedAgentRequest,
  procs: Set<ChildProcess>,
  log: CategoryLogger,
): Promise<ServiceResponse> {
  const startedAt = Date.now();
  // 结果埋点：op/skills/耗时/usage?/结果前缀（best-effort，不影响契约）
  const done = (resp: ServiceResponse, usage?: unknown): ServiceResponse => {
    const fields: Record<string, unknown> = {
      op: "agent",
      skills: req.skills,
      duration_ms: Date.now() - startedAt,
      result: resp.ok ? "ok" : resp.error.split(":")[0],
    };
    if (usage !== undefined) fields.usage = usage;
    if (resp.ok) log.info("agent 服务调用", fields);
    else log.warn("agent 服务调用失败", fields);
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

  // skill 白名单：逐个按 name 校验 ∈ ctx.skills，通过后取物化路径注入
  const byName = new Map(ctx.skills.map((s) => [s.name, s.path]));
  const skillPaths: string[] = [];
  for (const name of req.skills) {
    const path = byName.get(name);
    if (path === undefined) return fail(`skill_not_allowed: ${name}`);
    skillPaths.push(path);
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

  // 命令行装配（唯一形态，spec §5.1）
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
    ctx.model,
    "--no-skills",
    ...skillPaths.flatMap((p) => ["--skill", p]),
    "--no-extensions",
    "-e",
    resolveAuditExtensionPath(),
    "--no-prompt-templates",
    "--no-context-files",
    "--no-tools",
    inputText,
  ];

  const child = spawn(deps.pi_cli_path, args, {
    cwd: ctx.workspace,
    env: buildPiEnv(deps, ctx),
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exit = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("error", (err) => {
      stderr += String(err.message);
      resolve({ code: -1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  procs.delete(child);

  if (exit.code !== 0) {
    const tail = stderr.slice(-STDERR_TAIL_CHARS).trim();
    return fail(
      `agent_failed: ${tail || `pi 退出异常 code=${exit.code} signal=${exit.signal}`}`,
    );
  }

  const extracted = extractAssistantOutput(stdout);
  if (!extracted || extracted.text === "") {
    return fail("agent_empty_output");
  }
  return done(
    { contract_version: "v1", ok: true, output: extracted.text },
    extracted.usage,
  );
}
