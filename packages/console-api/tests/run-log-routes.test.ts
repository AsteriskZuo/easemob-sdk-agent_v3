import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import type { RunDetailResponse, RunLogResponse } from "../src/index.js";
import {
  api,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

// 合法 run_id（/^run_[0-9A-HJKMNP-TV-Z]{26}$/）
const RUN_LOG = "run_01H8X2J4K6M8N0P2Q4R6T8W0Y2";
const RUN_BIG = "run_01H8X2J4K6M8N0P2Q4R6T8W0Y3";
const RUN_NOLOG = "run_01H8X2J4K6M8N0P2Q4R6T8W0Y4";
const RUN_MISSING = "run_01H8X2J4K6M8N0P2Q4R6T8W0Y5";

let server: TestServer;
let token: string;
let businessId: string;
let workspace: string;

function writeLog(runId: string, content: string): string {
  const dir = join(
    workspace,
    "businesses",
    businessId,
    "logs",
    "jira",
    "S-1",
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.log`);
  writeFileSync(file, content);
  return file;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "console-api-log-ws-"));
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
    run_metrics: true,
    workspace_root: workspace,
  });
  token = await loginToken(server, "admin", "admin-pass");
  businessId = server.registry.create({
    business_name: "日志业务",
    creator_id: "usr_log",
    source: "manual",
    event_type: "test.ping",
  });
  for (const [runId, createdAt] of [
    [RUN_LOG, "2026-10-10T10:00:00.000Z"],
    [RUN_BIG, "2026-10-10T11:00:00.000Z"],
    [RUN_NOLOG, "2026-10-10T12:00:00.000Z"],
  ] as const) {
    server.lifecycle.markRunning({
      lifecycle_id: runId,
      business_id: businessId,
      event_id: `evt_${runId}`,
      channel_id: "manual/S-1",
      created_at: createdAt,
    });
  }
});

afterAll(async () => {
  await server.stop();
  rmSync(workspace, { recursive: true, force: true });
  resetTestLogger();
});

describe("GET /api/runs/:id/log（路径安全）", () => {
  it("run_id 形状非法一律 400（含 run_.. 类穿越构造），不进文件系统", async () => {
    for (const bad of [
      "run_001",
      "run_..%2F..%2F..%2Fetc%2Fpasswd",
      "run_01H8X2J4K6M8N0P2Q4R6T8W0Y", // 25 位
      "run_01H8X2J4K6M8N0P2Q4R6T8W0Y2x", // 27 位
      "run_01H8X2J4K6M8N0P2Q4R6T8W0YU", // 含禁用字符 U
      "01H8X2J4K6M8N0P2Q4R6T8W0Y2",
    ]) {
      const res = await api(server, "GET", `/api/runs/${bad}/log`, { token });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        "invalid_input",
      );
    }
  });

  it("形状合法但 run 不存在 → 404；run 存在但无日志文件 → 404", async () => {
    const missing = await api(server, "GET", `/api/runs/${RUN_MISSING}/log`, {
      token,
    });
    expect(missing.status).toBe(404);
    expect(
      (missing.body as { error: { message: string } }).error.message,
    ).toContain("运行记录不存在");

    const noLog = await api(server, "GET", `/api/runs/${RUN_NOLOG}/log`, {
      token,
    });
    expect(noLog.status).toBe(404);
    expect(
      (noLog.body as { error: { message: string } }).error.message,
    ).toContain("日志不存在或已轮转");
  });
});

describe("GET /api/runs/:id/log（读取）", () => {
  it("小文件全量返回：truncated=false、path 为 workspace 相对路径", async () => {
    writeLog(RUN_LOG, "line1\nline2\nlast-line\n");
    const res = await api(server, "GET", `/api/runs/${RUN_LOG}/log`, { token });
    expect(res.status).toBe(200);
    const body = res.body as RunLogResponse;
    expect(body.run_id).toBe(RUN_LOG);
    expect(body.path).toBe(
      `businesses/${businessId}/logs/jira/S-1/${RUN_LOG}.log`,
    );
    expect(body.content).toBe("line1\nline2\nlast-line\n");
    expect(body.truncated).toBe(false);
    expect(body.size).toBe(Buffer.byteLength("line1\nline2\nlast-line\n"));
  });

  it("bytes 参数截断尾部：truncated=true、content 为末尾 bytes 字节", async () => {
    const res = await api(
      server,
      "GET",
      `/api/runs/${RUN_LOG}/log?bytes=6`,
      { token },
    );
    expect(res.status).toBe(200);
    const body = res.body as RunLogResponse;
    expect(body.truncated).toBe(true);
    expect(body.content).toBe("-line\n");
    expect(body.size).toBe(Buffer.byteLength("line1\nline2\nlast-line\n"));
  });

  it("缺省读尾部 256KB：更大文件 truncated=true 且只含末尾部分", async () => {
    const head = "HEAD-MARKER\n";
    const tail = "B".repeat(262144);
    writeLog(RUN_BIG, head + tail);
    const res = await api(server, "GET", `/api/runs/${RUN_BIG}/log`, { token });
    expect(res.status).toBe(200);
    const body = res.body as RunLogResponse;
    expect(body.truncated).toBe(true);
    expect(body.size).toBe(head.length + 262144);
    expect(body.content.length).toBe(262144);
    expect(body.content.startsWith("B")).toBe(true);
    expect(body.content.includes("HEAD-MARKER")).toBe(false);
  });

  it("bytes 非法（0/非整数/超 1MB 上限）→ 400", async () => {
    for (const bad of ["0", "-5", "abc", "1.5", "1048577"]) {
      const res = await api(
        server,
        "GET",
        `/api/runs/${RUN_LOG}/log?bytes=${bad}`,
        { token },
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        "invalid_input",
      );
    }
    const ok = await api(
      server,
      "GET",
      `/api/runs/${RUN_LOG}/log?bytes=1048576`,
      { token },
    );
    expect(ok.status).toBe(200);
  });
});

describe("GET /api/runs/:id/detail（完整装配）", () => {
  it("聚合形状：record 含 reason、llm_calls 按 ts 升序、metrics 按 key 升序折叠", async () => {
    server.lifecycle.markTerminal(RUN_LOG, "failed", "main", "exit code 1");
    // 乱序写入两条 llm 调用，读口应按 ts 升序
    server.llmCalls.record({
      run_id: RUN_LOG,
      business_id: businessId,
      ts: "2026-10-10T10:00:05.000Z",
      op: "agent",
      model: "test/model-b",
      skills: [],
      mode: "channel",
      ok: false,
      error: "agent_failed",
      duration_ms: 30,
    });
    server.llmCalls.record({
      run_id: RUN_LOG,
      business_id: businessId,
      ts: "2026-10-10T10:00:02.000Z",
      op: "agent",
      model: "test/model-a",
      skills: ["s1", "s2"],
      mode: "fresh",
      ok: true,
      duration_ms: 120,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        total_tokens: 165,
        cost_total: 0.01,
      },
    });
    server.runMetrics.record(RUN_LOG, businessId, "2026-10-10T10:00:06.000Z", {
      severity: "high",
      count: 3,
    });

    const res = await api(server, "GET", `/api/runs/${RUN_LOG}/detail`, {
      token,
    });
    expect(res.status).toBe(200);
    const detail = res.body as RunDetailResponse;
    expect(detail.record.lifecycle_id).toBe(RUN_LOG);
    expect(detail.record.reason).toBe("exit code 1");
    expect(detail.record.failed_at).toBe("main");
    expect(detail.llm_calls.map((c) => c.ts)).toEqual([
      "2026-10-10T10:00:02.000Z",
      "2026-10-10T10:00:05.000Z",
    ]);
    expect(detail.llm_calls[0].skills).toEqual(["s1", "s2"]);
    expect(detail.llm_calls[0].input_tokens).toBe(100);
    expect(detail.llm_calls[1].error).toBe("agent_failed");
    expect(detail.metrics).toEqual([
      { key: "count", value: 3 },
      { key: "severity", value: "high" },
    ]);
  });
});
