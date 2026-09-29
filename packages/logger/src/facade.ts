import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileSink } from "./file-logger.js";
import type { LogLevel, SharedControl } from "./file-logger.js";

/** 自由字段：开放结构，类型不设限。保留字段名约定（检索一致性）：event_id / lifecycle_id / channel_id / correlation_id */
export type LogFields = Record<string, unknown>;

/** 中层：绑定固定上下文的分类日志器。调用只传消息 + 本次增量字段 */
export interface CategoryLogger {
  /** error 级（契约性必打，调用方职责）；message 主消息，fields 本次增量字段（与绑定字段合并，同名覆盖） */
  error(message: string, fields?: LogFields): void;
  /** warn 级（契约性必打）；参数语义同 error */
  warn(message: string, fields?: LogFields): void;
  /** info 级（契约性必打）；参数语义同 error */
  info(message: string, fields?: LogFields): void;
  /** debug 级（可选）；参数语义同 error */
  debug(message: string, fields?: LogFields): void;

  /** 追加绑定字段，返回新实例（继承原绑定 + 追加，同名覆盖；原实例不受影响） */
  with(fields: LogFields): CategoryLogger;
}

export interface LoggerInitOptions {
  logsDir: string; // 平台日志目录（system/entry-loop/exit-loop 三个文件写在这里）
  level?: LogLevel; // 默认 'info'；初始化后不可变
  enabled?: boolean; // 默认 true；初始化后不可变
  secrets?: readonly string[]; // 初始脱敏值列表；运行期新增走 logger.addSecrets
}

type FileSink = (level: LogLevel, record: Record<string, unknown>) => void;

/** 全局外观状态：initLogger 创建（仅一次），resetForTests 清空 */
interface FacadeState {
  logsDir: string; // 平台日志目录
  control: SharedControl; // 共享控制对象：三个文件日志器共用，addSecrets 追加即全员生效
  sinks: Map<string, FileSink>; // 已建文件写口（按文件名懒建缓存）
}

let state: FacadeState | null = null; // null = 未初始化（调用任何方法抛错）

const NOT_INITIALIZED =
  "@easemob/agent-logger: logger 未初始化，请先在装配根调用 initLogger()";

/** 路由：module 'entry-loop'→entry-loop.log、'exit-loop'→exit-loop.log、其余一律归 system.log */
function routeFile(module: string): string {
  if (module === "entry-loop") return "entry-loop.log";
  if (module === "exit-loop") return "exit-loop.log";
  return "system.log";
}

/** 取或懒建文件写口（三个文件日志器懒建，全部共享同一 control） */
function getSink(current: FacadeState, fileName: string): FileSink {
  let sink = current.sinks.get(fileName);
  if (!sink) {
    sink = createFileSink(join(current.logsDir, fileName), current.control);
    current.sinks.set(fileName, sink);
  }
  return sink;
}

/** 中层落盘行 = {ts, level, ...绑定字段, ...增量字段, message}：绑定在前、增量在后（同名增量覆盖绑定） */
function makeCategoryLogger(
  current: FacadeState,
  fileName: string,
  bound: LogFields,
): CategoryLogger {
  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    getSink(current, fileName)(level, { ...bound, ...(fields ?? {}), message });
  };
  return {
    error: (message, fields) => log("error", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    info: (message, fields) => log("info", message, fields),
    debug: (message, fields) => log("debug", message, fields),
    with: (fields) =>
      makeCategoryLogger(current, fileName, { ...bound, ...fields }),
  };
}

/** 全局外观初始化：仅装配根启动时调用一次；重复调用抛错。
 *  fail-fast：logsDir 不可创建/不可写 → 抛错（启动自检） */
export function initLogger(options: LoggerInitOptions): void {
  if (state) {
    throw new Error("@easemob/agent-logger: initLogger() 只能调用一次");
  }
  try {
    // fail-fast 自检：建目录 + 写测文件 + 删除，任何一步失败 = 启动自检失败
    mkdirSync(options.logsDir, { recursive: true });
    const probe = join(options.logsDir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
  } catch (err) {
    throw new Error(
      `@easemob/agent-logger: logsDir 不可创建/不可写: ${options.logsDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  state = {
    logsDir: options.logsDir,
    control: {
      level: options.level ?? "info",
      enabled: options.enabled ?? true,
      secrets: [...(options.secrets ?? [])],
    },
    sinks: new Map(),
  };
}

/** 平台日志全局外观。未初始化时调用任何方法 → 抛错 */
export const logger = {
  /** 绑定模块上下文取分类日志器。路由：module 'entry-loop'→entry-loop.log、
   *  'exit-loop'→exit-loop.log、其余一律归 system.log */
  for(context: { module: string } & LogFields): CategoryLogger {
    if (!state) throw new Error(NOT_INITIALIZED);
    return makeCategoryLogger(state, routeFile(context.module), context);
  },

  /** 登记脱敏值：只增不改（append-only，依赖管理规则第 2 类唯一例外） */
  addSecrets(values: readonly string[]): void {
    if (!state) throw new Error(NOT_INITIALIZED);
    state.control.secrets.push(...values);
  },
};

/** 测试专用：重置全局外观（含共享控制与已建文件日志器）。生产代码禁止调用 */
export function resetForTests(): void {
  state = null;
}
