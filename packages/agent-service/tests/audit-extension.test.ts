import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface CapturedHandlers {
  [event: string]: (event: unknown) => void;
}

/** 模拟 pi 的 ExtensionAPI：捕获 on 注册的 handler */
function makeFakePi() {
  const handlers: CapturedHandlers = {};
  return {
    handlers,
    on(event: string, handler: (event: unknown) => void): void {
      handlers[event] = handler;
    },
  };
}

type AuditFactory = (pi: ReturnType<typeof makeFakePi>) => void;

async function loadFactory(): Promise<AuditFactory> {
  const auditPath = fileURLToPath(
    new URL("../../extensions/audit.js", import.meta.url),
  );
  const mod = (await import(pathToFileURL(auditPath).href)) as {
    default: AuditFactory;
  };
  return mod.default;
}

describe("平台审计 extension", () => {
  let root: string;
  let savedAuditPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "audit-ext-test-"));
    savedAuditPath = process.env.AUDIT_LOG_PATH;
  });

  afterEach(() => {
    if (savedAuditPath === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = savedAuditPath;
    rmSync(root, { recursive: true, force: true });
  });

  it("handler 把 {ts, provider, model, body} 追加为 JSONL 一行（父目录自动创建）", async () => {
    const target = join(root, "audit", "llm-requests.jsonl");
    process.env.AUDIT_LOG_PATH = target;

    const factory = await loadFactory();
    const pi = makeFakePi();
    factory(pi);
    expect(typeof pi.handlers.before_provider_request).toBe("function");

    const payload = { messages: [{ role: "user", content: "秘密内容" }] };
    pi.handlers.before_provider_request({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      payload,
    });
    pi.handlers.before_provider_request({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      payload: { messages: [] },
    });

    const lines = readFileSync(target, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(typeof rec.ts).toBe("string");
    // ISO 时间戳形态
    expect(new Date(rec.ts as string).toISOString()).toBe(rec.ts);
    expect(rec.provider).toBe("deepseek");
    expect(rec.model).toBe("deepseek-v4-pro");
    expect(rec.body).toEqual(payload);
  });

  it("fail-closed：写盘失败（父路径是普通文件）→ handler 抛错阻断请求", async () => {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "不是目录");
    process.env.AUDIT_LOG_PATH = join(blocker, "audit.jsonl");

    const factory = await loadFactory();
    const pi = makeFakePi();
    factory(pi);
    expect(() =>
      pi.handlers.before_provider_request({
        provider: "p",
        model: "m",
        payload: {},
      }),
    ).toThrow();
  });
});
