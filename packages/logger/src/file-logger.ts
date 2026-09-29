import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

/** 与 Node console 对应方法签名严格一致——console.debug(...) 与 fileLogger.debug(...)
 *  可无脑互相替换；可移植到任何 Node 项目独立使用 */
export interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

/** 共享可变控制对象：全局外观用它实现"一改全员生效"；独立使用时省略 */
export interface SharedControl {
  level: LogLevel;
  enabled: boolean;
  secrets: string[];
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
  const control: SharedControl = options.control ?? {
    level: options.level ?? "info",
    enabled: options.enabled ?? true,
    secrets: [...(options.secrets ?? [])],
  };
  const sink = createFileSink(path, control);
  const log = (level: LogLevel, args: unknown[]): void => {
    sink(level, { message: format(...args) });
  };
  return {
    error: (...args: unknown[]) => log("error", args),
    warn: (...args: unknown[]) => log("warn", args),
    info: (...args: unknown[]) => log("info", args),
    debug: (...args: unknown[]) => log("debug", args),
  };
}
