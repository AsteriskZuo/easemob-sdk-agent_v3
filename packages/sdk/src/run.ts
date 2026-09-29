import { spawn } from "node:child_process";
import type { StdoutResult } from "./result.js";

/** sdk.run 子程序 spawn 的 SIGTERM→SIGKILL 宽限（ms） */
const KILL_GRACE_MS = 5000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 与 runner 侧同一判定：第一个合法 StdoutResult 才采信 */
function parseStdoutResult(line: string): StdoutResult | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.contract_version !== "v1") return null;
  if (parsed.ok === true && "output" in parsed) {
    return { contract_version: "v1", ok: true, output: parsed.output };
  }
  if (parsed.ok === false && typeof parsed.reason === "string") {
    return { contract_version: "v1", ok: false, reason: parsed.reason };
  }
  return null;
}

/** 调子程序：spawn 独立程序，同一子进程契约（stdin 一段 JSON、stdout 唯一结果、退出即结束）。
 *  对端 ok=false / 异常退出 / 超时 → 抛错（reason 进 message）；ok=true → 返回 output。
 *  不传 secrets（业务自觉，平台不替它扩散密钥） */
export function runSubprogram(
  program: string,
  args: {
    input: unknown;
    config?: Record<string, string>;
    timeout_ms?: number;
  },
  workspace: string,
): Promise<unknown> {
  const timeoutMs = args.timeout_ms ?? 300_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let firstResult: StdoutResult | null = null;
    let stdoutBuf = "";
    let timedOut = false;
    let killing = false;
    let killTimer: NodeJS.Timeout | null = null;

    const scanLines = (flush: boolean): void => {
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!firstResult) {
          const r = parseStdoutResult(line);
          if (r) firstResult = r;
        }
      }
      if (flush && stdoutBuf.trim().length > 0 && !firstResult) {
        const r = parseStdoutResult(stdoutBuf);
        if (r) firstResult = r;
        stdoutBuf = "";
      }
    };

    const killChild = (): void => {
      if (killing) return;
      killing = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      scanLines(false);
    });
    // 子程序 stderr 丢弃（它是独立 run，日志归它自己）；resume 防管道写满阻塞
    child.stderr.resume();

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`子程序 spawn 失败: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      scanLines(true);
      if (firstResult) {
        if (firstResult.ok) resolve(firstResult.output);
        else reject(new Error(`子程序返回失败：${firstResult.reason}`));
      } else if (timedOut) {
        reject(new Error(`子程序超时（timeout_ms=${timeoutMs}）`));
      } else if (code !== 0) {
        reject(
          new Error(
            `子程序异常退出：exit code ${code}${signal ? ` signal ${signal}` : ""}`,
          ),
        );
      } else {
        reject(new Error("子程序未返回结果（missing result）"));
      }
    });

    const envelope = {
      contract_version: "v1",
      input: args.input,
      config: args.config ?? {},
      workspace,
    };
    child.stdin.on("error", () => {
      // EPIPE：子程序早退，吞掉（退出码会走 close 判定）
    });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}
