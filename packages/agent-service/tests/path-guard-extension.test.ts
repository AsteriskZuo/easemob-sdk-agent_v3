import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface CapturedHandlers {
  [event: string]: (event: unknown) => unknown;
}

/** 模拟 pi 的 ExtensionAPI：捕获 on 注册的 handler */
function makeFakePi() {
  const handlers: CapturedHandlers = {};
  return {
    handlers,
    on(event: string, handler: (event: unknown) => unknown): void {
      handlers[event] = handler;
    },
  };
}

type PathGuardFactory = (pi: ReturnType<typeof makeFakePi>) => void;

async function loadFactory(): Promise<PathGuardFactory> {
  const guardPath = fileURLToPath(
    new URL("../../extensions/path-guard.js", import.meta.url),
  );
  const mod = (await import(pathToFileURL(guardPath).href)) as {
    default: PathGuardFactory;
  };
  return mod.default;
}

/** 守卫 handler 的返回（放行 = undefined；拦截 = { block: true, reason }） */
type GuardResult = { block?: boolean; reason?: string } | undefined;

describe("平台路径守卫 extension", () => {
  // 守卫以 process.cwd() 为工作区根（pi 子进程 cwd = run workspace）；
  // 测试进程 cwd = 本包根目录，工作区内/外路径都相对它构造
  const cwd = process.cwd();

  async function callGuard(event: unknown): Promise<GuardResult> {
    const factory = await loadFactory();
    const pi = makeFakePi();
    factory(pi);
    expect(typeof pi.handlers.tool_call).toBe("function");
    return pi.handlers.tool_call(event) as GuardResult;
  }

  it("工作区内相对路径 → 放行（read/grep/glob 均不 block）", async () => {
    expect(
      await callGuard({ toolName: "read", input: { path: "src/index.ts" } }),
    ).toBeUndefined();
    expect(
      await callGuard({
        toolName: "grep",
        input: { pattern: "x", path: "src" },
      }),
    ).toBeUndefined();
    expect(
      await callGuard({ toolName: "glob", input: { path: "." } }),
    ).toBeUndefined();
  });

  it("工作区内绝对路径 → 放行", async () => {
    expect(
      await callGuard({
        toolName: "read",
        input: { path: join(cwd, "src", "index.ts") },
      }),
    ).toBeUndefined();
  });

  it("越界绝对路径 → block 且 reason 带原始路径", async () => {
    const outside = mkdtempSync(join(tmpdir(), "path-guard-outside-"));
    try {
      const result = (await callGuard({
        toolName: "read",
        input: { path: outside },
      })) as { block: boolean; reason: string };
      expect(result.block).toBe(true);
      expect(result.reason).toContain("路径越出工作区");
      expect(result.reason).toContain(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("../ 穿越 → block", async () => {
    const result = (await callGuard({
      toolName: "read",
      input: { path: "../outside.txt" },
    })) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("路径越出工作区");
  });

  it("缺 path / path 非字符串 → block 缺少 path 参数", async () => {
    for (const input of [{}, { path: 42 }, undefined]) {
      const result = (await callGuard({ toolName: "read", input })) as {
        block: boolean;
        reason: string;
      };
      expect(result.block).toBe(true);
      expect(result.reason).toBe("path-guard: 缺少 path 参数");
    }
  });

  it("非白名单工具（如 bash）→ block", async () => {
    const result = (await callGuard({
      toolName: "bash",
      input: { command: "ls" },
    })) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("非白名单工具");
  });

  it("判定自身异常（input.path 是抛错的 getter）→ fail-closed block", async () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "path", {
      get() {
        throw new Error("boom");
      },
    });
    const result = (await callGuard({ toolName: "read", input })) as {
      block: boolean;
    };
    expect(result.block).toBe(true);
  });
});
