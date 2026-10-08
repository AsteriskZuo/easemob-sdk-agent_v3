import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvError } from "@asterisk/agent-env";
import { resolveServerConfig } from "../src/index.js";

let tmpDir: string;
let workspace: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-server-config-test-"));
  workspace = join(tmpDir, "workspace");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 必填齐全的最小 envMap（config.ts 不验路径存在性，那是自检职责） */
function requiredEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AGENT_WORKSPACE: workspace,
    AGENT_PI_CLI_PATH: "/fake/pi",
    AGENT_PI_AGENT_DIR: "/fake/agent-dir",
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    ...over,
  };
}

describe("resolveServerConfig", () => {
  it("必填缺失 → EnvError 且 message 含全部缺失变量名", () => {
    let caught: unknown;
    try {
      resolveServerConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvError);
    const message = (caught as Error).message;
    for (const name of [
      "AGENT_WORKSPACE",
      "AGENT_PI_CLI_PATH",
      "AGENT_PI_AGENT_DIR",
      "PATH",
      "HOME",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("全默认：给齐必填 → 各默认值正确，pi_env = { PATH, HOME }", () => {
    const config = resolveServerConfig(requiredEnv());
    expect(config.workspace).toBe(workspace);
    expect(config.log_level).toBe("info");
    expect(config.log_enabled).toBe(true);
    expect(config.hop_limit).toBe(8);
    expect(config.task_concurrency).toBe(4);
    expect(config.result_concurrency).toBe(16);
    expect(config.task_timeout_minutes).toBe(60);
    expect(config.max_agent_calls).toBe(20);
    expect(config.pi_cli_path).toBe("/fake/pi");
    expect(config.pi_agent_dir).toBe("/fake/agent-dir");
    expect(config.pi_env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
    });
  });

  it("config.json 兜底：文件值生效；同名环境变量优先；非法 JSON / 类型不符 → EnvError", () => {
    // 文件值兜底
    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({ AGENT_TASK_CONCURRENCY: 9 }),
      { flag: "wx" },
    );
    expect(resolveServerConfig(requiredEnv()).task_concurrency).toBe(9);

    // 同名环境变量优先
    expect(
      resolveServerConfig(requiredEnv({ AGENT_TASK_CONCURRENCY: "7" }))
        .task_concurrency,
    ).toBe(7);

    // 非法 JSON → EnvError
    writeFileSync(join(workspace, "config.json"), "{ not json");
    expect(() => resolveServerConfig(requiredEnv())).toThrow(EnvError);

    // 值类型不符（期望 number 给了 string）→ EnvError
    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({ AGENT_TASK_CONCURRENCY: "nine" }),
    );
    let caught: unknown;
    try {
      resolveServerConfig(requiredEnv());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvError);
    expect((caught as Error).message).toContain("AGENT_TASK_CONCURRENCY");
  });

  it("数字越界 / 非法布尔 / 非法 log_level → EnvError", () => {
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_HOP_LIMIT: "0" })),
    ).toThrow(EnvError);
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_LOG_ENABLED: "yes" })),
    ).toThrow(EnvError);
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_LOG_LEVEL: "verbose" })),
    ).toThrow(EnvError);
  });

  it("AGENT_WORKSPACE 只能来自环境变量（config.json 里写无效）", () => {
    // envMap 无 AGENT_WORKSPACE：即使别处有 config.json 也无从定位 → 必填缺失
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_WORKSPACE: undefined })),
    ).toThrow(/AGENT_WORKSPACE/);
  });

  it("console_port：默认 6100；env/config.json 覆盖；非法值 → EnvError", () => {
    expect(resolveServerConfig(requiredEnv()).console_port).toBe(6100);
    expect(
      resolveServerConfig(requiredEnv({ AGENT_CONSOLE_PORT: "6200" }))
        .console_port,
    ).toBe(6200);
    // 0 = 随机（测试用），min 0 合法
    expect(
      resolveServerConfig(requiredEnv({ AGENT_CONSOLE_PORT: "0" }))
        .console_port,
    ).toBe(0);

    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({ AGENT_CONSOLE_PORT: 6300 }),
      { flag: "wx" },
    );
    expect(resolveServerConfig(requiredEnv()).console_port).toBe(6300);

    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_CONSOLE_PORT: "-1" })),
    ).toThrow(EnvError);
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_CONSOLE_PORT: "abc" })),
    ).toThrow(EnvError);
  });

  it("console_static_dir：默认 undefined；env/config.json 生效；trim 空 = 未设置", () => {
    expect(
      resolveServerConfig(requiredEnv()).console_static_dir,
    ).toBeUndefined();

    expect(
      resolveServerConfig(
        requiredEnv({ AGENT_CONSOLE_STATIC_DIR: "/opt/console/dist" }),
      ).console_static_dir,
    ).toBe("/opt/console/dist");

    // trim 后空串 = 未设置
    expect(
      resolveServerConfig(requiredEnv({ AGENT_CONSOLE_STATIC_DIR: "   " }))
        .console_static_dir,
    ).toBeUndefined();

    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({ AGENT_CONSOLE_STATIC_DIR: "/srv/console" }),
      { flag: "wx" },
    );
    expect(resolveServerConfig(requiredEnv()).console_static_dir).toBe(
      "/srv/console",
    );

    // config.json 类型不符 → EnvError
    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({ AGENT_CONSOLE_STATIC_DIR: 42 }),
    );
    expect(() => resolveServerConfig(requiredEnv())).toThrow(EnvError);
  });

  it("bootstrap_admin：两键成对 → 注入；都缺省 → undefined；只给一个 → EnvError", () => {
    expect(resolveServerConfig(requiredEnv()).bootstrap_admin).toBeUndefined();

    const config = resolveServerConfig(
      requiredEnv({
        AGENT_ADMIN_USERNAME: "root",
        AGENT_ADMIN_PASSWORD: "root-pass",
      }),
    );
    expect(config.bootstrap_admin).toEqual({
      username: "root",
      password: "root-pass",
    });

    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_ADMIN_USERNAME: "root" })),
    ).toThrow(/成对设置/);
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_ADMIN_PASSWORD: "root-pass" })),
    ).toThrow(/成对设置/);
  });
});
