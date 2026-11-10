import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
  LlmCallSink,
  RunningAgentService,
} from "../src/index.js";

/** sink record 入参类型（与契约 A 同形） */
type SinkCall = Parameters<LlmCallSink["record"]>[0];

/** 手写 LlmCallSink 假实现：记录 record 调用；throws=true 时每次抛错（验证调用点防御） */
function makeSink(throws = false) {
  const calls: SinkCall[] = [];
  return {
    calls,
    record(call: SinkCall): void {
      if (throws) throw new Error("sink 故障");
      calls.push(call);
    },
  };
}

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
  version: "v1" | "v2" = "v1",
): Promise<Resp> {
  const line = await callRaw(
    endpoint.socket_path,
    JSON.stringify({
      contract_version: version,
      token: endpoint.token,
      ...req,
    }) + "\n",
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

  /** 造一个带 models.json 的业务派生 agent 目录（serve 会解析它） */
  function makePiAgentDir(): string {
    const dir = join(root, "pi-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "model" }, { id: "model-2" }],
          },
          local: { models: [{ id: "qwen3:8b" }] },
        },
      }),
    );
    return dir;
  }

  function makeCtx(over: Partial<AgentServeContext> = {}): AgentServeContext {
    const workspace = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    // skill 物化目录 fixture：注入取其下 SKILL.md（pi-runner 对缺失 fail-fast）
    const skillDir = (name: string): string => {
      const dir = join(root, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${name} fixture\n`);
      return dir;
    };
    return {
      run_id: `run-${Math.random().toString(36).slice(2, 10)}`,
      channel_id: "ch-1",
      workspace,
      prompt: "提示词总纲",
      skills: [
        { name: "s1", path: skillDir("s1") },
        { name: "s2", path: skillDir("s2") },
      ],
      model: "test/model",
      session_dir: sessionDir,
      audit_log_path: join(root, "audit", "llm-requests.jsonl"),
      quota: { max_agent_calls: 10 },
      pi_agent_dir: makePiAgentDir(),
      ...over,
    };
  }

  function makeDeps(
    mapping: ReturnType<typeof makeMapping>,
    piEnv: Record<string, string> = {},
  ): AgentServiceDeps {
    return {
      pi_cli_path: fixturePath("fake-pi.js"),
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

  it("1. serve 返回 endpoint（socket 存在）；非法 JSON / 版本不符 / token 错 → invalid_request；v2 接受", async () => {
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
        contract_version: "v99",
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

    // v2 是合法版本（恒定 v2：SDK 全部请求发 v2，服务端收 v1/v2）
    const v2Clear = await call(handle.endpoint, { op: "clear" }, "v2");
    expect(v2Clear).toMatchObject({ ok: true });
  });

  it("1b. 契约版本规则：v1 携带 model → invalid_request；v2 携带 model → 受理", async () => {
    const mapping = makeMapping();
    const handle = await serve(makeDeps(mapping), makeCtx());

    const v1WithModel = await call(
      handle.endpoint,
      { op: "agent", skills: ["s1"], input: "x", model: "test/model" },
      "v1",
    );
    expect(v1WithModel).toMatchObject({ ok: false, error: "invalid_request" });

    const v2WithModel = await call(
      handle.endpoint,
      { op: "agent", skills: ["s1"], input: "x", model: "test/model-2" },
      "v2",
    );
    expect(v2WithModel.ok).toBe(true);

    // model 非字符串 / 空串 → invalid_request（v2）
    const badModel = await call(
      handle.endpoint,
      { op: "agent", skills: ["s1"], input: "x", model: "  " },
      "v2",
    );
    expect(badModel).toMatchObject({ ok: false, error: "invalid_request" });
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
    // 只请求了 s1：恰好一个 --append-system-prompt 且指向 s1 物化目录下的 SKILL.md；
    // 不再走 pi 原生 --skill（渐进披露在 --no-tools 下失效）
    expect(argv).not.toContain("--skill");
    expect(argv.filter((a) => a === "--append-system-prompt").length).toBe(1);
    expect(argvValue(argv, "--append-system-prompt")).toBe(
      join(ctx.skills[0].path, "SKILL.md"),
    );
    // -e 仅平台审计 extension 一个
    expect(argv.filter((a) => a === "-e").length).toBe(1);
    expect(argvValue(argv, "-e")).toMatch(/extensions\/audit\.js$/);
    expect(argvValue(argv, "--session-dir")).toBe(ctx.session_dir);
    expect(argvValue(argv, "--model")).toBe("test/model");
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
    expect(run.env.PI_CODING_AGENT_DIR).toBe(ctx.pi_agent_dir);
    expect(run.env.AUDIT_LOG_PATH).toBe(ctx.audit_log_path);
  });

  it("2b. 显式 model：白名单内 → --model 覆盖；白名单外 → model_not_allowed 未 spawn", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx();
    const handle = await serve(makeDeps(mapping), ctx);

    // 白名单内（test/model-2 与 local/qwen3:8b 都在 fixture models.json 里）
    const ok = await call(
      handle.endpoint,
      { op: "agent", skills: ["s1"], input: "x", model: "local/qwen3:8b" },
      "v2",
    );
    expect(ok.ok).toBe(true);
    const lines = readCapture(capture);
    expect(lines.length).toBe(1);
    expect(argvValue(lines[0].argv, "--model")).toBe("local/qwen3:8b");

    // 白名单外 → 拒绝且不再 spawn
    const denied = await call(
      handle.endpoint,
      { op: "agent", skills: ["s1"], input: "x", model: "evil/model" },
      "v2",
    );
    expect(denied).toMatchObject({
      ok: false,
      error: "model_not_allowed: evil/model",
    });
    expect(readCapture(capture).length).toBe(1);
  });

  it("2c. models op：返回 default 与按声明顺序的 providers；未配置 → 空枚举；不计配额", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx({ quota: { max_agent_calls: 1 } });
    const handle = await serve(makeDeps(mapping), ctx);

    const info = await call(handle.endpoint, { op: "models" }, "v2");
    expect(info).toMatchObject({ ok: true });
    expect((info as { output: unknown }).output).toEqual({
      default: "test/model",
      providers: [
        { name: "test", models: ["model", "model-2"] },
        { name: "local", models: ["qwen3:8b"] },
      ],
    });
    // 再调一次 models 仍成功（不计 agent 配额），随后 agent 把配额用掉
    const again = await call(handle.endpoint, { op: "models" }, "v2");
    expect(again.ok).toBe(true);
    const spend = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(spend.ok).toBe(true);
    const over = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(over).toMatchObject({ ok: false, error: "quota_exceeded" });
    // 配额用尽后 models 仍可用
    const still = await call(handle.endpoint, { op: "models" }, "v2");
    expect(still.ok).toBe(true);
    await handle.close();
    handles.pop();

    // 未配置业务（无 pi_agent_dir）：models 回空枚举
    const bare = await serve(
      makeDeps(makeMapping()),
      makeCtx({ pi_agent_dir: undefined }),
    );
    const empty = await call(bare.endpoint, { op: "models" }, "v2");
    expect(empty).toMatchObject({ ok: true });
    expect((empty as { output: unknown }).output).toEqual({
      default: "",
      providers: [],
    });
  });

  it("2d. 未配置大模型：agent/compact → model_not_configured；clear 放行", async () => {
    const mapping = makeMapping();
    mapping.bindAgentSession("ch-1", "sess-x");
    const handle = await serve(
      makeDeps(mapping),
      makeCtx({ pi_agent_dir: undefined }),
    );

    const agent = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(agent).toMatchObject({ ok: false, error: "model_not_configured" });

    const compact = await call(handle.endpoint, { op: "compact" });
    expect(compact).toMatchObject({
      ok: false,
      error: "model_not_configured",
    });

    const clear = await call(handle.endpoint, { op: "clear" });
    expect(clear).toMatchObject({ ok: true, output: null });
    expect(mapping.calls.clear).toEqual(["ch-1"]);
    // 未 spawn 任何 pi
    expect(readCapture(capture).length).toBe(0);
  });

  it("2e. serve 解析 models.json 失败（坏 JSON / 缺 models）→ serve 抛错", async () => {
    // 坏 JSON
    const ctx1 = makeCtx();
    writeFileSync(join(ctx1.pi_agent_dir!, "models.json"), "{ 坏JSON");
    await expect(serve(makeDeps(makeMapping()), ctx1)).rejects.toThrow(
      /不是合法 JSON/,
    );

    // 结构非法（provider 无 models 数组）
    const ctx2 = makeCtx();
    writeFileSync(
      join(ctx2.pi_agent_dir!, "models.json"),
      JSON.stringify({ providers: { test: { apiKey: "k" } } }),
    );
    await expect(serve(makeDeps(makeMapping()), ctx2)).rejects.toThrow(
      /models 必须是非空数组/,
    );

    // models.json 不存在
    const ctx3 = makeCtx();
    rmSync(join(ctx3.pi_agent_dir!, "models.json"));
    await expect(serve(makeDeps(makeMapping()), ctx3)).rejects.toThrow(
      /models\.json 不可读/,
    );
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

  it("12. skill 物化目录缺 SKILL.md → skill_missing 且未 spawn（防静默降级）", async () => {
    const mapping = makeMapping();
    const ctx = makeCtx();
    rmSync(join(ctx.skills[0].path, "SKILL.md"));
    const handle = await serve(makeDeps(mapping), ctx);

    const resp = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(resp).toMatchObject({ ok: false, error: "skill_missing: s1" });
    expect(readCapture(capture).length).toBe(0);
  });

  it("13. llm_call_sink：成功行字段齐全（usage 一对一映射，business_id 取 channel_id 第三段）", async () => {
    const sink = makeSink();
    const ctx = makeCtx({ channel_id: "wework__sess-1__biz-jira" });
    // 真实 pi Usage 形状（含 reasoning/cacheWrite1h——v1 不采）
    const piUsage = {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 3,
      cacheWrite1h: 1,
      reasoning: 7,
      totalTokens: 128,
      cost: {
        input: 0.001,
        output: 0.0004,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0017,
      },
    };
    const handle = await serve(
      {
        ...makeDeps(makeMapping(), {
          FAKE_PI_USAGE: JSON.stringify(piUsage),
        }),
        llm_call_sink: sink,
      },
      ctx,
    );

    const resp = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1", "s2"],
      input: "x",
      mode: "fresh",
    });
    expect(resp.ok).toBe(true);

    expect(sink.calls.length).toBe(1);
    const rec = sink.calls[0];
    expect(rec.run_id).toBe(ctx.run_id);
    expect(rec.business_id).toBe("biz-jira");
    expect(rec.op).toBe("agent");
    expect(rec.model).toBe("test/model");
    expect(rec.skills).toEqual(["s1", "s2"]);
    expect(rec.mode).toBe("fresh");
    expect(rec.ok).toBe(true);
    expect(rec.error).toBeUndefined();
    expect(typeof rec.duration_ms).toBe("number");
    expect(rec.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
    expect(rec.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 3,
      total_tokens: 128,
      cost_total: 0.0017,
    });
  });

  it("14. llm_call_sink：usage 形状不符 → 成功落行但无 usage；channel_id 解析失败 → business_id 兜底空串", async () => {
    const sink = makeSink();
    // 默认 channel_id "ch-1" 非三段格式，parseChannelId 抛错 → 兜底 ""
    const handle = await serve(
      { ...makeDeps(makeMapping()), llm_call_sink: sink },
      makeCtx(),
    );

    const resp = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(resp.ok).toBe(true);
    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0].business_id).toBe("");
    expect(sink.calls[0].ok).toBe(true);
    // 默认 fixture 的 usage 是旧形状（无 cacheRead/totalTokens/cost），映射判缺失
    expect(sink.calls[0].usage).toBeUndefined();
  });

  it("15. llm_call_sink：失败行 ok=false 带首段错误码无 usage；quota_exceeded / model_not_configured 不落行", async () => {
    const sink = makeSink();
    const ctx = makeCtx({ quota: { max_agent_calls: 1 } });
    const handle = await serve(
      {
        ...makeDeps(makeMapping(), { FAKE_PI_EXIT: "1" }),
        llm_call_sink: sink,
      },
      ctx,
    );

    const failed = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(failed.ok).toBe(false);
    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0]).toMatchObject({ ok: false, error: "agent_failed" });
    expect(sink.calls[0].usage).toBeUndefined();

    // 配额超限在 dispatch 层拦截、未消耗 LLM，不落行（决策 3）
    const over = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(over).toMatchObject({ ok: false, error: "quota_exceeded" });
    expect(sink.calls.length).toBe(1);
    await handle.close();
    handles.pop();

    // model_not_configured 同样在 dispatch 层拦截，不落行
    const sink2 = makeSink();
    const bare = await serve(
      { ...makeDeps(makeMapping()), llm_call_sink: sink2 },
      makeCtx({ pi_agent_dir: undefined }),
    );
    const rejected = await call(bare.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(rejected).toMatchObject({ ok: false, error: "model_not_configured" });
    expect(sink2.calls.length).toBe(0);
  });

  it("16. llm_call_sink 抛异常：op 返回不受影响（调用点防御 try/catch 消化）", async () => {
    const handle = await serve(
      { ...makeDeps(makeMapping()), llm_call_sink: makeSink(true) },
      makeCtx(),
    );

    const ok = await call(handle.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(ok).toMatchObject({ ok: true, output: "fake 回复" });
    await handle.close();
    handles.pop();

    // 失败路径上 sink 抛错同样不影响错误返回
    const handle2 = await serve(
      {
        ...makeDeps(makeMapping(), { FAKE_PI_EXIT: "1" }),
        llm_call_sink: makeSink(true),
      },
      makeCtx(),
    );
    const failed = await call(handle2.endpoint, {
      op: "agent",
      skills: ["s1"],
      input: "x",
    });
    expect(failed.ok).toBe(false);
    expect((failed as { error: string }).error.startsWith("agent_failed")).toBe(
      true,
    );
  });
});
