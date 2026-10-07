import { spawn } from "node:child_process";
import { accessSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { newUlid, assertSafeSegment } from "@easemob/agent-contracts";
import type { EventEnvelope } from "@easemob/agent-contracts";
import { createFileLogger, logger } from "@easemob/agent-logger";
import type { ConsoleLike } from "@easemob/agent-logger";
import {
  classifyStderrLine,
  encodeStdinEnvelope,
  parseStdoutResult,
} from "./contract.js";
import type { StdinEnvelope, StdoutResult } from "./contract.js";

/** run 请求：装配根（T12）把 BusinessContext 拍平成它 */
export interface RunRequest {
  program: string; // 流程程序入口 JS 的绝对路径（上传时已转译）
  programs: Record<string, string>; // 程序名→物化绝对路径映射（装配根经 ContextLoader 产出）
  event: EventEnvelope; // 触发信封（取 source/session_id 用于目录与日志键）
  business_id: string;
  config: Record<string, string>; // 业务非机密配置（可空对象）
  secrets: Record<string, string>; // 业务安全变量（可空对象）
  endpoint: { socket_path: string; token: string }; // AgentService 开的 per-run 端点（T11）
  quota: { timeout_minutes: number }; // wall-clock 超时；agent 调用次数配额归 T11 服务端
  run_id?: string; // 可选：调用方指定 run_id（缺省内部生成 run_${ulid}）；workspace/日志路径按它派生。须匹配 run_ + 26 位 ulid，不符 → 抛错（平台自身错误）
}

/** run 结果。与 scheduler 的 ExecutionResult 的映射归装配根，本包不依赖 scheduler */
export interface RunOutcome {
  status: "success" | "failed" | "timeout";
  output: unknown; // 仅 success 有值（业务产出原样）
  reason?: string; // failed/timeout 的原因（日志用，末尾附 duration_ms 埋点）
}

/** 流程执行器：分钟级长调用 */
export interface WorkflowRunner {
  /** 执行一次 run：建目录 → spawn → 注入 → 收结果 → 打标。
   *  业务失败/异常/超时都返回 RunOutcome，不向调用方抛业务错误；
   *  只有平台自身错误（目录不可建、program 不存在、段非法）才抛错 */
  run(req: RunRequest): Promise<RunOutcome>;
}

export interface WorkflowRunnerOptions {
  workspaceRoot: string; // 平台工作目录（{workspace}，其下建 runs/ 与 logs/，布局见 console-design §6）
  maxOutputBytes?: number; // stdout 上限，默认 1_048_576（1MB），超限 = failed('output too large')
  killGraceMs?: number; // SIGTERM 后 SIGKILL 的宽限，默认 5000
  nodePath?: string; // 缺省 process.execPath
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MS = 5000;
// 调用方指定 run_id 的合法形：run_ + 26 位 Crockford base32 ulid（与 newUlid 产出同形）
const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

export function createWorkflowRunner(
  opts: WorkflowRunnerOptions,
): WorkflowRunner {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const nodePath = opts.nodePath ?? process.execPath;

  const run = async (req: RunRequest): Promise<RunOutcome> => {
    const startedAt = Date.now();

    // 段合法性先校验（防路径穿越）：任何目录创建之前抛错
    assertSafeSegment(req.event.source);
    assertSafeSegment(req.event.session_id);
    assertSafeSegment(req.business_id);

    // 平台自身错误（program 不存在/不可读）→ 抛错
    try {
      accessSync(req.program);
    } catch {
      throw new Error(`program 不存在或不可读: ${req.program}`);
    }

    const runId = req.run_id ?? `run_${newUlid()}`;
    // 调用方指定的 run_id 须为 ulid 形（防路径注入/目录串号）；非法 = 平台自身错误 → 抛错
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`invalid run_id: ${req.run_id}`);
    }
    // 数据分类布局（console-design §6）：run 工作区 = 业务执行产生的临时数据（runs/ 根，TTL 清理）；
    // 业务日志 = 日志类（logs/businesses/...，轮转可删）。三维键与 channel_id 对齐
    const channelKey = [
      req.event.source,
      req.event.session_id,
      req.business_id,
    ];
    const workspace = join(opts.workspaceRoot, "runs", ...channelKey, runId);
    const logPath = join(
      opts.workspaceRoot,
      "logs",
      "businesses",
      ...channelKey,
      `${runId}.log`,
    );
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(logPath, ".."), { recursive: true });

    // 全局外观脱敏登记：装配根已 initLogger 时生效；未初始化场景静默跳过
    try {
      logger.addSecrets(Object.values(req.secrets));
    } catch {
      // 未 initLogger（如测试/独立使用）：静默跳过，业务日志文件写口仍自带脱敏
    }

    // 业务日志文件写口：自带 secrets 脱敏；level=debug 保证各级别业务日志全采集
    const bizLog: ConsoleLike = createFileLogger(logPath, {
      level: "debug",
      secrets: Object.values(req.secrets),
    });

    const envelope: StdinEnvelope = {
      contract_version: "v1",
      input: req.event,
      workspace,
      config: req.config,
      secrets: req.secrets,
      endpoint: req.endpoint,
      programs: req.programs,
    };

    return new Promise<RunOutcome>((resolve, reject) => {
      // env 清空：平台环境变量不泄漏给业务进程，secrets 只走 stdin
      const child = spawn(nodePath, [req.program], {
        cwd: workspace,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBytes = 0;
      let stdoutBuf = "";
      let stderrBuf = "";
      let firstResult: StdoutResult | null = null;
      let outputExceeded = false;
      let timedOut = false;
      let killing = false;
      let killTimer: NodeJS.Timeout | null = null;

      const writeStderrLine = (line: string): void => {
        try {
          const classified = classifyStderrLine(line);
          if (classified.kind === "structured") {
            // ConsoleLike 只有 (...args) → message 单字段；fields 序列化进 message 尾部
            const text =
              classified.fields !== undefined
                ? `${classified.message} ${JSON.stringify(classified.fields)}`
                : classified.message;
            bizLog[classified.level](text);
          } else {
            bizLog.info(classified.text);
          }
        } catch {
          // 日志管道自身永不失败
        }
      };

      const scanStdoutLines = (flush: boolean): void => {
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
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      };

      // wall-clock 超时：到点 SIGTERM，grace 后 SIGKILL
      const timeoutMs = req.quota.timeout_minutes * 60_000;
      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        stdoutBuf += chunk.toString("utf8");
        scanStdoutLines(false);
        // 超限即杀即判，不等结果（防线三）
        if (stdoutBytes > maxOutputBytes && !outputExceeded) {
          outputExceeded = true;
          killChild();
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
        let idx: number;
        while ((idx = stderrBuf.indexOf("\n")) >= 0) {
          const line = stderrBuf.slice(0, idx);
          stderrBuf = stderrBuf.slice(idx + 1);
          writeStderrLine(line);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(new Error(`spawn 失败: ${req.program}: ${err.message}`));
      });

      // 进程收尾：await 退出后才返回（不留僵尸）；判定优先级见 spec §5.1（fail-closed）
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        scanStdoutLines(true);
        if (stderrBuf.trim().length > 0) writeStderrLine(stderrBuf);
        const durationMs = Date.now() - startedAt;
        if (outputExceeded) {
          resolve({
            status: "failed",
            output: undefined,
            reason: `output too large (> ${maxOutputBytes} bytes, duration_ms=${durationMs})`,
          });
        } else if (firstResult) {
          if (firstResult.ok) {
            resolve({ status: "success", output: firstResult.output });
          } else {
            resolve({
              status: "failed",
              output: undefined,
              reason: `${firstResult.reason} (duration_ms=${durationMs})`,
            });
          }
        } else if (timedOut) {
          resolve({
            status: "timeout",
            output: undefined,
            reason: `timeout after ${req.quota.timeout_minutes} minutes (duration_ms=${durationMs})`,
          });
        } else if (code !== 0) {
          resolve({
            status: "failed",
            output: undefined,
            reason: `exit code ${code}${signal ? ` signal ${signal}` : ""} (duration_ms=${durationMs})`,
          });
        } else {
          resolve({
            status: "failed",
            output: undefined,
            reason: `missing result (duration_ms=${durationMs})`,
          });
        }
      });

      child.stdin.on("error", () => {
        // EPIPE：子进程早退，吞掉（退出码走 close 判定）
      });
      child.stdin.write(encodeStdinEnvelope(envelope));
      child.stdin.end();
    });
  };

  return { run };
}
