import { writeSync } from "node:fs";

/** 业务日志级别（与 runner 侧文件日志级别一致） */
export type BizLogLevel = "error" | "warn" | "info" | "debug";

/** 写业务日志：stderr 单行 JSON（含 __biz_log 标记），平台采集进该 run 的业务日志文件。
 *  永不抛错——日志管道自身的一切异常（如 fields 循环引用导致 stringify 失败）静默吞掉 */
export function writeBizLog(
  level: BizLogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  try {
    const record: Record<string, unknown> = {
      __biz_log: 1,
      level,
      message,
      ts: new Date().toISOString(),
    };
    if (fields !== undefined) record.fields = fields;
    writeSync(2, JSON.stringify(record) + "\n");
  } catch {
    // 日志管道自身永不失败
  }
}
