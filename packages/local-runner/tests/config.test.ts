import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ConfigError, loadConfig } from "../src/config.js";

/**
 * 测试夹具：在临时目录里搭出最小可用的本地运行目录结构：
 *   root/
 *     config.json            # 配置文件（由各用例写入）
 *     pkg/agent-package.json # 业务包清单（programs.main → dist/apps/main/index.js）
 *     pkg/dist/apps/main/index.js
 *     tools/wecom-notify/    # 工具资产目录
 *     skills/review-guide/   # skill 资产目录
 *     pi/agent/models.json   # pi 配置目录
 */
let root: string;

const ENTRY_REL = "dist/apps/main/index.js";

function writeJson(relPath: string, value: unknown): void {
  writeFileSync(path.join(root, relPath), JSON.stringify(value, null, 2));
}

function writeConfig(value: unknown): string {
  const configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
  return configPath;
}

/** 最小合法配置（仅必填项）。 */
function minimalConfig(): Record<string, unknown> {
  return {
    business_id: "b_review",
    channel_id: "jira:HIM-1",
    entry_program: "main",
    model: "qwen/qwen3.8-max",
    assets: { package: { path: "./pkg" } },
    quota: { timeout_minutes: 30, max_agent_calls: 50 },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "local-runner-config-"));
  mkdirSync(path.join(root, "pkg", "dist", "apps", "main"), {
    recursive: true,
  });
  writeJson("pkg/agent-package.json", {
    programs: { main: ENTRY_REL },
  });
  writeFileSync(path.join(root, "pkg", ENTRY_REL), "// main\n");
  mkdirSync(path.join(root, "tools", "wecom-notify"), { recursive: true });
  mkdirSync(path.join(root, "skills", "review-guide"), { recursive: true });
  mkdirSync(path.join(root, "pi", "agent"), { recursive: true });
  writeJson("pi/agent/models.json", { providers: {} });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadConfig 合法配置", () => {
  it("最小配置：缺省项全部填充，workspace_root 缺省为配置目录/workspace", () => {
    const configPath = writeConfig(minimalConfig());

    const config = loadConfig(configPath);

    expect(config).toEqual({
      business_id: "b_review",
      channel_id: "jira:HIM-1",
      prompt: "",
      entry_program: "main",
      model: "qwen/qwen3.8-max",
      assets: {
        package: { path: path.join(root, "pkg") },
        tools: [],
        skills: [],
      },
      vars: {},
      secrets: {},
      pi_agent_dir: undefined,
      pi_cli_path: null,
      pi_env: {},
      quota: { timeout_minutes: 30, max_agent_calls: 50 },
      workspace_root: path.join(root, "workspace"),
      stub_tools: [],
      stub_outputs: {},
    });
  });

  it("完整配置：相对路径基于配置文件所在目录解析为绝对路径", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      prompt: "审查工单",
      assets: {
        package: { path: "./pkg" },
        tools: [{ name: "wecom-notify", path: "./tools/wecom-notify" }],
        skills: [{ name: "review-guide", path: "./skills/review-guide" }],
      },
      vars: { JIRA_PROJECT: "HIM" },
      secrets: { JIRA_PASSWORD: "s3cret" },
      pi_agent_dir: "./pi/agent",
      pi_cli_path: "/usr/local/bin/pi",
      pi_env: { PI_LOG_LEVEL: "debug" },
      workspace_root: "./ws",
      stub_tools: ["wecom-notify"],
      stub_outputs: { "wecom-notify": { delivered: true } },
    });

    const config = loadConfig(configPath);

    expect(config.prompt).toBe("审查工单");
    expect(config.assets.tools).toEqual([
      { name: "wecom-notify", path: path.join(root, "tools", "wecom-notify") },
    ]);
    expect(config.assets.skills).toEqual([
      { name: "review-guide", path: path.join(root, "skills", "review-guide") },
    ]);
    expect(config.vars).toEqual({ JIRA_PROJECT: "HIM" });
    expect(config.secrets).toEqual({ JIRA_PASSWORD: "s3cret" });
    expect(config.pi_agent_dir).toBe(path.join(root, "pi", "agent"));
    expect(config.pi_cli_path).toBe("/usr/local/bin/pi");
    expect(config.pi_env).toEqual({ PI_LOG_LEVEL: "debug" });
    expect(config.workspace_root).toBe(path.join(root, "ws"));
    expect(config.stub_tools).toEqual(["wecom-notify"]);
    expect(config.stub_outputs).toEqual({
      "wecom-notify": { delivered: true },
    });
  });

  it("绝对路径原样保留", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      assets: { package: { path: path.join(root, "pkg") } },
      workspace_root: path.join(root, "abs-ws"),
    });

    const config = loadConfig(configPath);

    expect(config.assets.package.path).toBe(path.join(root, "pkg"));
    expect(config.workspace_root).toBe(path.join(root, "abs-ws"));
  });

  it("pi_cli_path 显式为 null 时按缺省解析处理", () => {
    const configPath = writeConfig({ ...minimalConfig(), pi_cli_path: null });

    expect(loadConfig(configPath).pi_cli_path).toBeNull();
  });
});

describe("loadConfig 文件级错误", () => {
  it("配置文件不存在时报 ConfigError", () => {
    expect(() => loadConfig(path.join(root, "nope.json"))).toThrow(ConfigError);
    expect(() => loadConfig(path.join(root, "nope.json"))).toThrow(
      /配置文件不存在/,
    );
  });

  it("配置文件不是合法 JSON 时报错", () => {
    const configPath = writeConfig("{ not json");

    expect(() => loadConfig(configPath)).toThrow(ConfigError);
    expect(() => loadConfig(configPath)).toThrow(/不是合法 JSON/);
  });

  it("顶层不是对象时报错", () => {
    const configPath = writeConfig([1, 2, 3]);

    expect(() => loadConfig(configPath)).toThrow(/顶层必须为 JSON 对象/);
  });
});

describe("loadConfig 必填项与形状校验", () => {
  it.each([
    "business_id",
    "channel_id",
    "entry_program",
    "model",
    "assets",
    "quota",
  ])("缺少必填字段 %s 时报错", (key) => {
    const raw = minimalConfig();
    delete raw[key];
    const configPath = writeConfig(raw);

    expect(() => loadConfig(configPath)).toThrow(ConfigError);
    expect(() => loadConfig(configPath)).toThrow(new RegExp(key));
  });

  it.each(["business_id", "channel_id", "entry_program", "model"])(
    "必填字段 %s 为空字符串时报错",
    (key) => {
      const configPath = writeConfig({ ...minimalConfig(), [key]: "" });

      expect(() => loadConfig(configPath)).toThrow(/非空字符串/);
    },
  );

  it("prompt 非字符串时报错", () => {
    const configPath = writeConfig({ ...minimalConfig(), prompt: 42 });

    expect(() => loadConfig(configPath)).toThrow(/config\.prompt/);
  });

  it.each(["vars", "secrets", "pi_env"])("%s 值非字符串时报错", (key) => {
    const configPath = writeConfig({ ...minimalConfig(), [key]: { A: 1 } });

    expect(() => loadConfig(configPath)).toThrow(new RegExp(`config\\.${key}`));
  });

  it("quota 数值必须为大于 0 的有限数", () => {
    for (const quota of [
      { timeout_minutes: 0, max_agent_calls: 50 },
      { timeout_minutes: 30, max_agent_calls: -1 },
      { timeout_minutes: "30", max_agent_calls: 50 },
      { timeout_minutes: 30 },
    ]) {
      const configPath = writeConfig({ ...minimalConfig(), quota });
      expect(() => loadConfig(configPath)).toThrow(ConfigError);
    }
  });

  it("stub_tools 必须为字符串数组", () => {
    for (const stubTools of ["wecom-notify", [""], [1]]) {
      const configPath = writeConfig({
        ...minimalConfig(),
        stub_tools: stubTools,
      });
      expect(() => loadConfig(configPath)).toThrow(/stub_tools/);
    }
  });

  it("stub_outputs 必须为对象", () => {
    const configPath = writeConfig({ ...minimalConfig(), stub_outputs: [] });

    expect(() => loadConfig(configPath)).toThrow(/stub_outputs/);
  });
});

describe("loadConfig 未知字段", () => {
  it("顶层未知字段报错", () => {
    const configPath = writeConfig({ ...minimalConfig(), buisness_id: "typo" });

    expect(() => loadConfig(configPath)).toThrow(/未知字段 "buisness_id"/);
  });

  it("quota 内未知字段报错", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      quota: { timeout_minutes: 30, max_agent_calls: 50, retries: 3 },
    });

    expect(() => loadConfig(configPath)).toThrow(/未知字段 "retries"/);
  });

  it("tools 条目内未知字段报错", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      assets: {
        package: { path: "./pkg" },
        tools: [{ name: "wecom-notify", path: "./tools/wecom-notify", tag: 1 }],
      },
    });

    expect(() => loadConfig(configPath)).toThrow(/未知字段 "tag"/);
  });
});

describe("loadConfig 资产存在性校验", () => {
  it("package 路径不存在时报错", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      assets: { package: { path: "./no-such-dir" } },
    });

    expect(() => loadConfig(configPath)).toThrow(/路径不存在/);
  });

  it("package 路径不是目录时报错", () => {
    writeFileSync(path.join(root, "a-file"), "x");
    const configPath = writeConfig({
      ...minimalConfig(),
      assets: { package: { path: "./a-file" } },
    });

    expect(() => loadConfig(configPath)).toThrow(/不是目录/);
  });

  it("package 目录缺少 agent-package.json 时报错", () => {
    mkdirSync(path.join(root, "empty-pkg"), { recursive: true });
    const configPath = writeConfig({
      ...minimalConfig(),
      assets: { package: { path: "./empty-pkg" } },
    });

    expect(() => loadConfig(configPath)).toThrow(/agent-package\.json/);
  });

  it("agent-package.json 不是合法 JSON 时报错", () => {
    writeFileSync(path.join(root, "pkg", "agent-package.json"), "{ broken");
    const configPath = writeConfig(minimalConfig());

    expect(() => loadConfig(configPath)).toThrow(/agent-package\.json 不是合法 JSON/);
  });

  it("programs 中不存在 entry_program 时报错", () => {
    writeJson("pkg/agent-package.json", { programs: { other: ENTRY_REL } });
    const configPath = writeConfig(minimalConfig());

    expect(() => loadConfig(configPath)).toThrow(
      /programs 中不存在程序 "main"/,
    );
  });

  it("entry_program 指向非 .js 产物时报错", () => {
    writeJson("pkg/agent-package.json", {
      programs: { main: "dist/apps/main/index.ts" },
    });
    const configPath = writeConfig(minimalConfig());

    expect(() => loadConfig(configPath)).toThrow(/必须指向 \.js 产物/);
  });

  it("entry_program 指向的产物文件不存在时提示先构建", () => {
    rmSync(path.join(root, "pkg", ENTRY_REL));
    const configPath = writeConfig(minimalConfig());

    expect(() => loadConfig(configPath)).toThrow(/请先构建业务包/);
  });

  it("tools/skills 条目路径不存在时报错", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      assets: {
        package: { path: "./pkg" },
        tools: [{ name: "wecom-notify", path: "./tools/nope" }],
      },
    });

    expect(() => loadConfig(configPath)).toThrow(/路径不存在/);
  });
});

describe("loadConfig pi_agent_dir 校验", () => {
  it("pi_agent_dir 目录不存在时报错", () => {
    const configPath = writeConfig({
      ...minimalConfig(),
      pi_agent_dir: "./pi/nope",
    });

    expect(() => loadConfig(configPath)).toThrow(/pi_agent_dir/);
  });

  it("pi_agent_dir 缺少 models.json 时报错", () => {
    mkdirSync(path.join(root, "pi", "empty"), { recursive: true });
    const configPath = writeConfig({
      ...minimalConfig(),
      pi_agent_dir: "./pi/empty",
    });

    expect(() => loadConfig(configPath)).toThrow(/models\.json/);
  });
});
