import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvError } from "@asteriskzuo/agent-env";
import { resolveServerConfig } from "../src/index.js";

const TEST_PI_MODELS = {
  providers: {
    "test-provider": {
      baseUrl: "https://test-provider.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-fake-placeholder",
      models: [{ id: "model-a" }],
    },
  },
};

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

/** 可解析的基础 envMap（config.ts 不验路径存在性，那是自检职责） */
function requiredEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AGENT_WORKSPACE: workspace,
    AGENT_PI_CLI_PATH: "/fake/pi",
    AGENT_PI_AGENT_DIR: "/fake/agent-dir",
    AGENT_PI_MODELS: JSON.stringify(TEST_PI_MODELS),
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    ...over,
  };
}

/** config.json 路径（{workspace}/platform/config.json），保证父目录已建 */
function configPath(): string {
  const dir = join(workspace, "platform");
  mkdirSync(dir, { recursive: true });
  return join(dir, "config.json");
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
    for (const name of ["AGENT_WORKSPACE", "AGENT_PI_MODELS", "PATH", "HOME"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("AGENT_PI_AGENT_DIR");
    expect(message).not.toContain("AGENT_PI_CLI_PATH");
  });

  it("常规默认值与显式 Pi 路径生效，pi_env = { PATH, HOME }", () => {
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
    expect(config.pi_models).toEqual(TEST_PI_MODELS);
    expect(config.pi_env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
    });
    expect(config.npm_registry).toBe("https://registry.npmjs.org/");
  });

  it("两个 Pi 路径缺省 → CLI 从 npm 解析，agent dir 归 platform/cache", () => {
    const config = resolveServerConfig(
      requiredEnv({
        AGENT_PI_CLI_PATH: undefined,
        AGENT_PI_AGENT_DIR: undefined,
      }),
    );
    // 本仓库已安装该依赖（yarn.lock 锁定），解析必命中包内 bin
    expect(config.pi_cli_path).toContain("@earendil-works/pi-coding-agent");
    expect(config.pi_cli_path.endsWith("cli.js")).toBe(true);
    expect(config.pi_agent_dir).toBe(
      join(workspace, "platform", "cache", "pi", "agent"),
    );
  });

  it("AGENT_PI_MODELS：文件 object 生效，env JSON 整体覆盖且不深合并", () => {
    const fileModels = {
      providers: {
        "file-provider": {
          baseUrl: "https://file.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-file-placeholder",
          models: [{ id: "file-model" }],
        },
      },
    };
    writeFileSync(
      configPath(),
      JSON.stringify({ AGENT_PI_MODELS: fileModels }),
    );
    const fromFile = resolveServerConfig(
      requiredEnv({ AGENT_PI_MODELS: undefined }),
    );
    expect(fromFile.pi_models).toEqual(fileModels);

    const envModels = {
      providers: {
        "env-provider": {
          baseUrl: "https://env.example.com/v1",
          api: "anthropic-messages",
          apiKey: "sk-env-placeholder",
          models: [{ id: "env-model" }],
        },
      },
    };
    const fromEnv = resolveServerConfig(
      requiredEnv({ AGENT_PI_MODELS: JSON.stringify(envModels) }),
    );
    expect(fromEnv.pi_models).toEqual(envModels);
    expect(Object.keys(fromEnv.pi_models.providers)).toEqual(["env-provider"]);
  });

  it("AGENT_PI_MODELS 非法 JSON/类型/结构均失败，错误不泄漏 secret", () => {
    const secret = "sk-sentinel-must-not-leak";
    for (const value of [
      `{"providers":"${secret}"`,
      "[]",
      JSON.stringify({
        providers: {
          p: {
            baseUrl: "https://p.example.com/v1",
            api: "openai-completions",
            apiKey: secret,
            models: [],
          },
        },
      }),
    ]) {
      let message = "";
      try {
        resolveServerConfig(requiredEnv({ AGENT_PI_MODELS: value }));
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("AGENT_PI_MODELS");
      expect(message).not.toContain(secret);
    }

    writeFileSync(
      configPath(),
      JSON.stringify({ AGENT_PI_MODELS: "not-an-object" }),
    );
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_PI_MODELS: undefined })),
    ).toThrow(/AGENT_PI_MODELS/);
  });

  it("npm_registry：默认官方；env 覆盖；config.json 兜底", () => {
    expect(
      resolveServerConfig(
        requiredEnv({ AGENT_NPM_REGISTRY: "https://npm.mirror.internal/" }),
      ).npm_registry,
    ).toBe("https://npm.mirror.internal/");

    writeFileSync(
      configPath(),
      JSON.stringify({ AGENT_NPM_REGISTRY: "https://npm.from-file/" }),
      { flag: "wx" },
    );
    expect(resolveServerConfig(requiredEnv()).npm_registry).toBe(
      "https://npm.from-file/",
    );
  });

  it("config.json 兜底：文件值生效；同名环境变量优先；非法 JSON / 类型不符 → EnvError", () => {
    // 文件值兜底
    writeFileSync(configPath(), JSON.stringify({ AGENT_TASK_CONCURRENCY: 9 }), {
      flag: "wx",
    });
    expect(resolveServerConfig(requiredEnv()).task_concurrency).toBe(9);

    // 同名环境变量优先
    expect(
      resolveServerConfig(requiredEnv({ AGENT_TASK_CONCURRENCY: "7" }))
        .task_concurrency,
    ).toBe(7);

    // 非法 JSON → EnvError
    writeFileSync(configPath(), "{ not json");
    expect(() => resolveServerConfig(requiredEnv())).toThrow(EnvError);

    // 值类型不符（期望 number 给了 string）→ EnvError
    writeFileSync(
      configPath(),
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

    writeFileSync(configPath(), JSON.stringify({ AGENT_CONSOLE_PORT: 6300 }), {
      flag: "wx",
    });
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
      configPath(),
      JSON.stringify({ AGENT_CONSOLE_STATIC_DIR: "/srv/console" }),
      { flag: "wx" },
    );
    expect(resolveServerConfig(requiredEnv()).console_static_dir).toBe(
      "/srv/console",
    );

    // config.json 类型不符 → EnvError
    writeFileSync(
      configPath(),
      JSON.stringify({ AGENT_CONSOLE_STATIC_DIR: 42 }),
    );
    expect(() => resolveServerConfig(requiredEnv())).toThrow(EnvError);
  });

  it("入口适配器配置：webhook_port 默认 6200；两开关默认 webhook 开 / jira-polling 关；env/config.json 覆盖", () => {
    const defaults = resolveServerConfig(requiredEnv());
    expect(defaults.webhook_port).toBe(6200);
    expect(defaults.entry_webhook_enabled).toBe(true);
    expect(defaults.entry_jira_polling_enabled).toBe(false);

    const overridden = resolveServerConfig(
      requiredEnv({
        AGENT_WEBHOOK_PORT: "0", // 0 = 随机（测试用），min 0 合法
        AGENT_ENTRY_WEBHOOK_ENABLED: "false",
        AGENT_ENTRY_JIRA_POLLING_ENABLED: "true",
      }),
    );
    expect(overridden.webhook_port).toBe(0);
    expect(overridden.entry_webhook_enabled).toBe(false);
    expect(overridden.entry_jira_polling_enabled).toBe(true);

    // config.json 兜底（env 未设置时）
    writeFileSync(
      configPath(),
      JSON.stringify({
        AGENT_WEBHOOK_PORT: 6300,
        AGENT_ENTRY_JIRA_POLLING_ENABLED: true,
      }),
      { flag: "wx" },
    );
    const fromFile = resolveServerConfig(requiredEnv());
    expect(fromFile.webhook_port).toBe(6300);
    expect(fromFile.entry_jira_polling_enabled).toBe(true);

    // 非法值 → EnvError
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_WEBHOOK_PORT: "-1" })),
    ).toThrow(EnvError);
    expect(() =>
      resolveServerConfig(requiredEnv({ AGENT_ENTRY_WEBHOOK_ENABLED: "yes" })),
    ).toThrow(EnvError);
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
