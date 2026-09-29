import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

/** 与 Node console 对应方法签名严格一致——console.debug(...) 与 fileLogger.debug(...)
 *  可无脑互相替换；可移植到任何 Node 项目独立使用 */
export interface ConsoleLike {
  /** 同 console.error：多参数 util.format 拼接、%s/%d/%j 占位、对象走 inspect */
  error(...args: unknown[]): void;
  /** 同 console.warn（格式化语义同 error） */
  warn(...args: unknown[]): void;
  /** 同 console.info（格式化语义同 error） */
  info(...args: unknown[]): void;
  /** 同 console.debug（格式化语义同 error） */
  debug(...args: unknown[]): void;
}

/** 日志等级：error < warn < info < debug（阈值过滤，低于配置等级的不输出） */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** 共享可变控制对象：全局外观用它实现"一改全员生效"；独立使用时省略 */
export interface SharedControl {
  level: LogLevel; // 输出阈值（等级 <= 此阈值才落盘）
  enabled: boolean; // false = 全静默
  secrets: string[]; // 脱敏注册表（运行期可追加，append-only；空串/长度 < 8 不参与替换）
}

export interface FileLoggerOptions {
  level?: LogLevel; // 默认 'info'
  enabled?: boolean; // 默认 true
  secrets?: readonly string[]; // 初始脱敏值列表
  control?: SharedControl; // 内部使用：全局外观共享控制对象；独立使用时省略
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** 包内共享：等级过滤。error < warn < info < debug 阈值；enabled=false 全静默 */
export function shouldLog(control: SharedControl, level: LogLevel): boolean {
  return control.enabled && LEVEL_ORDER[level] <= LEVEL_ORDER[control.level];
}

/** 包内共享：整行子串替换脱敏；空串/长度 < 8 的值不参与（防误伤） */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

/** 包内共享：单文件 JSONL 写口——建父目录、等级过滤、{ts, level, ...record} 落盘、
 *  脱敏对整行生效、写盘异常降级 console.error 兜底（日志管道自身永不抛错） */
export function createFileSink(
  path: string,
  control: SharedControl,
): (level: LogLevel, record: Record<string, unknown>) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (level, record) => {
    if (!shouldLog(control, level)) return;
    try {
      const line = maskSecrets(
        JSON.stringify({ ts: new Date().toISOString(), level, ...record }),
        control.secrets,
      );
      appendFileSync(path, line + "\n");
    } catch (err) {
      console.error(`[agent-logger] write failed: ${path}:`, err);
    }
  };
}

/** 创建写单个文件的底层日志器；父目录自动创建 */
export function createFileLogger(
  path: string,
  options: FileLoggerOptions = {},
): ConsoleLike {
  // 传入 control 则共享之（全局外观"一改全员生效"），否则持有私有控制对象（独立使用者不感知）
  const control: SharedControl = options.control ?? {
    level: options.level ?? "info",
    enabled: options.enabled ?? true,
    secrets: [...(options.secrets ?? [])],
  };
  const sink = createFileSink(path, control);
  const log = (level: LogLevel, args: unknown[]): void => {
    sink(level, { message: format(...args) }); // util.format：与 console 完全相同的参数格式化语义
  };
  return {
    error: (...args: unknown[]) => log("error", args),
    warn: (...args: unknown[]) => log("warn", args),
    info: (...args: unknown[]) => log("info", args),
    debug: (...args: unknown[]) => log("debug", args),
  };
}
