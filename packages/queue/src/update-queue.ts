import type { Database } from "@asteriskzuo/agent-database";
import { migrate } from "@asteriskzuo/agent-database";
import { newUlid } from "@asteriskzuo/agent-contracts";

/** 更新命令消化状态：pending 待应用 / processing 应用窗口中 / done 已应用 / failed 应用失败（不自动重试）。
 *  事件 TaskQueue 的 dead 死信状态保持独立，两者不混用 */
export type UpdateCommandStatus = "pending" | "processing" | "done" | "failed";

/** 更新命令：一次影响业务执行的配置/资产变更（与事件信封无关的新任务对象） */
export interface UpdateCommand {
  update_id: string; // "upd_" + ULID，入队时生成
  seq: number; // 全局自增序号（= 行 rowid），严格 FIFO 依据
  kind: string; // 命令类型；应用处理器归 app/server，本包不解释
  payload: unknown; // JSON 可序列化完整参数（可含 secret，禁止入日志）
  business_ids: string[] | "all"; // 受影响业务范围；空数组=空影响集合（创建/无引用资产），all=全业务屏障
  requested_by: string; // 已认证操作者 user_id（审计用）
  status: UpdateCommandStatus;
  created_at: string; // ISO 8601（UTC 带 Z）
  started_at?: string; // begin 时写入
  finished_at?: string; // complete/fail 时写入
  error?: string; // failed 时的脱敏错误（脱敏归调用方）
}

export interface UpdateQueue {
  /** 持久化新命令（pending + 业务范围关联行），返回完整命令（含 update_id/seq） */
  enqueue(input: {
    kind: string;
    payload: unknown;
    business_ids: string[] | "all";
    requested_by: string;
  }): UpdateCommand;

  /** 全局队首 pending（不置 processing）；无 pending 返回 null */
  peek(): UpdateCommand | null;

  /** 队首之后首个空影响集合 pending（空影响豁免用）；无则 null */
  peekNextEmptyScope(): UpdateCommand | null;

  /** 进入应用窗口：pending → processing + started_at；非 pending 调用抛错 */
  begin(update_id: string): void;

  /** 应用成功：processing → done + finished_at */
  complete(update_id: string): void;

  /** 应用失败：processing → failed + finished_at + error；不自动重试 */
  fail(update_id: string, error: string): void;

  /** 崩溃恢复：启动时调用一次，把残留 processing 重置回 pending，返回重置条数 */
  recover(): number;

  /** 按 id 查询（系统日志关联/排障用；不面向控制台） */
  get(update_id: string): UpdateCommand | null;

  /** 把指定业务在 afterSeq 之后的 pending 命令标记 failed（业务删除后清理无意义命令），返回标记条数 */
  failPendingFor(business_id: string, afterSeq: number, reason: string): number;

  /** 是否存在指定业务的指定 kind 的 pending 命令（business.delete 已接受后拒新写用） */
  hasPendingKindFor(kind: string, business_id: string): boolean;
}

interface CommandRow {
  rowid: number;
  update_id: string;
  kind: string;
  payload_json: string;
  scope: string; // 'all' | 'list'
  requested_by: string;
  status: UpdateCommandStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 创建更新命令队列（单一物理表 business_update_commands + 业务范围关联表）。
 *  与事件 TaskQueue 共用持久化/恢复纪律，但任务对象不同（命令 ≠ EventEnvelope） */
export function createUpdateQueue(db: Database): UpdateQueue {
  migrate(db, "queue:business_update_commands", [
    `CREATE TABLE IF NOT EXISTS business_update_commands (
  update_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_business_update_commands_status ON business_update_commands (status);
CREATE TABLE IF NOT EXISTS business_update_command_businesses (
  update_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  PRIMARY KEY (update_id, business_id)
);`,
  ]);

  const rowToCommand = (row: CommandRow): UpdateCommand => {
    const business_ids =
      row.scope === "all"
        ? ("all" as const)
        : db
            .all<{ business_id: string }>(
              `SELECT business_id FROM business_update_command_businesses WHERE update_id = ? ORDER BY business_id`,
              [row.update_id],
            )
            .map((r) => r.business_id);
    const cmd: UpdateCommand = {
      update_id: row.update_id,
      seq: row.rowid,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      business_ids,
      requested_by: row.requested_by,
      status: row.status,
      created_at: row.created_at,
    };
    if (row.started_at !== null) cmd.started_at = row.started_at;
    if (row.finished_at !== null) cmd.finished_at = row.finished_at;
    if (row.error !== null) cmd.error = row.error;
    return cmd;
  };

  const statusOf = (updateId: string): UpdateCommandStatus | undefined =>
    db.get<{ status: UpdateCommandStatus }>(
      `SELECT status FROM business_update_commands WHERE update_id = ?`,
      [updateId],
    )?.status;

  return {
    enqueue(input): UpdateCommand {
      return db.transaction(() => {
        const updateId = `upd_${newUlid()}`;
        const scope = input.business_ids === "all" ? "all" : "list";
        const createdAt = nowIso();
        db.run(
          `INSERT INTO business_update_commands (update_id, kind, payload_json, scope, requested_by, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          [
            updateId,
            input.kind,
            JSON.stringify(input.payload),
            scope,
            input.requested_by,
            createdAt,
          ],
        );
        if (input.business_ids !== "all") {
          for (const businessId of input.business_ids) {
            db.run(
              `INSERT INTO business_update_command_businesses (update_id, business_id) VALUES (?, ?)`,
              [updateId, businessId],
            );
          }
        }
        const row = db.get<CommandRow>(
          `SELECT rowid, * FROM business_update_commands WHERE update_id = ?`,
          [updateId],
        );
        return rowToCommand(row as CommandRow);
      });
    },

    peek(): UpdateCommand | null {
      // 严格全局 FIFO：rowid（= seq）最小的 pending 即队首
      const row = db.get<CommandRow>(
        `SELECT rowid, * FROM business_update_commands WHERE status = 'pending' ORDER BY rowid LIMIT 1`,
      );
      return row ? rowToCommand(row) : null;
    },

    peekNextEmptyScope(): UpdateCommand | null {
      // 空影响集合 = scope 'list' 且无关联行
      const row = db.get<CommandRow>(
        `SELECT rowid, * FROM business_update_commands c
         WHERE c.status = 'pending' AND c.scope = 'list'
           AND NOT EXISTS (
             SELECT 1 FROM business_update_command_businesses b WHERE b.update_id = c.update_id
           )
         ORDER BY c.rowid LIMIT 1`,
      );
      return row ? rowToCommand(row) : null;
    },

    begin(updateId: string): void {
      if (statusOf(updateId) !== "pending") {
        throw new Error(`begin: 命令不存在或不在 pending 状态: ${updateId}`);
      }
      db.run(
        `UPDATE business_update_commands SET status = 'processing', started_at = ? WHERE update_id = ?`,
        [nowIso(), updateId],
      );
    },

    complete(updateId: string): void {
      if (statusOf(updateId) !== "processing") {
        throw new Error(
          `complete: 命令不存在或不在 processing 状态: ${updateId}`,
        );
      }
      db.run(
        `UPDATE business_update_commands SET status = 'done', finished_at = ? WHERE update_id = ?`,
        [nowIso(), updateId],
      );
    },

    fail(updateId: string, error: string): void {
      if (statusOf(updateId) !== "processing") {
        throw new Error(`fail: 命令不存在或不在 processing 状态: ${updateId}`);
      }
      db.run(
        `UPDATE business_update_commands SET status = 'failed', finished_at = ?, error = ? WHERE update_id = ?`,
        [nowIso(), error, updateId],
      );
    },

    recover(): number {
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM business_update_commands WHERE status = 'processing'`,
      );
      const count = row?.n ?? 0;
      if (count > 0) {
        db.run(
          `UPDATE business_update_commands SET status = 'pending' WHERE status = 'processing'`,
        );
      }
      return count;
    },

    get(updateId: string): UpdateCommand | null {
      const row = db.get<CommandRow>(
        `SELECT rowid, * FROM business_update_commands WHERE update_id = ?`,
        [updateId],
      );
      return row ? rowToCommand(row) : null;
    },

    failPendingFor(
      businessId: string,
      afterSeq: number,
      reason: string,
    ): number {
      const rows = db.all<{ update_id: string }>(
        `SELECT c.update_id FROM business_update_commands c
         JOIN business_update_command_businesses b ON b.update_id = c.update_id
         WHERE c.status = 'pending' AND c.rowid > ? AND b.business_id = ?`,
        [afterSeq, businessId],
      );
      for (const row of rows) {
        db.run(
          `UPDATE business_update_commands SET status = 'failed', finished_at = ?, error = ? WHERE update_id = ?`,
          [nowIso(), reason, row.update_id],
        );
      }
      return rows.length;
    },

    hasPendingKindFor(kind: string, businessId: string): boolean {
      const row = db.get<{ update_id: string }>(
        `SELECT c.update_id FROM business_update_commands c
         JOIN business_update_command_businesses b ON b.update_id = c.update_id
         WHERE c.status = 'pending' AND c.kind = ? AND b.business_id = ?
         LIMIT 1`,
        [kind, businessId],
      );
      return row !== undefined;
    },
  };
}
