import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { createUpdateQueue } from "../src/index.js";
import type { UpdateQueue } from "../src/index.js";

let tmpDir: string;
let db: Database;
let queue: UpdateQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-update-queue-test-"));
  db = openDatabase(join(tmpDir, "queue.db"));
  queue = createUpdateQueue(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("enqueue：持久化命令与业务范围，seq 全局自增", () => {
  const a = queue.enqueue({
    kind: "env.business.set",
    payload: { bucket: "vars", key: "k", value: "v" },
    business_ids: ["biz_1"],
    requested_by: "user_1",
  });
  const b = queue.enqueue({
    kind: "asset.register",
    payload: {},
    business_ids: [],
    requested_by: "user_1",
  });
  const c = queue.enqueue({
    kind: "env.global.set",
    payload: { bucket: "vars", key: "k2", value: "v2" },
    business_ids: "all",
    requested_by: "user_2",
  });
  expect(a.seq).toBeGreaterThan(0);
  expect(b.seq).toBe(a.seq + 1);
  expect(c.seq).toBe(b.seq + 1);
  expect(a.status).toBe("pending");
  expect(a.business_ids).toEqual(["biz_1"]);
  expect(b.business_ids).toEqual([]);
  expect(c.business_ids).toBe("all");
  expect(queue.get(c.update_id)?.payload).toEqual({
    bucket: "vars",
    key: "k2",
    value: "v2",
  });
});

test("peek：严格全局 FIFO 队首，不置 processing", () => {
  const a = queue.enqueue({
    kind: "k1",
    payload: {},
    business_ids: ["biz_1"],
    requested_by: "u",
  });
  queue.enqueue({
    kind: "k2",
    payload: {},
    business_ids: ["biz_2"],
    requested_by: "u",
  });
  expect(queue.peek()?.update_id).toBe(a.update_id);
  expect(queue.peek()?.status).toBe("pending"); // 重复 peek 不消化
});

test("peekNextEmptyScope：越过有范围的等待者，找到首个空影响命令", () => {
  queue.enqueue({
    kind: "k1",
    payload: {},
    business_ids: ["biz_1"],
    requested_by: "u",
  });
  const empty = queue.enqueue({
    kind: "k2",
    payload: {},
    business_ids: [],
    requested_by: "u",
  });
  expect(queue.peekNextEmptyScope()?.update_id).toBe(empty.update_id);
});

test("begin/complete/fail：状态机迁移与非合法状态抛错", () => {
  const cmd = queue.enqueue({
    kind: "k1",
    payload: {},
    business_ids: ["biz_1"],
    requested_by: "u",
  });
  expect(() => queue.complete(cmd.update_id)).toThrow("不在 processing");
  queue.begin(cmd.update_id);
  expect(queue.get(cmd.update_id)?.status).toBe("processing");
  expect(queue.get(cmd.update_id)?.started_at).toBeTruthy();
  expect(() => queue.begin(cmd.update_id)).toThrow("不在 pending");
  queue.fail(cmd.update_id, "apply boom");
  const failed = queue.get(cmd.update_id);
  expect(failed?.status).toBe("failed");
  expect(failed?.error).toBe("apply boom");
  expect(failed?.finished_at).toBeTruthy();
});

test("recover：processing 残留重置回 pending，failed 不恢复", () => {
  const a = queue.enqueue({
    kind: "k1",
    payload: {},
    business_ids: ["biz_1"],
    requested_by: "u",
  });
  const b = queue.enqueue({
    kind: "k2",
    payload: {},
    business_ids: ["biz_2"],
    requested_by: "u",
  });
  queue.begin(a.update_id);
  queue.begin(b.update_id);
  queue.fail(b.update_id, "x");
  expect(queue.recover()).toBe(1);
  expect(queue.get(a.update_id)?.status).toBe("pending");
  expect(queue.get(b.update_id)?.status).toBe("failed");
  // recover 后队首可重新 begin
  expect(queue.peek()?.update_id).toBe(a.update_id);
  queue.begin(a.update_id);
  queue.complete(a.update_id);
  expect(queue.get(a.update_id)?.status).toBe("done");
  expect(queue.peek()).toBeNull();
});
