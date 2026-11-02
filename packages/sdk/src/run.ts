import { ProcessError, runProcess } from "@asteriskzuo/agent-process-runner";
import type { StdoutResult } from "./result.js";

/** sdk.run 子程序执行的 SIGTERM→SIGKILL 宽限（ms） */
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
  // ok=true 允许缺 output 键：无参 sdk.return 时 JSON.stringify 丢弃 undefined 键，
  // 与 output: null 同义（空产出），解析时归一为 null（与 runner 侧同一判定）
  if (parsed.ok === true) {
    return {
      contract_version: "v1",
      ok: true,
      output: "output" in parsed ? parsed.output : null,
    };
  }
  if (parsed.ok === false && typeof parsed.reason === "string") {
    return { contract_version: "v1", ok: false, reason: parsed.reason };
  }
  return null;
}

/** 调子程序：经 process-runner 执行独立程序，同一子进程契约（stdin 一段 JSON、stdout 唯一结果、退出即结束）。
 *  对端 ok=false / 异常退出 / 超时 → 抛错（reason 进 message）；ok=true → 返回 output。
 *  不传 secrets（业务自觉，平台不替它扩散密钥） */
export async function runSubprogram(
  program: string,
  args: {
    input: unknown;
    config?: Record<string, string>;
    timeout_ms?: number;
  },
  workspace: string,
): Promise<unknown> {
  const timeoutMs = args.timeout_ms ?? 300_000;
  let firstResult: StdoutResult | null = null;
  let stdoutBuf = "";

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

  const envelope = {
    contract_version: "v1",
    input: args.input,
    config: args.config ?? {},
    workspace,
  };

  // firstResult 只在回调闭包内被赋值；经函数读取，避免 CFA 把它窄化成 null/never
  const readFirstResult = (): StdoutResult | null => firstResult;

  try {
    await runProcess(process.execPath, [program], {
      cwd: workspace,
      env: { mode: "inherit" },
      stdin: JSON.stringify(envelope),
      timeout_ms: timeoutMs,
      kill_grace_ms: KILL_GRACE_MS,
      max_output_bytes: null, // 兼容既有行为：聚合不设上限
      on_stdout: (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        scanLines(false);
      },
      // 子程序 stderr 不使用（它是独立 run，日志归它自己）；聚合上限与 stdout 同为 null
    });
    scanLines(true);
    const fr = readFirstResult();
    if (fr === null) {
      throw new Error("子程序未返回结果（missing result）");
    }
    if (fr.ok) return fr.output;
    throw new Error(`子程序返回失败：${fr.reason}`);
  } catch (e) {
    if (!(e instanceof ProcessError)) throw e;
    // 判定优先级与迁移前一致：已有结果 > 超时 > 退出码
    scanLines(true);
    const fr = readFirstResult();
    if (fr !== null) {
      if (fr.ok) return fr.output;
      throw new Error(`子程序返回失败：${fr.reason}`);
    }
    if (e.kind === "timeout") {
      throw new Error(`子程序超时（timeout_ms=${timeoutMs}）`);
    }
    if (e.kind === "spawn_failed") {
      throw new Error(`子程序 spawn 失败: ${e.message}`);
    }
    throw new Error(
      `子程序异常退出：exit code ${e.code}${e.signal ? ` signal ${e.signal}` : ""}`,
    );
  }
}
