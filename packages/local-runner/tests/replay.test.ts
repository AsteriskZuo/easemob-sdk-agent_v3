import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import { ReplayError, exportEventFromDb, loadReplayEvent } from "../src/replay.js";

/**
 * 测试夹具：临时目录 root/
 *   event.json      # 回放事件文件（由各用例写入）
 *   platform.db     # 真实 sqlite 库（entry_tasks 表，由 createDb 建立并插入事件）
 */
let root: string;

/** 最小合法事件信封。 */
function validEnvelope(): EventEnvelope {
  return {
    contract_version: "v1",
    source: "jira",
    event_id: "jira:HIM-12345:2026-11-08T10:00:00.000Z",
    event_type: "jira:issue_updated",
    timestamp: "2026-11-08T10:00:00.000+08:00",
    session_id: "HIM-12345",
    correlation_id: "jira:HIM-12345:2026-11-08T10:00:00.000Z",
    hop_count: 0,
    payload: { issue_key: "HIM-12345" },
  };
}

function writeEventFile(value: unknown): string {
  const eventPath = path.join(root, "event.json");
  writeFileSync(
    eventPath,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return eventPath;
}

/** 建一个真实 sqlite 库并插入若干事件（event 列存信封 JSON 字符串，与平台落库格式一致）。 */
function createDb(rows: Array<{ eventId: string; event: string }>): string {
  const dbPath = path.join(root, "platform.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE entry_tasks (task_id TEXT PRIMARY KEY, event_id TEXT, event TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO entry_tasks (task_id, event_id, event) VALUES (?, ?, ?)",
    );
    for (const [index, row] of rows.entries()) {
      insert.run(`task_${index}`, row.eventId, row.event);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "local-runner-replay-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadReplayEvent", () => {
  it("合法信封：加载成功并原样返回", () => {
    const envelope = validEnvelope();
    const eventPath = writeEventFile(envelope);

    expect(loadReplayEvent(eventPath)).toEqual(envelope);
  });

  it("文件不存在时报 ReplayError，消息含文件路径", () => {
    const missing = path.join(root, "nope.json");

    expect(() => loadReplayEvent(missing)).toThrow(ReplayError);
    expect(() => loadReplayEvent(missing)).toThrow(
      new RegExp(`回放事件文件不存在：.*nope\\.json`),
    );
  });

  it("文件不是合法 JSON 时报错，消息含文件路径", () => {
    const eventPath = writeEventFile("{ not json");

    expect(() => loadReplayEvent(eventPath)).toThrow(ReplayError);
    expect(() => loadReplayEvent(eventPath)).toThrow(/不是合法 JSON/);
  });

  it("信封校验不过时报错，消息列出全部校验错误", () => {
    const eventPath = writeEventFile({
      contract_version: "v9",
      source: "wechat",
      event_id: "e1",
      // 缺 event_type / timestamp / session_id / correlation_id / hop_count / payload
    });

    let error: unknown;
    try {
      loadReplayEvent(eventPath);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReplayError);
    const message = (error as Error).message;
    expect(message).toContain(eventPath);
    // 缺字段类错误全部列出（不遇第一个就停）
    for (const field of [
      "event_type",
      "timestamp",
      "session_id",
      "correlation_id",
      "hop_count",
      "payload",
    ]) {
      expect(message).toContain(`missing required field: ${field}`);
    }
    // 取值域错误也同时列出
    expect(message).toContain('contract_version must be "v1"');
    expect(message).toContain("source must be one of:");
  });
});

describe("exportEventFromDb", () => {
  it("正常导出：查询命中后过校验并写出 pretty JSON，父目录自动创建", () => {
    const envelope = validEnvelope();
    const dbPath = createDb([
      { eventId: envelope.event_id, event: JSON.stringify(envelope) },
    ]);
    const outPath = path.join(root, "events", "sub", "HIM-12345.json");

    exportEventFromDb(dbPath, envelope.event_id, outPath);

    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(envelope);
    // 确认是 pretty JSON（2 空格缩进），且读回文件可再被 loadReplayEvent 消费
    expect(readFileSync(outPath, "utf8")).toBe(
      JSON.stringify(envelope, null, 2),
    );
    expect(loadReplayEvent(outPath)).toEqual(envelope);
  });

  it("db 文件不存在时报 ReplayError", () => {
    const dbPath = path.join(root, "no-such.db");

    expect(() =>
      exportEventFromDb(dbPath, "e1", path.join(root, "out.json")),
    ).toThrow(/平台数据库不存在/);
  });

  it("event_id 查无记录时报 ReplayError，消息含 event_id", () => {
    const dbPath = createDb([
      { eventId: "other-event", event: JSON.stringify(validEnvelope()) },
    ]);

    expect(() =>
      exportEventFromDb(dbPath, "missing-event", path.join(root, "out.json")),
    ).toThrow(ReplayError);
    expect(() =>
      exportEventFromDb(dbPath, "missing-event", path.join(root, "out.json")),
    ).toThrow(/不存在 event_id 为 "missing-event" 的事件/);
  });

  it("event 列不是合法 JSON 时报错（文案与查无记录区分）", () => {
    const dbPath = createDb([{ eventId: "bad-json", event: "{ broken" }]);

    expect(() =>
      exportEventFromDb(dbPath, "bad-json", path.join(root, "out.json")),
    ).toThrow(/event 列不是合法 JSON/);
  });

  it("event 列信封校验不过时报错并列出校验错误", () => {
    const dbPath = createDb([
      { eventId: "bad-envelope", event: JSON.stringify({ event_id: "x" }) },
    ]);

    let error: unknown;
    try {
      exportEventFromDb(dbPath, "bad-envelope", path.join(root, "out.json"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReplayError);
    const message = (error as Error).message;
    expect(message).toContain("bad-envelope");
    expect(message).toContain("missing required field: contract_version");
    expect(message).toContain("missing required field: payload");
  });
});
