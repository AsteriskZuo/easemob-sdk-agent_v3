import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initLogger, resetForTests } from "@asteriskzuo/agent-logger";
import { createAgentService } from "../src/index.js";
import type {
  AgentServeContext,
  AgentServiceDeps,
  RunningAgentService,
} from "../src/index.js";

interface CapturedRun {
  ts: number;
  pid: number;
  argv: string[];
  cwd: string;
  env: { PI_CODING_AGENT_DIR: string | null; AUDIT_LOG_PATH: string | null };
}

type Resp =
  | { contract_version: "v1"; ok: true; output: unknown }
  | { contract_version: "v1"; ok: false; error: string };

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../tests/fixtures/${name}`, import.meta.url),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await sleep(20);
  }
}

/** 原始一行请求：payload 需自带 \n；返回响应行原文 */
function callRaw(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    conn.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    conn.on("connect", () => conn.write(payload));
    conn.on("data", (c) => {
      if (settled) return;
      buf += c.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        settled = true;
        conn.end();
        resolve(buf.slice(0, i));
      }
    });
    conn.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("连接关闭未收到响应"));
      }
    });
  });
}

async function call(
  endpoint: { socket_path: string; token: string },
  req: Record<string, unknown>,
): Promise<Resp> {
  const line = await callRaw(
    endpoint.socket_path,
    JSON.stringify({ contract_version: "v1", token: endpoint.token, ...req }) +
      "\n",
  );
  return JSON.parse(line) as Resp;
}

function readCapture(path: string): CapturedRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CapturedRun);
}

function argvValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 手写 mapping 假实现：记录 bind/clear 调用 */
function makeMapping() {
  const store = new Map<string, string>();
  const calls = { bind: [] as Array<[string, string]>, clear: [] as string[] };
  return {
    store,
    calls,
    bindAgentSession(channelId: string, agentSessionId: string): void {
      calls.bind.push([channelId, agentSessionId]);
      store.set(channelId, agentSessionId);
    },
    getAgentSession(channelId: string): string | undefined {
      return store.get(channelId);
    },
    clear(channelId: string): void {
      calls.clear.push(channelId);
      store.delete(channelId);
    },
  };
}

describe("AgentService", () => {
  let root: string;
  let capture: string;
  let handles: RunningAgentService[];

  function makeCtx(over: Partial<AgentServeContext> = {}): AgentServeContext {
    const workspace = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    return {
      run_id: `run-${Math.random().toString(36).slice(2, 10)}`,
      channel_id: "ch-1",
      workspace,
      prompt: "提示词总纲",
      skills: [
        { name: "s1", path: "/skills/s1" },
        { name: "s2", path: "/skills/s2" },
      ],
      model: "test:model",
      session_dir: sessionDir,
      audit_log_path: join(root, "audit", "llm-requests.jsonl"),
      quota: { max_agent_calls: 10 },
      ...over,
    };
  }

  function makeDeps(
    mapping: ReturnType<typeof makeMapping>,
    piEnv: Record<string, string> = {},
  ): AgentServiceDeps {
    return {
      pi_cli_path: fixturePath("fake-pi.js"),
      pi_agent_dir: "/fake/agent-dir",
      // shebang 走 /usr/bin/env node，子进程 env 不继承，PATH 必须显式给
      pi_env: {
        PATH: process.env.PATH ?? "",
        FAKE_PI_CAPTURE: capture,
        ...piEnv,
      },
      mapping,
    };
  }

  async function serve(
    deps: AgentServiceDeps,
    ctx: AgentServeContext,
  ): Promise<RunningAgentService> {
    const handle = await createAgentService(deps).serve(ctx);
    handles.push(handle);
    return handle;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-service-test-"));
    capture = join(root, "capture.jsonl");
    handles = [];
    initLogger({ logsDir: join(root, "logs"), enabled: false });
  });

  afterEach(async () => {
    for (const h of handles) await h.close();
    resetForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it("1. serve 返回 endpoint（socket 存在）；非法 JSON / 版本不符 / token 错 → invalid_request", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx();
    const handle = await serve(makeDeps(mapping), ctx);

    expect(existsSync(handle.endpoint.socket_path)).toBe(true);
    // 审计文件父目录 serve 时建好
    expect(existsSync(dirname(ctx.audit_log_path))).toBe(true);

    const badJson = await callRaw(handle.endpoint.socket_path, "{ 不是JSON\n");
    expect(JSON.parse(badJson)).toMatchObject({
      ok: false,
      error: "invalid_request",
    });

    const badVersion = await callRaw(
      handle.endpoint.socket_path,
      JSON.stringify({
        contract_version: "v2",
        token: handle.endpoint.token,
        op: "clear",
      }) + "\n",
    );
    expect(JSON.parse(badVersion)).toMatchObject({
      ok: false,
      error: "invalid_request",
    });

    const badToken = (await callRaw(
      handle.endpoint.socket_path,
      JSON.stringify({
        contract_version: "v1",
        token: "wrong-token",
        op: "clear",
      }) + "\n",
    )) as string;
    expect(JSON.parse(badToken)).toMatchObject({
      ok: false,
      error: "invalid_request",
    });
  });

  it("2. agent 正常：fake pi 回文本；capture 断言 argv/cwd/env 装配", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx();
    const deps = makeDeps(mapping, { FAKE_PI_REPLY: "最终答复" });
    const handle = await serve(deps, ctx);

    const resp = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "你好",
    });
    expect(resp).toMatchObject({ contract_version: "v1", ok: true });
    expect((resp as { output: unknown }).output).toBe("最终答复");

    const lines = readCapture(capture);
    expect(lines.length).toBe(1);
    const run = lines[0];
    const argv = run.argv;
    expect(argv[0]).toBe("-p");
    expect(argvValue(argv, "--mode")).toBe("json");
    expect(argv).toContain("--no-skills");
    // 只请求了 s1：恰好一个 --skill 且是 s1 的物化路径
    expect(argv.filter((a) => a === "--skill").length).toBe(1);
    expect(argvValue(argv, "--skill")).toBe("/skills/s1");
    // -e 仅平台审计 extension 一个
    expect(argv.filter((a) => a === "-e").length).toBe(1);
    expect(argvValue(argv, "-e")).toMatch(/extensions\/audit\.js$/);
    expect(argvValue(argv, "--session-dir")).toBe(ctx.session_dir);
    expect(argvValue(argv, "--model")).toBe("test:model");
    expect(argvValue(argv, "--system-prompt")).toBe("提示词总纲");
    expect(argvValue(argv, "--session-id")).toBeTruthy();
    expect(argv).toContain("--no-tools");
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-prompt-templates");
    expect(argv).toContain("--no-context-files");
    // 输入文本是最后一个位置参数
    expect(argv[argv.length - 1]).toBe("你好");
    // cwd = workspace；env 含 PI_CODING_AGENT_DIR / AUDIT_LOG_PATH
    // （macOS 上 tmpdir 是 /var 符号链接，子进程拿到真实路径，比较 realpath）
    expect(realpathSync(run.cwd)).toBe(realpathSync(ctx.workspace));
    expect(run.env.PI_CODING_AGENT_DIR).toBe("/fake/agent-dir");
    expect(run.env.AUDIT_LOG_PATH).toBe(ctx.audit_log_path);
  });

  it("3. 白名单：skills 含未授权名 → skill_not_allowed，未 spawn", async () => {
    const mapping = makeMapping();
    const handle = await serve(makeDeps(mapping), makeCtx());

    const resp = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1", "not-allowed"],
      input: "x",
    });
    expect(resp).toMatchObject({
      ok: false,
      error: "skill_not_allowed: not-allowed",
    });
    expect(readCapture(capture).length).toBe(0);
  });

  it("4. 空 skills / 缺 input → invalid_request；输入超 512KB → input_too_large", async () => {
    const mapping = makeMapping();
    const handle = await serve(makeDeps(mapping), makeCtx());

    expect(
      await call(handle.endpoint, { op: "agent", skills: [], input: "x" }),
    ).toMatchObject({ ok: false, error: "invalid_request" });
    expect(
      await call(handle.endpoint, { op: "agent", skills: ["s1"] }),
    ).toMatchObject({ ok: false, error: "invalid_request" });

    const big = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x".repeat(512 * 1024 + 1),
    });
    expect(big).toMatchObject({ ok: false, error: "input_too_large" });
    expect(readCapture(capture).length).toBe(0);
  });

  it("5. 配额：max_agent_calls=1，第二次 agent → quota_exceeded 未 spawn；失败的调用也计数", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx({ quota: { max_agent_calls: 1 } });
    const handle = await serve(makeDeps(mapping), ctx);

    const first = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(first.ok).toBe(true);
    const second = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(second).toMatchObject({ ok: false, error: "quota_exceeded" });
    expect(readCapture(capture).length).toBe(1);
    await handle.close();
    handles.pop();

    // 失败调用同样计 1 次配额
    const mapping2 = makeMapping();
    const ctx2 = makeCtx({ quota: { max_agent_calls: 1 } });
    const handle2 = await serve(
      makeDeps(mapping2, { FAKE_PI_EXIT: "1" }),
      ctx2,
    );
    const failed = await call(handle2.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(failed.ok).toBe(false);
    const afterFail = await call(handle2.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(afterFail).toMatchObject({ ok: false, error: "quota_exceeded" });
  });

  it("6. 会话：channel 首调 bind（新 uuid 入 argv）、二调用映射 id；fresh 两次不同 id 不写映射", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx();
    const handle = await serve(makeDeps(mapping), ctx);

    await call(handle.endpoint, { op: "agent", skills: ["s1"], input: "a" });
    await call(handle.endpoint, { op: "agent", skills: ["s1"], input: "b" });
    expect(mapping.calls.bind.length).toBe(1);
    expect(mapping.calls.bind[0][0]).toBe("ch-1");
    const boundId = mapping.calls.bind[0][1];

    let lines = readCapture(capture);
    expect(argvValue(lines[0].argv, "--session-id")).toBe(boundId);
    expect(argvValue(lines[1].argv, "--session-id")).toBe(boundId);

    await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "c",
      mode: "fresh",
    });
    await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "d",
      mode: "fresh",
    });
    lines = readCapture(capture);
    const fresh1 = argvValue(lines[2].argv, "--session-id");
    const fresh2 = argvValue(lines[3].argv, "--session-id");
    expect(fresh1).toBeTruthy();
    expect(fresh2).toBeTruthy();
    expect(fresh1).not.toBe(fresh2);
    expect(fresh1).not.toBe(boundId);
    expect(mapping.calls.bind.length).toBe(1); // fresh 不写映射
  });

  it("7. FAKE_PI_EXIT=1 → agent_failed 含 stderr 尾部；无 assistant 消息 → agent_empty_output", async () => {
    const mapping = makeMapping();
    const handle = await serve(
      makeDeps(mapping, { FAKE_PI_EXIT: "3" }),
      makeCtx(),
    );
    const resp = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(resp.ok).toBe(false);
    const err = (resp as { error: string }).error;
    expect(err.startsWith("agent_failed: ")).toBe(true);
    expect(err).toContain("fake pi 故障: FAKE_PI_EXIT=3");
    await handle.close();
    handles.pop();

    const mapping2 = makeMapping();
    const handle2 = await serve(
      makeDeps(mapping2, { FAKE_PI_NO_ASSISTANT: "1" }),
      makeCtx(),
    );
    const empty = await call(handle2.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(empty).toMatchObject({ ok: false, error: "agent_empty_output" });
  });

  it("8. compact：有映射 → fake pi RPC success → ok:true 且 spawn 了 rpc；无映射 → ok:true 不 spawn", async () => {
    const mapping = makeMapping();
    mapping.bindAgentSession("ch-1", "sess-existed");
    const handle = await serve(makeDeps(mapping), makeCtx());

    const resp = await call(handle.endpoint, { op: "compact" });
    expect(resp).toMatchObject({ ok: true, output: null });
    const lines = readCapture(capture);
    expect(lines.length).toBe(1);
    expect(argvValue(lines[0].argv, "--mode")).toBe("rpc");
    expect(argvValue(lines[0].argv, "--session-id")).toBe("sess-existed");
    await handle.close();
    handles.pop();

    const mapping2 = makeMapping(); // 无映射
    const handle2 = await serve(makeDeps(mapping2), makeCtx());
    const before = readCapture(capture).length;
    const noop = await call(handle2.endpoint, { op: "compact" });
    expect(noop).toMatchObject({ ok: true, output: null });
    expect(readCapture(capture).length).toBe(before); // 未 spawn
  });

  it("9. clear → mapping.clear 收到 channel_id，ok:true", async () => {
    const mapping = makeMapping();
    mapping.bindAgentSession("ch-1", "sess-x");
    const handle = await serve(makeDeps(mapping), makeCtx());

    const resp = await call(handle.endpoint, { op: "clear" });
    expect(resp).toMatchObject({ ok: true, output: null });
    expect(mapping.calls.clear).toEqual(["ch-1"]);
    expect(mapping.getAgentSession("ch-1")).toBeUndefined();
  });

  it("10. close：杀挂起的 pi、挂起请求回 service_closed、socket 删除、幂等", async () => {
    const mapping = makeMapping();
    const handle = await serve(
      makeDeps(mapping, { FAKE_PI_SLEEP_MS: "5000" }),
      makeCtx(),
    );

    const p1 = call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "slow",
    });
    await waitFor(() => readCapture(capture).length === 1);
    // 第二个请求先发（排进串行链），再 close
    const p2 = call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "queued",
    });
    await sleep(150);
    await handle.close();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false); // 在飞的以 agent_failed 收尾
    expect((r1 as { error: string }).error.startsWith("agent_failed")).toBe(
      true,
    );
    expect(r2).toMatchObject({ ok: false, error: "service_closed" });

    // 挂起的 pi 已被杀
    const pid = readCapture(capture)[0].pid;
    expect(() => process.kill(pid, 0)).toThrow();
    // socket 文件删除
    expect(existsSync(handle.endpoint.socket_path)).toBe(false);
    // close 幂等
    await handle.close();
    // close 后新连接：服务不再受理
    await expect(
      callRaw(handle.endpoint.socket_path, "{}\n"),
    ).rejects.toThrow();
  });

  it("11. 串行化：并发两个 agent（fake sleep 100ms）→ 启动间隔 ≥ 100ms", async () => {
    const mapping = makeMapping();
    const handle = await serve(
      makeDeps(mapping, { FAKE_PI_SLEEP_MS: "100" }),
      makeCtx(),
    );

    const [r1, r2] = await Promise.all([
      call(handle.endpoint, { op: "agent", skills: ["s1"], input: "a" }),
      call(handle.endpoint, { op: "agent", skills: ["s1"], input: "b" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const lines = readCapture(capture);
    expect(lines.length).toBe(2);
    // 定时器有少量误差，断言留 10ms 余量
    expect(lines[1].ts - lines[0].ts).toBeGreaterThanOrEqual(90);
  });
});
