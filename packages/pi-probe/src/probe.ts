import { ProcessError, runProcess } from "@asteriskzuo/agent-process-runner";

export interface PiProbeOptions {
  /** 已由 server 解析的 Pi CLI 绝对路径 */
  pi_cli_path: string;
  /** 本次验证专用 agent 目录，含候选 models.json */
  pi_agent_dir: string;
  /** 唯一被验证的 provider/id */
  model: string;
  /** PATH/HOME 等显式基础环境；探针只追加 PI_CODING_AGENT_DIR */
  env: Record<string, string>;
  /** 验证短期工作目录（不是业务 runs 目录） */
  cwd: string;
  /** wall-clock 超时（毫秒）；server 固定传入 15000，本包不读全局配置 */
  timeout_ms: number;
  /** 被新验证或关闭服务取代时取消 */
  signal?: AbortSignal;
}

/** 探针失败分类（机器可判） */
export type PiProbeFailureKind =
  | "spawn_failed" // Pi CLI 无法启动
  | "timeout" // 限定时间内未观察到真实生成
  | "aborted" // 被新验证或服务关闭取消，且此前未观察到真实生成
  | "process_failed" // 非零退出或其他未分类进程失败
  | "assistant_error" // assistant error/aborted，包括退出码 0 的情况
  | "no_generation"; // 进程结束仍无真实内容（含只有 header/session 的情况）

export interface PiProbeResult {
  /** 只有观察到真实模型内容才为 true */
  ok: boolean;
  /** 总耗时（毫秒） */
  duration_ms: number;
  /** ok=false 时的机器分类；ok=true 时省略 */
  failure_kind?: PiProbeFailureKind;
  /** ok=false 时的有界详情（≤2048 字符）；不写日志，调用方脱敏后再展示 */
  detail?: string;
}

/** 失败详情长度上限（detail 只留尾部） */
const DETAIL_LIMIT = 2048;

/** 真实模型探针：用候选配置跑一次最小真实调用，只认真实生成内容。
 *  `pi -p --mode json --no-session --model <provider/id> --system-prompt "Reply briefly." ping`，
 *  关闭 skills/extensions/prompt-templates/context-files/tools；不传业务 prompt、审计 extension
 *  或 --max-tokens。收到首个有效内容即取消进程（自身取消归一为成功）。
 *  本包不读 DB、不保存配置、不决定兜底、不处理模板或控制台脱敏 */
export async function probePiModel(
  options: PiProbeOptions,
): Promise<PiProbeResult> {
  const startedAt = Date.now();
  const done = (
    ok: boolean,
    failureKind?: PiProbeFailureKind,
    detail?: string,
  ): PiProbeResult => ({
    ok,
    duration_ms: Date.now() - startedAt,
    ...(failureKind !== undefined ? { failure_kind: failureKind } : {}),
    ...(detail !== undefined ? { detail: detail.slice(-DETAIL_LIMIT) } : {}),
  });

  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--model",
    options.model,
    "--system-prompt",
    "Reply briefly.",
    "--no-skills",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-tools",
    "ping",
  ];

  const controller = new AbortController();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  let generated = false; // 观察到真实模型内容
  let assistantError: string | null = null; // assistant error/aborted（含 exit 0）
  let buffer = "";

  /** 逐行解析 --mode json 事件流；命中真实内容即 abort 收尾 */
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "" || generated) return;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行跳过
    }
    if (typeof ev !== "object" || ev === null) return;
    const e = ev as Record<string, unknown>;

    if (e.type === "message_update") {
      const ae = e.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ae === undefined || ae === null) return;
      // 流式增量：非空 text_delta / thinking_delta
      if (
        (ae.type === "text_delta" || ae.type === "thinking_delta") &&
        typeof ae.delta === "string" &&
        ae.delta !== ""
      ) {
        generated = true;
        controller.abort();
        return;
      }
      // 非流式实现的对应 end 事件（含非空内容）
      if (
        (ae.type === "text_end" || ae.type === "thinking_end") &&
        typeof ae.content === "string" &&
        ae.content !== ""
      ) {
        generated = true;
        controller.abort();
      }
      return;
    }

    if (e.type === "message_end") {
      const message = e.message as Record<string, unknown> | undefined;
      if (message === undefined || message === null) return;
      if (message.role !== "assistant") return;
      // assistant error 必须失败，即使进程退出码为 0
      const stopReason = message.stopReason;
      if (
        stopReason === "error" ||
        stopReason === "aborted" ||
        typeof message.errorMessage === "string"
      ) {
        assistantError =
          typeof message.errorMessage === "string"
            ? message.errorMessage
            : `assistant ${String(stopReason)}`;
        return;
      }
      // 非流式兜底：最终 assistant message 含实际文本/思考内容
      if (Array.isArray(message.content)) {
        const hasContent = message.content.some((part) => {
          if (typeof part !== "object" || part === null) return false;
          const p = part as Record<string, unknown>;
          return (
            (p.type === "text" &&
              typeof p.text === "string" &&
              p.text !== "") ||
            (p.type === "thinking" &&
              typeof p.thinking === "string" &&
              p.thinking !== "")
          );
        });
        if (hasContent) {
          generated = true;
          controller.abort();
        }
      }
    }
  };

  const onChunk = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  };

  const flush = (): void => {
    if (buffer.trim() !== "") {
      handleLine(buffer);
      buffer = "";
    }
  };

  try {
    await runProcess(options.pi_cli_path, args, {
      cwd: options.cwd,
      env: {
        mode: "exact",
        values: { ...options.env, PI_CODING_AGENT_DIR: options.pi_agent_dir },
      },
      timeout_ms: options.timeout_ms,
      signal: controller.signal,
      on_stdout: onChunk,
    });
    flush();
    // 进程正常退出（exit 0）
    if (generated) return done(true);
    if (assistantError !== null) {
      return done(false, "assistant_error", assistantError);
    }
    return done(false, "no_generation", "进程退出且未观察到真实生成内容");
  } catch (e) {
    flush();
    // 首个真实内容后的自身取消归一为成功
    if (generated) return done(true);
    if (assistantError !== null) {
      return done(false, "assistant_error", assistantError);
    }
    if (e instanceof ProcessError) {
      if (e.kind === "spawn_failed") {
        return done(false, "spawn_failed", e.message);
      }
      if (e.kind === "timeout") {
        return done(
          false,
          "timeout",
          `超过 ${options.timeout_ms}ms 未观察到真实生成`,
        );
      }
      if (e.kind === "aborted") {
        return done(false, "aborted", "被新验证或服务关闭取消");
      }
      const tail = e.stderr.slice(-DETAIL_LIMIT).trim();
      return done(false, "process_failed", tail !== "" ? tail : e.message);
    }
    return done(false, "process_failed", String(e));
  }
}
