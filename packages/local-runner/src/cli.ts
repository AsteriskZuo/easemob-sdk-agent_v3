#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import { newUlid } from "@asteriskzuo/agent-contracts";
import { initLogger } from "@asteriskzuo/agent-logger";
import { executeRun } from "@asteriskzuo/agent-run-core";
import type { RunContext } from "@asteriskzuo/agent-run-core";
import { createAgentService } from "@asteriskzuo/agent-service";
import type { AgentSessionMapping } from "@asteriskzuo/agent-service";
import { createWorkflowRunner } from "@asteriskzuo/agent-workflow-runner";
import { loadConfig } from "./config.js";
import type { LocalRunConfig } from "./config.js";
import { exportEventFromDb, loadReplayEvent } from "./replay.js";
import { applyStubTools, assembleRunContext } from "./local-context-loader.js";
import { diffContexts } from "./context-diff.js";
import type { FieldDiff } from "./context-diff.js";

/**
 * agent-local 本地 CLI（spec §8）：三个子命令。
 *   run           装配（含 stub 护栏）→ 目录派生 → executeRun → 终端输出 RunOutcome 与日志路径
 *   diff          本地上下文（stub 应用前）与平台上下文快照做内容等值 diff
 *   export-event  从平台数据库 platform.db 只读导出事件信封
 *
 * 结构纪律：主入口薄，全部逻辑在可注入 deps 的 runLocal 里（测试注入假 executeRun / 捕获输出）；
 * argv 解析只用 node:util parseArgs，不引第三方依赖。
 *
 * 退出码约定（spec §7.3 / §8）：
 *   0 = 成功（run 成功 / diff 全等 / export-event 成功）
 *   1 = 业务语义失败（run 返回 failed/timeout；diff 有差异）
 *   2 = 输入非法或装配/执行抛错（参数缺失、配置/事件/快照非法、executeRun 抛错等）
 */

const USAGE = [
  "用法:",
  "  agent-local run --config <path> --event <回放事件.json>",
  "  agent-local diff --config <path> --snapshot <平台快照.json> [--all]",
  "  agent-local export-event --db <platform.db> --event-id <id> --out <file>",
].join("\n");

/** 终端输出写口（缺省 process.stdout/stderr，测试注入捕获）。 */
interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * runLocal 可注入依赖（测试用）。
 * executeRun 注入假实现即可覆盖 run 子命令的退出码映射（success/failed/timeout/抛错四态），
 * 其余依赖（AgentService / WorkflowRunner 构造）无运行期副作用，测试照常走真实构造。
 */
export interface LocalCliDeps {
  /** 执行核；缺省 = @asteriskzuo/agent-run-core 的 executeRun */
  executeRun?: typeof executeRun;
  /** stdout 写口；缺省 process.stdout.write */
  stdout?: (text: string) => void;
  /** stderr 写口；缺省 process.stderr.write */
  stderr?: (text: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** 顶层错误展示：只打消息（配置/参数等输入错误的堆栈对用户无意义）。 */
function errorMessageOnly(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type CliOptionValues = Record<string, string | boolean | undefined>;

/** parseArgs 统一包装：任何解析失败（未知选项、缺值、位置参数）转「参数非法 + 用法」错误（exit 2）。 */
function parseOptions(
  args: string[],
  options: ParseArgsOptionsConfig,
): CliOptionValues {
  try {
    const { values } = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: false,
    });
    return values as CliOptionValues;
  } catch (error) {
    throw new Error(`参数非法：${errorMessage(error)}\n${USAGE}`);
  }
}

/** 取必填字符串选项；缺失或为空 = 参数错误（附用法）。 */
function requireOption(values: CliOptionValues, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`缺少必填参数 --${name}\n${USAGE}`);
  }
  return value;
}

/** pi 内核包名（CLI flag 与 JSONL 事件格式以该锁定版本为准） */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** 从 node_modules 依赖解析 pi 可执行文件绝对路径（读包 manifest 的 bin 字段）。
 *  复制自 app/server/src/config.ts 的 resolvePiCliPathFromDeps（2026-11-09 行 70-90），
 *  保持与平台缺省行为一致；local-runner 包边界不允许依赖 app/server，故复制为本文件私有函数。
 *  手动逐层上溯 node_modules：该包 exports map 不含 require/default 条件（createRequire 解析不到），
 *  且 import.meta.resolve 在 jest vm 环境不可用。
 *  包未安装 / 结构不符 / bin 缺失 → undefined（调用方报错 exit 2） */
function resolvePiCliPathFromDeps(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const root = path.join(dir, "node_modules", PI_PACKAGE);
    const manifest = path.join(root, "package.json");
    if (existsSync(manifest)) {
      let pkg: { name?: string; bin?: string | Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(manifest, "utf8")) as typeof pkg;
      } catch {
        return undefined;
      }
      if (pkg.name !== PI_PACKAGE) return undefined;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      const abs = bin === undefined ? undefined : path.join(root, bin);
      return abs !== undefined && existsSync(abs) ? abs : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * pi 子进程环境（createAgentService 的 pi_env 参数）。
 * 对齐平台「固定组 { PATH, HOME }」语义（app/server/src/config.ts 的 pi_env 解析），
 * 本地在固定组之上叠加配置文件 pi_env 覆盖（同键名时本地配置优先）。
 */
function buildPiEnv(config: LocalRunConfig): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...config.pi_env,
  };
}

/**
 * 日志全局外观的一次性初始化守卫（模块级）。
 * CLI 正常形态是单进程跑一次 run，initLogger 只会被触达一次；守卫存在的原因是
 * 同一进程内重复调 runLocal 的场景（jest 测试、编程式复用）——initLogger 重复调用会抛
 * 「只能调用一次」。选模块级守卫而非 try/catch 按消息吞错：后者把契约校验（消息文本）
 * 当控制流用，脆弱且会掩盖 logsDir 不可写等真实初始化失败。
 * 仅 run 子命令需要（executeRun → agent-service serve 用 logger 外观）；
 * diff / export-event 路径上的模块（config/replay/diff/loader）均不触碰 logger，无需初始化。
 */
let loggerInitialized = false;

/**
 * 初始化日志全局外观（对应平台装配根 app/server/src/bootstrap.ts 的 initLogger 调用）。
 * 必须在 createAgentService 之前调用（serve 内 logger.for 未初始化即抛错）。
 * secrets 登记脱敏值对齐平台 runner 的做法（packages/workflow-runner/src/runner.ts 的
 * logger.addSecrets），本地装配根在初始化时一次性登记。
 * initLogger 自带 logsDir 可建/可写 fail-fast；失败上抛由 runLocal 映射为 exit 2。
 */
function ensureLogger(config: LocalRunConfig): void {
  if (loggerInitialized) return;
  initLogger({
    logsDir: path.join(config.workspace_root, "logs", "local-runner"),
    level: "info",
    enabled: true,
    secrets: Object.values(config.secrets),
  });
  loggerInitialized = true;
}

/**
 * JSON 文件持久化的 AgentSessionMapping（本地运行用，对应平台 ChannelStore 的数据库实现；
 * 接口契约见 packages/agent-service/src/index.ts:48-56）。
 * 落盘 {config.workspace_root}/agent-session-mapping.json，形状 { [channel_id]: piSessionId }。
 * 读：文件不存在 = 空映射；JSON 损坏原样抛错（损坏应暴露，不做静默丢会话）。
 * 写：整体重写（本地单 run 串行，无并发写问题），写失败原样上抛。
 */
function createJsonFileSessionMapping(filePath: string): AgentSessionMapping {
  const read = (): Record<string, string> => {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
  };
  const write = (map: Record<string, string>): void => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(map, null, 2));
  };
  return {
    bindAgentSession(channelId, agentSessionId) {
      const map = read();
      map[channelId] = agentSessionId;
      write(map);
    },
    getAgentSession(channelId) {
      return read()[channelId];
    },
    clear(channelId) {
      const map = read();
      delete map[channelId];
      write(map);
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验快照 JSON 的 RunContext 形状（fail-fast，非法 → 输入非法 exit 2）。 */
function assertRunContextShape(raw: unknown, where: string): RunContext {
  const fail = (reason: string): Error =>
    new Error(`快照文件 ${where} 不是合法 RunContext：${reason}`);
  if (!isPlainObject(raw)) {
    throw fail("顶层必须是 JSON 对象");
  }
  for (const key of [
    "business_id",
    "channel_id",
    "program",
    "prompt",
    "model",
  ]) {
    if (typeof raw[key] !== "string") {
      throw fail(`字段 "${key}" 必须为字符串`);
    }
  }
  for (const key of ["programs", "vars", "secrets"]) {
    const value = raw[key];
    if (
      !isPlainObject(value) ||
      Object.values(value).some((v) => typeof v !== "string")
    ) {
      throw fail(`字段 "${key}" 必须为「字符串 → 字符串」的对象`);
    }
  }
  if (
    !Array.isArray(raw.skills) ||
    (raw.skills as unknown[]).some(
      (s: unknown) =>
        !isPlainObject(s) ||
        typeof s.name !== "string" ||
        typeof s.path !== "string",
    )
  ) {
    throw fail('字段 "skills" 必须为 { name, path } 数组');
  }
  if (
    !isPlainObject(raw.quota) ||
    typeof raw.quota.timeout_minutes !== "number" ||
    typeof raw.quota.max_agent_calls !== "number"
  ) {
    throw fail(
      '字段 "quota" 必须为 { timeout_minutes: number, max_agent_calls: number }',
    );
  }
  if (raw.pi_agent_dir !== undefined && typeof raw.pi_agent_dir !== "string") {
    throw fail('字段 "pi_agent_dir" 存在时必须为字符串');
  }
  return raw as unknown as RunContext;
}

/** 读平台上下文快照（Lifecycle 调试钩子落盘的 RunContext JSON），含形状校验。 */
function readSnapshot(snapshotPath: string): RunContext {
  const abs = path.resolve(snapshotPath);
  if (!existsSync(abs)) {
    throw new Error(`快照文件不存在：${abs}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    throw new Error(
      `快照文件不是合法 JSON：${abs}（${(error as Error).message}）`,
    );
  }
  return assertRunContextShape(raw, abs);
}

/** diff 报告行格式（spec §7.3）：`kind  field  platform=…  local=…`；缺省侧打 "-"。 */
function formatFieldDiff(field: FieldDiff): string {
  return `${field.kind}  ${field.field}  platform=${field.platform ?? "-"}  local=${field.local ?? "-"}`;
}

/** export-event 子命令：从平台数据库只读导出事件信封；成功 0，错误（db/事件不存在等）2。 */
function cmdExportEvent(args: string[], io: CliIo): number {
  const values = parseOptions(args, {
    db: { type: "string" },
    "event-id": { type: "string" },
    out: { type: "string" },
  });
  const db = requireOption(values, "db");
  const eventId = requireOption(values, "event-id");
  const out = requireOption(values, "out");
  exportEventFromDb(db, eventId, out);
  io.stdout(`已导出事件 ${eventId} → ${path.resolve(out)}\n`);
  return 0;
}

/**
 * diff 子命令（spec §7）：本地上下文取 assembleRunContext 的 stub 应用前结果（等值上下文），
 * 与平台快照做内容 digest 比较。默认只打印非 equal 字段，--all 打全部。
 * 退出码：全等 0 / 有差异 1 / 输入非法（配置或快照）2。
 */
function cmdDiff(args: string[], io: CliIo): number {
  const values = parseOptions(args, {
    config: { type: "string" },
    snapshot: { type: "string" },
    all: { type: "boolean" },
  });
  const configPath = requireOption(values, "config");
  const snapshotPath = requireOption(values, "snapshot");
  const config = loadConfig(configPath);
  const snapshot = readSnapshot(snapshotPath);
  const local = assembleRunContext(config);
  const report = diffContexts(snapshot, local);

  const shown =
    values.all === true
      ? report.fields
      : report.fields.filter((f) => f.kind !== "equal");
  for (const field of shown) {
    io.stdout(`${formatFieldDiff(field)}\n`);
  }
  if (report.equal) {
    io.stdout("diff 结果：全部字段相等\n");
    return 0;
  }
  const diffCount = report.fields.filter((f) => f.kind !== "equal").length;
  io.stdout(
    `diff 结果：${diffCount} 个字段有差异（--all 可查看含相等字段的全部报告）\n`,
  );
  return 1;
}

/**
 * run 子命令（spec §8）：装配（含 stub 护栏）→ run_id → 目录派生与创建 →
 * 构造 AgentService / WorkflowRunner → executeRun → 终端输出 RunOutcome 与日志路径。
 * 退出码：success 0 / failed·timeout 1 / 装配或执行抛错 2。
 */
async function cmdRun(
  args: string[],
  io: CliIo,
  execRun: typeof executeRun,
): Promise<number> {
  const values = parseOptions(args, {
    config: { type: "string" },
    event: { type: "string" },
  });
  const configPath = requireOption(values, "config");
  const eventPath = requireOption(values, "event");
  const config = loadConfig(configPath);
  const event = loadReplayEvent(eventPath);
  // stub 护栏在装配完成之后、生成执行请求之前应用（spec §6.2）
  const context = applyStubTools(assembleRunContext(config), config);

  const run_id = `run_${newUlid()}`;

  // 目录派生严格对齐平台 packages/runtime/src/lifecycle.ts:63-72，只替换根目录为 config.workspace_root
  const businessRoot = path.join(
    config.workspace_root,
    "businesses",
    config.business_id,
  );
  const workspace = path.join(
    businessRoot,
    "runs",
    event.source,
    event.session_id,
    run_id,
  );
  const session_dir = path.join(
    businessRoot,
    "cache",
    "agent-sessions",
    event.source,
    event.session_id,
  );
  const audit_log_path = path.join(workspace, "audit", "llm-requests.jsonl");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(session_dir, { recursive: true });
  mkdirSync(path.dirname(audit_log_path), { recursive: true });

  // AgentService 构造参数（对应 app/server 装配根）：pi_cli_path 缺省解析 npm 依赖 bin；
  // pi_env 固定组 {PATH, HOME} + 本地覆盖；mapping 用 JSON 文件持久化实现
  const piCliPath = config.pi_cli_path ?? resolvePiCliPathFromDeps();
  if (piCliPath === undefined) {
    throw new Error(
      "pi 可执行文件不可用：配置文件未指定 pi_cli_path，且 npm 依赖 " +
        `${PI_PACKAGE} 未安装或 bin 缺失（先 yarn install，或在配置文件指定 pi_cli_path）`,
    );
  }
  // 日志全局外观必须先于 createAgentService 初始化（serve 内 logger.for 未初始化即抛错）
  ensureLogger(config);
  const agentService = createAgentService({
    pi_cli_path: piCliPath,
    pi_env: buildPiEnv(config),
    mapping: createJsonFileSessionMapping(
      path.join(config.workspace_root, "agent-session-mapping.json"),
    ),
  });
  const runner = createWorkflowRunner({ workspaceRoot: config.workspace_root });

  const outcome = await execRun(
    { context, event, run_id, workspace, session_dir, audit_log_path },
    { agentService, runner },
    {
      onServeError: (error) => {
        io.stderr(`[run] agent 服务启动失败：${errorMessage(error)}\n`);
      },
      onRunnerError: (error) => {
        io.stderr(`[run] runner 平台错误：${errorMessage(error)}\n`);
      },
    },
  );

  // 业务日志路径与 WorkflowRunner 内部派生规则同构（runner.ts 的 logs/{source}/{session_id}/{run_id}.log）
  const logPath = path.join(
    businessRoot,
    "logs",
    event.source,
    event.session_id,
    `${run_id}.log`,
  );
  io.stdout(`run_id: ${run_id}\n`);
  io.stdout(`RunOutcome:\n${JSON.stringify(outcome, null, 2)}\n`);
  io.stdout(`业务日志: ${logPath}\n`);
  io.stdout(`审计日志: ${audit_log_path}\n`);
  return outcome.status === "success" ? 0 : 1;
}

/**
 * CLI 主流程（导出供测试注入 deps；正常入口是文件末尾的 main 守卫）。
 *
 * @param argv 子命令及参数（即 process.argv.slice(2)）。
 * @param deps 可注入依赖（假 executeRun / 输出捕获）。
 * @returns 退出码（0/1/2，见文件头约定）；本函数不调用 process.exit，由调用方决定。
 */
export async function runLocal(
  argv: string[],
  deps: LocalCliDeps = {},
): Promise<number> {
  const io: CliIo = {
    stdout: deps.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps.stderr ?? ((text) => process.stderr.write(text)),
  };
  const execRun = deps.executeRun ?? executeRun;
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case "export-event":
        return cmdExportEvent(rest, io);
      case "diff":
        return cmdDiff(rest, io);
      case "run":
        return await cmdRun(rest, io, execRun);
      case undefined:
        throw new Error(`缺少子命令\n${USAGE}`);
      default:
        throw new Error(`未知子命令：${command}\n${USAGE}`);
    }
  } catch (error) {
    io.stderr(`${errorMessageOnly(error)}\n`);
    return 2;
  }
}

// main 守卫：仅作为独立进程入口时执行（被 import 时不跑）。
// argv[1] 必须取 realpath：经 node_modules/.bin 软链调用时 argv[1] 是链接路径，
// 而 import.meta.url 是符号链接解析后的真实路径，不还原会导致 bin 调用静默空跑。
const invokedAs =
  process.argv[1] !== undefined ? realpathSync(process.argv[1]) : "";
if (invokedAs !== "" && fileURLToPath(import.meta.url) === invokedAs) {
  process.exitCode = await runLocal(process.argv.slice(2));
}
