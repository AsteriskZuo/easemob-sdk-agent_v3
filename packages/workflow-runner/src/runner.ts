import {
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { newUlid, assertSafeSegment } from "@asteriskzuo/agent-contracts";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { createFileSink, logger } from "@asteriskzuo/agent-logger";
import { ProcessError, runProcess } from "@asteriskzuo/agent-process-runner";
import {
  classifyStderrLine,
  encodeStdinEnvelope,
  parseStdoutResult,
} from "./contract.js";
import type { StdinEnvelope, StdoutResult } from "./contract.js";

/** run 请求：装配根（T12）把 BusinessContext 拍平成它 */
export interface RunRequest {
  program: string; // 流程程序入口 JS 的绝对路径（物化构建产物，由装配根经 ContextLoader 产出）
  programs: Record<string, string>; // 程序名→物化绝对路径映射（装配根经 ContextLoader 产出）
  event: EventEnvelope; // 触发信封（取 source/session_id 用于目录与日志键）
  business_id: string;
  config: Record<string, string>; // 业务非机密配置（可空对象）
  secrets: Record<string, string>; // 业务安全变量（可空对象）
  endpoint: { socket_path: string; token: string }; // AgentService 开的 per-run 端点（T11）
  quota: { timeout_minutes: number }; // wall-clock 超时；agent 调用次数配额归 T11 服务端
  run_id?: string; // 可选：调用方指定 run_id（缺省内部生成 run_${ulid}）；workspace/日志路径按它派生。须匹配 run_ + 26 位 ulid，不符 → 抛错（平台自身错误）
}

/** 失败阶段分类（契约设计 §5 三段编排）：成功无此字段；结构化分类由此承担，报错文字前缀不再承担分类职责 */
export type FailedAt = "check-input" | "main" | "check-output";

/** run 结果。与 scheduler 的 ExecutionResult 的映射归装配根，本包不依赖 scheduler */
export interface RunOutcome {
  status: "success" | "failed" | "timeout";
  output: unknown; // 仅 success 有值（业务产出原样；空产出归一为 null）
  reason?: string; // failed/timeout 的原因（日志用，末尾附 duration_ms 埋点）
  failed_at?: FailedAt; // status 非 success 时的失败阶段（check 阶段失败恒 failed；timeout 状态只可能 failed_at="main"）
}

/** 流程执行器：分钟级长调用 */
export interface WorkflowRunner {
  /** 执行一次 run：建目录 → 三段编排（check-input → main → check-output）→ 收结果 → 打标。
   *  业务失败/异常/超时都返回 RunOutcome，不向调用方抛业务错误；
   *  只有平台自身错误（目录不可建、program 不存在、段非法、main spawn 失败）才抛错 */
  run(req: RunRequest): Promise<RunOutcome>;
}

export interface WorkflowRunnerOptions {
  workspaceRoot: string; // 平台工作目录（{workspace}，业务三类建在 businesses/{business_id}/ 下，布局见 console-design §6）
  maxOutputBytes?: number; // stdout 上限，默认 1_048_576（1MB），超限 = failed('output too large')
  killGraceMs?: number; // SIGTERM 后 SIGKILL 的宽限，默认 5000
  nodePath?: string; // 缺省 process.execPath
  checkTimeoutMs?: number; // check 阶段超时，默认 60_000（契约设计 §5 平台常量，v1 不开放业务配置）；仅测试注入小值
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
// 调用方指定 run_id 的合法形：run_ + 26 位 Crockford base32 ulid（与 newUlid 产出同形）
const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
// contract.json 定位：从 check 程序所在目录向上找近端祖先目录（模板布局 dist/apps/<name>/index.js 上 3 级 = 资产根），最多上探 5 级
const CONTRACT_WALK_UP_MAX = 5;

/** 编排阶段名（日志与 failed_at 用） */
type PhaseName = FailedAt;

/** contract.json 运行期探测结果（契约设计 §5 运行期跳过判定） */
type ContractProbe =
  | { kind: "ok"; inputIsNull: boolean } // 找到且形状可读（runner 只消费 input 的空声明；output: null 时 check-output 仍执行）
  | { kind: "no-programs" } // programs 无 check-input/check-output：旧结构资产
  | { kind: "no-contract" } // 有 check 程序但近端祖先目录找不到 contract.json
  | { kind: "invalid"; detail: string }; // contract.json 存在但读取/解析/形状失败

/** 三段编排计划：undefined = 该阶段跳过 */
interface CheckPhasePlan {
  checkInput?: string;
  checkOutput?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 超时的可读时长标签：整秒用 s（60s），零头用 ms（200ms，测试注入） */
function formatMsLabel(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** contract.json 定位：自 startDir 向上逐层找（含 startDir 自身），上探上限 CONTRACT_WALK_UP_MAX 级 */
function locateContractFile(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth <= CONTRACT_WALK_UP_MAX; depth++) {
    const candidate = join(dir, "contract.json");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在：继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 读 contract.json 并提取 runner 需要的空声明信息；解析/形状失败 = invalid（按旧资产跳过，记 warn） */
function probeContractFile(file: string): ContractProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      kind: "invalid",
      detail: `读取/解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPlainObject(parsed) || !("input" in parsed) || !("output" in parsed)) {
    return {
      kind: "invalid",
      detail:
        "形状非法：顶层必须是含 input/output 节的对象（null 或 { fields: [...] }）",
    };
  }
  return { kind: "ok", inputIsNull: parsed.input === null };
}

/** 落盘展示层转换：fields 的字符串值能 JSON.parse 成**对象/数组** → 嵌套为 JSON
 *  （人读日志免转义汤，一层转义封顶）；数字/布尔/null 可 parse 但不转
 *  （"12345" 这类 id 字符串保真）；parse 失败保持原字符串 */
function nestJsonStrings(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      out[key] = parsed !== null && typeof parsed === "object" ? parsed : value;
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function createWorkflowRunner(
  opts: WorkflowRunnerOptions,
): WorkflowRunner {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const nodePath = opts.nodePath ?? process.execPath;
  const checkTimeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  const run = async (req: RunRequest): Promise<RunOutcome> => {
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
    // 数据分类布局（console-design §6，五类×两归属）：业务归属的三类（runs 临时 / logs 日志 /
    // data 持久状态）统一收拢在 businesses/{business_id}/ 下——删业务 = db 删行 + 删该目录；
    // 业务根内保留 {source, session_id} 两级键，同通道串行 ⇒ 同目录无并发写
    const businessRoot = join(
      opts.workspaceRoot,
      "businesses",
      req.business_id,
    );
    const channelKey = [req.event.source, req.event.session_id];
    // run 工作区 = 业务执行产生的临时数据（runs/，TTL 清理）
    const workspace = join(businessRoot, "runs", ...channelKey, runId);
    // 业务日志 = 日志类（轮转可删）
    const logPath = join(businessRoot, "logs", ...channelKey, `${runId}.log`);
    // 业务级持久目录（区别于 runs/ 临时、logs/ 可删）：业务读写状态文件无需自锁；平台不做 TTL
    const dataDir = join(businessRoot, "data", ...channelKey);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(logPath, ".."), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // 全局外观脱敏登记：装配根已 initLogger 时生效；未初始化场景静默跳过
    try {
      logger.addSecrets(Object.values(req.secrets));
    } catch {
      // 未 initLogger（如测试/独立使用）：静默跳过，业务日志文件写口仍自带脱敏
    }

    // 业务日志文件写口：结构化 record 直写（fields 独立成字段，不打平进 message——
    // 打平后人机双输：人看三层转义，机器 jq 取不到）；自带 secrets 脱敏；
    // level=debug 保证各级别业务日志全采集
    const bizSink = createFileSink(logPath, {
      level: "debug",
      enabled: true,
      secrets: Object.values(req.secrets),
    });

    const debugSecrets = Object.fromEntries(
      Object.keys(req.secrets).map((key) => [key, "***"]),
    );
    const debugEndpoint = {
      socket_path: req.endpoint.socket_path,
      token: "***",
    };

    // 临时调试：平台实际交给 Runner 的请求，敏感值只保留键名
    bizSink("info", {
      message: "临时调试：平台实际调用 Runner 的 RunRequest",
      fields: {
        ...req,
        secrets: debugSecrets,
        endpoint: debugEndpoint,
      },
    });

    const envelope: StdinEnvelope = {
      contract_version: "v1",
      input: req.event,
      workspace,
      config: req.config,
      secrets: req.secrets,
      endpoint: req.endpoint,
      programs: req.programs,
      dataDir,
    };

    /** 单阶段执行器：三阶段共用（stdout 扫描 / stderr 落业务日志 / fail-closed 判定优先级）。
     *  每阶段独立缓冲；check 阶段 spawn 失败按该阶段失败返回（设计 §5：check 阶段失败 = run 失败），
     *  main 阶段 spawn 失败保持平台自身错误语义（抛错） */
    const runPhase = async (phaseOpts: {
      phase: PhaseName;
      program: string;
      envelope: StdinEnvelope;
      timeoutMs: number;
      timeoutLabel: string; // 超时原因里的可读时长（main = "5 minutes"；check = "60s"）
    }): Promise<RunOutcome> => {
      const phaseStart = Date.now();
      let stdoutBuf = "";
      let stderrBuf = "";
      let firstResult: StdoutResult | null = null;

      const writeStderrLine = (line: string): void => {
        try {
          const classified = classifyStderrLine(line);
          if (classified.kind === "structured") {
            bizSink(
              classified.level,
              classified.fields !== undefined
                ? {
                    message: classified.message,
                    fields: nestJsonStrings(classified.fields),
                  }
                : { message: classified.message },
            );
          } else {
            bizSink("info", { message: classified.text });
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

      const flushStderrTail = (): void => {
        if (stderrBuf.trim().length > 0) writeStderrLine(stderrBuf);
      };

      // firstResult 只在回调闭包内被赋值；经函数读取，避免 CFA 把它窄化成 null/never
      const readFirstResult = (): StdoutResult | null => firstResult;

      const outcomeFromFirst = (durationMs: number): RunOutcome => {
        const fr = readFirstResult();
        if (fr !== null) {
          if (fr.ok) return { status: "success", output: fr.output };
          return {
            status: "failed",
            output: undefined,
            reason: `${fr.reason} (duration_ms=${durationMs})`,
          };
        }
        return {
          status: "failed",
          output: undefined,
          reason: `missing result (duration_ms=${durationMs})`,
        };
      };

      // env 清空（exact 空表）：平台环境变量不泄漏给业务进程，secrets 只走 stdin
      try {
        await runProcess(nodePath, [phaseOpts.program], {
          cwd: workspace,
          env: { mode: "exact", values: {} },
          stdin: encodeStdinEnvelope(phaseOpts.envelope),
          timeout_ms: phaseOpts.timeoutMs,
          kill_grace_ms: killGraceMs,
          max_output_bytes: maxOutputBytes,
          on_stdout: (chunk) => {
            stdoutBuf += chunk.toString("utf8");
            scanStdoutLines(false);
          },
          on_stderr: (chunk) => {
            stderrBuf += chunk.toString("utf8");
            let idx: number;
            while ((idx = stderrBuf.indexOf("\n")) >= 0) {
              const line = stderrBuf.slice(0, idx);
              stderrBuf = stderrBuf.slice(idx + 1);
              writeStderrLine(line);
            }
          },
        });
        // exit 0：收尾 flush 后按结果判定
        scanStdoutLines(true);
        flushStderrTail();
        return outcomeFromFirst(Date.now() - phaseStart);
      } catch (e) {
        scanStdoutLines(true);
        flushStderrTail();
        const durationMs = Date.now() - phaseStart;
        if (!(e instanceof ProcessError)) throw e;
        // main spawn 失败 = 平台自身错误 → 抛错（保持 "spawn 失败:" 前缀）；
        // check 阶段 spawn 失败 = 该阶段失败（设计 §5：check 阶段失败 = run 失败，不升级为平台错误）
        if (e.kind === "spawn_failed") {
          if (phaseOpts.phase === "main") {
            throw new Error(`spawn 失败: ${phaseOpts.program}: ${e.message}`);
          }
          return {
            status: "failed",
            output: undefined,
            reason: `spawn 失败: ${phaseOpts.program}: ${e.message} (duration_ms=${durationMs})`,
          };
        }
        // 判定优先级与迁移前一致（fail-closed）：output_limit > 已有结果 > timeout > 退出码
        if (e.kind === "output_limit") {
          return {
            status: "failed",
            output: undefined,
            reason: `output too large (> ${maxOutputBytes} bytes, duration_ms=${durationMs})`,
          };
        }
        if (readFirstResult() !== null) {
          return outcomeFromFirst(durationMs);
        }
        if (e.kind === "timeout") {
          // check 阶段超时 = run 失败（failed_at 分类）；main 超时保持 timeout 状态语义
          if (phaseOpts.phase === "main") {
            return {
              status: "timeout",
              output: undefined,
              reason: `timeout after ${phaseOpts.timeoutLabel} (duration_ms=${durationMs})`,
            };
          }
          return {
            status: "failed",
            output: undefined,
            reason: `timeout after ${phaseOpts.timeoutLabel} (duration_ms=${durationMs})`,
          };
        }
        return {
          status: "failed",
          output: undefined,
          reason: `exit code ${e.code}${e.signal ? ` signal ${e.signal}` : ""} (duration_ms=${durationMs})`,
        };
      }
    };

    // 契约探测与三段编排计划（契约设计 §5）：保留名自查 + contract.json 近端祖先定位；
    // 旧结构资产（无 check 程序 / 无契约 / 契约不可读）跳过 check 阶段，行为与旧版一致（软迁移）
    const checkInputProgram = req.programs["check-input"];
    const checkOutputProgram = req.programs["check-output"];

    const probe = ((): ContractProbe => {
      const anchor = checkInputProgram ?? checkOutputProgram;
      if (anchor === undefined) return { kind: "no-programs" };
      if (!existsSync(anchor)) {
        // 保留名在映射里但产物缺失：物化闸本应拦住，运行期按契约不可读处理（fail-open 保旧资产语义一致）
        return {
          kind: "invalid",
          detail: `check 程序产物不存在：${anchor}`,
        };
      }
      const file = locateContractFile(dirname(anchor));
      if (file === null) return { kind: "no-contract" };
      return probeContractFile(file);
    })();

    const plan: CheckPhasePlan = (() => {
      switch (probe.kind) {
        case "ok": {
          const next: CheckPhasePlan = {};
          if (probe.inputIsNull) {
            if (checkInputProgram !== undefined) {
              bizSink("info", {
                message:
                  "契约声明无输入约束（input: null），跳过 check-input 阶段",
              });
            }
          } else if (checkInputProgram !== undefined) {
            next.checkInput = checkInputProgram;
          } else {
            bizSink("warn", {
              message:
                "契约声明了输入约束但 programs 缺 check-input 程序，跳过入口检查阶段",
            });
          }
          if (checkOutputProgram !== undefined) {
            next.checkOutput = checkOutputProgram;
          } else {
            bizSink("warn", {
              message: "programs 缺 check-output 程序，跳过出口校验阶段",
            });
          }
          return next;
        }
        case "no-programs":
          bizSink("info", {
            message:
              "旧结构资产（programs 无 check-input/check-output），跳过契约校验阶段",
          });
          return {};
        case "no-contract":
          bizSink("warn", {
            message:
              "存在 check 程序但未找到 contract.json（check 程序近端祖先目录），按旧结构资产跳过契约校验阶段",
          });
          return {};
        case "invalid":
          bizSink("warn", {
            message: `contract.json ${probe.detail}，按旧结构资产跳过契约校验阶段`,
          });
          return {};
      }
    })();

    // 阶段 1：入口检查（最小注入：无 secrets/endpoint/programs/dataDir——纯校验纪律的结构落实）
    if (plan.checkInput !== undefined) {
      const outcome = await runPhase({
        phase: "check-input",
        program: plan.checkInput,
        envelope: {
          contract_version: "v1",
          input: req.event,
          workspace,
          config: req.config,
        },
        timeoutMs: checkTimeoutMs,
        timeoutLabel: formatMsLabel(checkTimeoutMs),
      });
      if (outcome.status !== "success") {
        return { ...outcome, failed_at: "check-input" };
      }
      bizSink("info", { message: "check-input 阶段通过" });
    }

    // 阶段 2：主流程（全量注入，现状语义不变）
    const mainOutcome = await runPhase({
      phase: "main",
      program: req.program,
      envelope,
      timeoutMs: req.quota.timeout_minutes * 60_000,
      timeoutLabel: `${req.quota.timeout_minutes} minutes`,
    });
    if (mainOutcome.status !== "success") {
      return { ...mainOutcome, failed_at: "main" };
    }

    // 阶段 3：出口校验（最小注入 + 主程序产出；契约 output: null 时仍执行——校验产出确为空）
    if (plan.checkOutput !== undefined) {
      const outcome = await runPhase({
        phase: "check-output",
        program: plan.checkOutput,
        envelope: {
          contract_version: "v1",
          input: req.event,
          workspace,
          config: req.config,
          output: mainOutcome.output,
        },
        timeoutMs: checkTimeoutMs,
        timeoutLabel: formatMsLabel(checkTimeoutMs),
      });
      if (outcome.status !== "success") {
        return { ...outcome, failed_at: "check-output" };
      }
      bizSink("info", { message: "check-output 阶段通过" });
    }

    return mainOutcome;
  };

  return { run };
}
