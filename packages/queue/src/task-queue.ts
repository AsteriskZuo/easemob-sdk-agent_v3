import type { Database } from "@easemob/agent-database";
import { migrate } from "@easemob/agent-database";
import type { EventEnvelope } from "@easemob/agent-contracts";
import { newUlid, validateEnvelope } from "@easemob/agent-contracts";

/** 任务消化状态：pending 待取 / processing 消化中 / done 完结 / dead 死信 */
export type TaskStatus = "pending" | "processing" | "done" | "dead";

/** 队列中的任务 = 事件 + 消化状态 */
export interface Task {
  task_id: string; // 任务 id："task_" + ULID，入队时生成
  event: EventEnvelope; // 任务携带的事件信封（落库为 JSON）
  status: TaskStatus; // 消化状态
  enqueued_at: string; // ISO 8601（UTC 带 Z）
  finished_at?: string; // complete/deadLetter 时写入
}

/** 控制台查询过滤条件；多条件为 AND，空 filter 返回全部 */
export interface TaskFilter {
  status?: TaskStatus; // 按消化状态过滤
  event_id?: string; // 按事件 id 过滤（列级）
  correlation_id?: string; // 按信封内 correlation_id 过滤（json_extract）
}

export interface TaskQueue {
  /** 落库才算收到。先过 validateEnvelope（fail-closed，不过则抛错）；
   *  event_id 幂等：同表已有该 event_id 则返回已有任务、不产生新行 */
  enqueue(event: EventEnvelope): Task;

  /** FIFO 取下一个 pending 并置为 processing；无 pending 返回 null */
  take(): Task | null;

  /** 消化完结（含"无关注者"的正常完结）；置 done + finished_at */
  complete(task_id: string): void;

  /** 死信（hop_count 超阈值、投递重试耗尽等）；置 dead + finished_at + reason 落库 */
  deadLetter(task_id: string, reason: string): void;

  /** 查询面（控制台用，最小集） */
  query(filter: TaskFilter): Task[];

  /** 崩溃恢复：启动时调用一次，把残留 processing 重置回 pending，返回重置条数 */
  recover(): number;

  /** 数据保留：删除 status=done 且 finished_at 早于 cutoffIso 的任务，返回删除条数。
   *  dead 不删（排查价值）、pending/processing 绝不删 */
  purge(cutoffIso: string): number;
}

interface TaskRow {
  task_id: string;
  event_id: string;
  event: string;
  status: TaskStatus;
  enqueued_at: string;
  finished_at: string | null;
  dead_reason: string | null;
}

function rowToTask(row: TaskRow): Task {
  const task: Task = {
    task_id: row.task_id,
    event: JSON.parse(row.event) as EventEnvelope,
    status: row.status,
    enqueued_at: row.enqueued_at,
  };
  if (row.finished_at !== null) {
    task.finished_at = row.finished_at;
  }
  return task;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 创建队列实例。table 由调用方命名（平台用 'entry_tasks' / 'exit_tasks'）；
 *  建表用幂等 CREATE TABLE IF NOT EXISTS */
export function createTaskQueue(db: Database, table: string): TaskQueue {
  // 表名将拼接进 SQL 语句，白名单校验防注入
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`createTaskQueue: 非法表名 "${table}"`);
  }

  // v1 = 建表 + (status, enqueued_at) 索引；迁移 module 用 "queue:" + table 区分入口/出口两个实例
  migrate(db, `queue:${table}`, [
    `CREATE TABLE IF NOT EXISTS ${table} (
  task_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  finished_at TEXT,
  dead_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_${table}_status_enqueued_at ON ${table} (status, enqueued_at);`,
  ]);

  function getByTaskId(taskId: string): TaskRow | undefined {
    return db.get<TaskRow>(`SELECT * FROM ${table} WHERE task_id = ?`, [
      taskId,
    ]);
  }

  return {
    enqueue(event: EventEnvelope): Task {
      const validation = validateEnvelope(event);
      if (!validation.ok) {
        throw new Error(
          `enqueue: 非法事件信封: ${validation.errors.join("; ")}`,
        );
      }
      const existing = db.get<TaskRow>(
        `SELECT * FROM ${table} WHERE event_id = ?`,
        [event.event_id],
      );
      // event_id 幂等：命中直接返回已有任务；未命中才插入（UNIQUE 约束兜底并发冲突）
      if (existing) {
        return rowToTask(existing);
      }
      const task: Task = {
        task_id: `task_${newUlid()}`,
        event,
        status: "pending",
        enqueued_at: nowIso(),
      };
      db.run(
        `INSERT INTO ${table} (task_id, event_id, event, status, enqueued_at) VALUES (?, ?, ?, ?, ?)`,
        [
          task.task_id,
          event.event_id,
          JSON.stringify(event),
          task.status,
          task.enqueued_at,
        ],
      );
      return task;
    },

    take(): Task | null {
      return db.transaction(() => {
        // FIFO：enqueued_at 相同毫秒时以 rowid 兜底排序；取出与置 processing 在同一事务内
        const row = db.get<TaskRow>(
          `SELECT * FROM ${table} WHERE status = 'pending' ORDER BY enqueued_at, rowid LIMIT 1`,
        );
        if (!row) {
          return null;
        }
        db.run(`UPDATE ${table} SET status = 'processing' WHERE task_id = ?`, [
          row.task_id,
        ]);
        return rowToTask({ ...row, status: "processing" });
      });
    },

    complete(taskId: string): void {
      if (!getByTaskId(taskId)) {
        throw new Error(`complete: 任务不存在: ${taskId}`);
      }
      db.run(
        `UPDATE ${table} SET status = 'done', finished_at = ? WHERE task_id = ?`,
        [nowIso(), taskId],
      );
    },

    deadLetter(taskId: string, reason: string): void {
      if (!getByTaskId(taskId)) {
        throw new Error(`deadLetter: 任务不存在: ${taskId}`);
      }
      db.run(
        `UPDATE ${table} SET status = 'dead', finished_at = ?, dead_reason = ? WHERE task_id = ?`,
        [nowIso(), reason, taskId],
      );
    },

    query(filter: TaskFilter): Task[] {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.status !== undefined) {
        where.push("status = ?");
        params.push(filter.status);
      }
      if (filter.event_id !== undefined) {
        where.push("event_id = ?");
        params.push(filter.event_id);
      }
      if (filter.correlation_id !== undefined) {
        where.push("json_extract(event, '$.correlation_id') = ?");
        params.push(filter.correlation_id);
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db.all<TaskRow>(
        `SELECT * FROM ${table} ${clause} ORDER BY enqueued_at, rowid`,
        params,
      );
      return rows.map(rowToTask);
    },

    recover(): number {
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE status = 'processing'`,
      );
      const count = row?.n ?? 0;
      if (count > 0) {
        db.run(
          `UPDATE ${table} SET status = 'pending' WHERE status = 'processing'`,
        );
      }
      return count;
    },

    purge(cutoffIso: string): number {
      // finished_at 是统一 UTC Z 格式的 ISO 字符串，字典序即时间序
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE status = 'done' AND finished_at < ?`,
        [cutoffIso],
      );
      const count = row?.n ?? 0;
      if (count > 0) {
        db.run(
          `DELETE FROM ${table} WHERE status = 'done' AND finished_at < ?`,
          [cutoffIso],
        );
      }
      return count;
    },
  };
}
