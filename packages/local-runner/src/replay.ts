import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateEnvelope,
  type EventEnvelope,
} from "@asteriskzuo/agent-contracts";

/**
 * 回放事件加载 / 导出失败的统一错误类型；message 中含文件路径与原因，供 CLI 直接打印。
 * CLI（T7）捕获后将退出码映射为 2（装配/执行异常）。
 */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/** 用信封契约校验解析结果；不通过时抛出列出全部校验错误的 ReplayError。 */
function assertEnvelope(input: unknown, where: string): EventEnvelope {
  const result = validateEnvelope(input);
  if (!result.ok) {
    throw new ReplayError(
      `${where} 不是合法事件信封，校验错误：\n- ${result.errors.join("\n- ")}`,
    );
  }
  return input as EventEnvelope;
}

/**
 * 加载回放事件文件（spec §5.1）。
 *
 * 行为：读文件 → JSON 解析 → validateEnvelope 校验 → 返回事件信封。
 * 信封内容原样返回（不增删字段），供装配器直接作为 RunContext.event。
 *
 * @param eventPath 回放事件文件路径（单个 JSON 文件，内容即完整 EventEnvelope）。
 * @returns 校验通过的事件信封。
 * @throws {ReplayError} 文件不存在、不是合法 JSON、信封校验不过（消息含文件路径与全部校验错误）。
 */
export function loadReplayEvent(eventPath: string): EventEnvelope {
  const absPath = path.resolve(eventPath);
  if (!existsSync(absPath)) {
    throw new ReplayError(`回放事件文件不存在：${absPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (error) {
    throw new ReplayError(
      `回放事件文件不是合法 JSON：${absPath}（${(error as Error).message}）`,
    );
  }
  return assertEnvelope(raw, `回放事件文件 ${absPath}`);
}

/**
 * 从平台数据库导出事件信封到本地回放文件（spec §5.2，export-event 子命令的实现核心）。
 *
 * 行为：
 * - 以只读模式（{ readOnly: true }）打开 platform.db，不引入 database 包依赖（最小只读查询）；
 * - 执行 `SELECT event FROM entry_tasks WHERE event_id = ?`；
 * - 取出的 event 列 JSON 解析后过 validateEnvelope（落库时已过校验，这里再校一次防脏数据）；
 * - 以 pretty JSON（2 空格缩进）写入 outPath，父目录不存在时递归创建。
 *
 * @param dbPath 平台数据库文件路径（platform.db）。
 * @param eventId 要导出的事件 id（entry_tasks.event_id）。
 * @param outPath 导出目标文件路径（父目录自动创建）。
 * @throws {ReplayError} db 文件不存在、event_id 查无记录、event 列不是合法 JSON、信封校验不过（各场景文案区分）。
 */
export function exportEventFromDb(
  dbPath: string,
  eventId: string,
  outPath: string,
): void {
  const absDbPath = path.resolve(dbPath);
  if (!existsSync(absDbPath)) {
    throw new ReplayError(`平台数据库不存在：${absDbPath}`);
  }

  let eventJson: string;
  const db = new DatabaseSync(absDbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT event FROM entry_tasks WHERE event_id = ?")
      .get(eventId) as { event: unknown } | undefined;
    if (row === undefined) {
      throw new ReplayError(
        `平台数据库 ${absDbPath} 中不存在 event_id 为 "${eventId}" 的事件（done 任务可能已被平台清理，可回放窗口受保留策略约束）`,
      );
    }
    if (typeof row.event !== "string") {
      throw new ReplayError(
        `平台数据库 ${absDbPath} 中 event_id 为 "${eventId}" 的 event 列不是字符串（实际类型：${typeof row.event}）`,
      );
    }
    eventJson = row.event;
  } finally {
    db.close();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(eventJson);
  } catch (error) {
    throw new ReplayError(
      `平台数据库 ${absDbPath} 中 event_id 为 "${eventId}" 的 event 列不是合法 JSON（${(error as Error).message}）`,
    );
  }
  const envelope = assertEnvelope(
    raw,
    `平台数据库 ${absDbPath} 中 event_id 为 "${eventId}" 的 event 列`,
  );

  const absOutPath = path.resolve(outPath);
  mkdirSync(path.dirname(absOutPath), { recursive: true });
  writeFileSync(absOutPath, JSON.stringify(envelope, null, 2));
}
