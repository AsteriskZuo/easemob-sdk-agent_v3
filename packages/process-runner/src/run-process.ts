import { spawn } from "node:child_process";

/** 失败类别（机器可判）：
 *  spawn_failed=无法创建子进程；timeout=超过 timeout_ms 并完成终止清理；
 *  aborted=外部 AbortSignal 主动取消；output_limit=stdout 或 stderr 超过保留上限；
 *  nonzero_exit=子进程以非零码退出（不含已分类的终止原因） */
export type ProcessFailureKind =
  "spawn_failed" | "timeout" | "aborted" | "output_limit" | "nonzero_exit";

/** 一次进程执行的结果快照；失败时同样挂在 ProcessError 上（stdout/stderr 按上限保留） */
export interface ProcessResult {
  /** 正常/异常退出码；被信号终止时为 null */
  code: number | null;
  /** 终止信号名；无信号时为 null */
  signal: string | null;
  /** 按配置上限保留的 stdout；max_output_bytes=null 时完整聚合 */
  stdout: string;
  /** 按配置上限保留的 stderr；错误消息只引用其有界尾部 */
  stderr: string;
}

export interface RunProcessOptions {
  /** 子进程工作目录；调用方显式指定 */
  cwd: string;
  /** exact=只使用 values（可为空对象，不继承调用方环境）；inherit=明确继承调用方进程环境。无隐式默认合并 */
  env: { mode: "exact"; values: Record<string, string> } | { mode: "inherit" };
  /** 可选 stdin 文本；提供后写入并关闭，未提供则直接关闭 stdin */
  stdin?: string;
  /** wall-clock 超时（毫秒），必须为正数；到点 SIGTERM→宽限后 SIGKILL */
  timeout_ms: number;
  /** 外部取消（AbortController）；触发后按同一终止流程清理 */
  signal?: AbortSignal;
  /** SIGTERM 后的 SIGKILL 宽限（毫秒）；缺省 2000 */
  kill_grace_ms?: number;
  /** stdout/stderr 各自最大保留字节；正数超限即终止，缺省 1MiB；null=显式不限制（仅供既有 SDK 等兼容调用） */
  max_output_bytes?: number | null;
  /** 原始 stdout 数据块回调；JSONL/业务协议解析归调用方。回调异常被吞掉，不影响执行 */
  on_stdout?: (chunk: Buffer) => void;
  /** 原始 stderr 数据块回调；业务日志分类归调用方。回调异常被吞掉，不影响执行 */
  on_stderr?: (chunk: Buffer) => void;
}

/** 结构化进程失败：kind 供机器分类，message 为人类可读摘要（含 stderr 有界尾部），result 为终止时快照 */
export class ProcessError extends Error {
  readonly kind: ProcessFailureKind;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    kind: ProcessFailureKind,
    message: string,
    result: ProcessResult,
  ) {
    super(message);
    this.name = "ProcessError";
    this.kind = kind;
    this.code = result.code;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** 缺省 SIGTERM→SIGKILL 宽限（毫秒） */
const DEFAULT_KILL_GRACE_MS = 2000;
/** 缺省 stdout/stderr 各自保留上限（1MiB） */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** 失败消息里引用的 stderr 尾部长度 */
const STDERR_TAIL_CHARS = 2048;

/** 通用子进程执行：数组参数 + shell:false；POSIX 下独立进程组，终止时整组 SIGTERM→SIGKILL。
 *  成功（exit 0 且无信号）resolve ProcessResult；其余一律以 ProcessError 拒绝。
 *  调用方用 AbortController 管理在飞进程，无需持有 ChildProcess。 */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  if (!Number.isFinite(options.timeout_ms) || options.timeout_ms <= 0) {
    throw new Error("runProcess: timeout_ms 必须为正数");
  }
  const graceMs = options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS;
  const maxOutput =
    options.max_output_bytes === undefined
      ? DEFAULT_MAX_OUTPUT_BYTES
      : options.max_output_bytes;

  return new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    /** 首个终止原因（先到者赢）；null=未进入终止流程 */
    let killCause: "timeout" | "aborted" | "output_limit" | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env.mode === "exact" ? options.env.values : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX：独立进程组，终止时整组发信号，避免遗留命令的子进程
      detached: process.platform !== "win32",
    });

    const sendSignal = (sig: "SIGTERM" | "SIGKILL"): void => {
      if (child.pid === undefined) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // 进程组不存在（已退出）：退回单进程信号
        }
      }
      try {
        child.kill(sig);
      } catch {
        // 已退出，忽略
      }
    };

    const startKill = (cause: "timeout" | "aborted" | "output_limit"): void => {
      if (killCause !== null) return; // 首个原因优先
      killCause = cause;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => sendSignal("SIGKILL"), graceMs);
    };

    const timer = setTimeout(() => startKill("timeout"), options.timeout_ms);

    const onAbort = (): void => startKill("aborted");
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        startKill("aborted");
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        options.on_stdout?.(chunk);
      } catch {
        // 回调异常不影响执行
      }
      if (maxOutput === null) {
        stdout += chunk.toString("utf8");
        return;
      }
      if (stdoutBytes + chunk.length > maxOutput) {
        startKill("output_limit");
        return;
      }
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      try {
        options.on_stderr?.(chunk);
      } catch {
        // 回调异常不影响执行
      }
      if (maxOutput === null) {
        stderr += chunk.toString("utf8");
        return;
      }
      if (stderrBytes + chunk.length > maxOutput) {
        startKill("output_limit");
        return;
      }
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      // killCause 已存在 = 终止流程中的信号失败，交给 close 按既有原因分类
      if (killCause !== null) return;
      const result: ProcessResult = {
        code: null,
        signal: null,
        stdout,
        stderr,
      };
      settle(() =>
        reject(
          new ProcessError(
            "spawn_failed",
            `spawn_failed: ${command}: ${err.message}`,
            result,
          ),
        ),
      );
    });

    child.on("close", (code, signal) => {
      const result: ProcessResult = { code, signal, stdout, stderr };
      settle(() => {
        const tail = stderr.slice(-STDERR_TAIL_CHARS).trim();
        if (killCause === "timeout") {
          reject(
            new ProcessError(
              "timeout",
              `timeout: 超过 timeout_ms=${options.timeout_ms}，已终止`,
              result,
            ),
          );
        } else if (killCause === "aborted") {
          reject(
            new ProcessError("aborted", "aborted: 外部 signal 取消", result),
          );
        } else if (killCause === "output_limit") {
          reject(
            new ProcessError(
              "output_limit",
              `output_limit: stdout 或 stderr 超过 ${maxOutput} bytes`,
              result,
            ),
          );
        } else if (code === 0 && signal === null) {
          resolve(result);
        } else {
          reject(
            new ProcessError(
              "nonzero_exit",
              `nonzero_exit: code=${code} signal=${signal}${tail ? `: ${tail}` : ""}`,
              result,
            ),
          );
        }
      });
    });

    child.stdin.on("error", () => {
      // EPIPE：子进程早退，吞掉（退出码走 close 判定）
    });
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    }
  });
}
