import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { LocalRunConfig } from "../src/config.js";
import {
  applyStubTools,
  assembleRunContext,
} from "../src/local-context-loader.js";

/**
 * 本地装配器测试（spec §10.1）：
 * 在临时目录构造 package/tool/skill 三类资产（agent-package.json、dist 假 .js、SKILL.md），
 * 覆盖全字段装配映射、programs 并集同名首中、skills 并集同名首中去重、
 * pi_agent_dir 有/无、stub 命中替换与文件生成、stub 拼写错误抛错、stub_outputs 缺省 {}。
 */

let dir: string;

/** 写文件（自动建父目录）。 */
function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "local-runner-loader-"));

  // package 资产：含入口 main、编排保留程序、与 tool-a 同名的 shared
  write(
    "pkg/agent-package.json",
    JSON.stringify({
      name: "jira-ticket-review",
      programs: {
        main: "dist/main.js",
        "check-input": "dist/check-input.js",
        "check-output": "dist/check-output.js",
        shared: "dist/pkg-shared.js",
      },
    }),
  );
  for (const f of ["main.js", "check-input.js", "check-output.js", "pkg-shared.js"]) {
    write(`pkg/dist/${f}`, "// fake\n");
  }

  // tool 资产 a：wecom-notify + 与 package 同名的 shared（应被 package 首中压过）
  write(
    "tool-a/agent-package.json",
    JSON.stringify({
      name: "tool-a",
      programs: { "wecom-notify": "dist/notify.js", shared: "dist/tool-shared.js" },
    }),
  );
  write("tool-a/dist/notify.js", "// fake\n");
  write("tool-a/dist/tool-shared.js", "// fake\n");

  // tool 资产 b：jira-comment
  write(
    "tool-b/agent-package.json",
    JSON.stringify({
      name: "tool-b",
      programs: { "jira-comment": "dist/comment.js" },
    }),
  );
  write("tool-b/dist/comment.js", "// fake\n");

  // skill 资产 a：alpha + dup；not-a-skill 无 SKILL.md 不算技能
  write("skill-a/alpha/SKILL.md", "# alpha\n");
  write("skill-a/dup/SKILL.md", "# dup from a\n");
  mkdirSync(path.join(dir, "skill-a/not-a-skill"), { recursive: true });

  // skill 资产 b：beta + dup（同名，应被 skill-a 首中压过）
  write("skill-b/beta/SKILL.md", "# beta\n");
  write("skill-b/dup/SKILL.md", "# dup from b\n");

  // pi 配置目录
  write("pi/agent/models.json", "{}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造完整 LocalRunConfig（默认值可被 overrides 覆盖）。 */
function makeConfig(overrides: Partial<LocalRunConfig> = {}): LocalRunConfig {
  return {
    business_id: "jira-ticket-review",
    channel_id: "jira:HIM-12345",
    prompt: "审查工单",
    entry_program: "main",
    model: "qwen/qwen3.8-max",
    assets: {
      package: { path: path.join(dir, "pkg") },
      tools: [
        { name: "tool-a", path: path.join(dir, "tool-a") },
        { name: "tool-b", path: path.join(dir, "tool-b") },
      ],
      skills: [
        { name: "skill-a", path: path.join(dir, "skill-a") },
        { name: "skill-b", path: path.join(dir, "skill-b") },
      ],
    },
    vars: { JIRA_PROJECT: "HIM" },
    secrets: { JIRA_PASSWORD: "s3cret" },
    pi_cli_path: null,
    pi_env: {},
    quota: { timeout_minutes: 30, max_agent_calls: 50 },
    workspace_root: path.join(dir, "workspace"),
    stub_tools: [],
    stub_outputs: {},
    ...overrides,
  };
}

describe("assembleRunContext", () => {
  it("全字段装配映射：直取字段原样透传，program/programs/skills 按包→工具→skill 装配", () => {
    const config = makeConfig();
    const ctx = assembleRunContext(config);

    expect(ctx.business_id).toBe("jira-ticket-review");
    expect(ctx.channel_id).toBe("jira:HIM-12345");
    expect(ctx.prompt).toBe("审查工单");
    expect(ctx.model).toBe("qwen/qwen3.8-max");
    expect(ctx.vars).toEqual({ JIRA_PROJECT: "HIM" });
    expect(ctx.secrets).toEqual({ JIRA_PASSWORD: "s3cret" });
    expect(ctx.quota).toEqual({ timeout_minutes: 30, max_agent_calls: 50 });
    expect(ctx.program).toBe(path.join(dir, "pkg", "dist", "main.js"));
  });

  it("programs 并集：覆盖全部资产，同名按资产顺序首个命中（包压工具）", () => {
    const ctx = assembleRunContext(makeConfig());
    expect(ctx.programs).toEqual({
      main: path.join(dir, "pkg", "dist", "main.js"),
      "check-input": path.join(dir, "pkg", "dist", "check-input.js"),
      "check-output": path.join(dir, "pkg", "dist", "check-output.js"),
      // 同名 shared：package 在前首中，tool-a 的被压过
      shared: path.join(dir, "pkg", "dist", "pkg-shared.js"),
      "wecom-notify": path.join(dir, "tool-a", "dist", "notify.js"),
      "jira-comment": path.join(dir, "tool-b", "dist", "comment.js"),
    });
  });

  it("skills 并集：全部 skill 资产的技能并集，同名首个命中去重，无 SKILL.md 的目录不算", () => {
    const ctx = assembleRunContext(makeConfig());
    expect(ctx.skills).toEqual([
      { name: "alpha", path: path.join(dir, "skill-a", "alpha") },
      // 同名 dup：skill-a 在前首中，skill-b 的被压过
      { name: "dup", path: path.join(dir, "skill-a", "dup") },
      { name: "beta", path: path.join(dir, "skill-b", "beta") },
    ]);
  });

  it("pi_agent_dir：配置时带上，未配置时字段不存在（undefined 语义与平台一致）", () => {
    const withPi = assembleRunContext(
      makeConfig({ pi_agent_dir: path.join(dir, "pi", "agent") }),
    );
    expect(withPi.pi_agent_dir).toBe(path.join(dir, "pi", "agent"));

    const withoutPi = assembleRunContext(makeConfig());
    expect("pi_agent_dir" in withoutPi).toBe(false);
  });

  it("pi_tools：配置时带上，未配置时字段不存在（undefined 语义与平台一致）", () => {
    const withTools = assembleRunContext(
      makeConfig({ pi_tools: ["read", "grep", "glob"] }),
    );
    expect(withTools.pi_tools).toEqual(["read", "grep", "glob"]);

    const withoutTools = assembleRunContext(makeConfig());
    expect("pi_tools" in withoutTools).toBe(false);
  });

  it("entry_program 找不到：抛 resource_not_found（与平台同格式，config 校验的兜底）", () => {
    expect(() =>
      assembleRunContext(makeConfig({ entry_program: "nonexistent" })),
    ).toThrow(/^resource_not_found: program nonexistent$/);
  });

  it("tool 资产清单非法：fail-fast 报错并含清单路径", () => {
    write("tool-a/agent-package.json", "not json");
    expect(() => assembleRunContext(makeConfig())).toThrow(
      /资产清单不是合法 JSON：.*tool-a/,
    );
  });
});

describe("applyStubTools", () => {
  it("命中替换：programs[工具] 指向生成的 stub 文件，其余字段不变且入参不被修改", () => {
    const config = makeConfig({
      stub_tools: ["wecom-notify"],
      stub_outputs: { "wecom-notify": { delivered: true } },
    });
    const ctx = assembleRunContext(config);
    const originalPrograms = { ...ctx.programs };

    const stubbed = applyStubTools(ctx, config);

    const stubPath = path.join(
      dir,
      "workspace",
      ".local-run-stubs",
      "wecom-notify.js",
    );
    expect(stubbed.programs["wecom-notify"]).toBe(stubPath);
    expect(existsSync(stubPath)).toBe(true);
    // stub 文件内联了工具名与固定输出
    const content = readFileSync(stubPath, "utf8");
    expect(content).toContain('STUB_TOOL = "wecom-notify"');
    expect(content).toContain('STUB_OUTPUT = {"delivered":true}');
    // 其余字段不变
    expect(stubbed.program).toBe(ctx.program);
    expect(stubbed.skills).toBe(ctx.skills);
    expect(stubbed.secrets).toBe(ctx.secrets);
    // 不可变更新：入参 context 的 programs 未被修改
    expect(ctx.programs).toEqual(originalPrograms);
    expect(stubbed).not.toBe(ctx);
  });

  it("stub_outputs 未配置的工具：固定输出缺省为 {}", () => {
    const config = makeConfig({ stub_tools: ["jira-comment"] });
    const stubbed = applyStubTools(assembleRunContext(config), config);

    const stubPath = stubbed.programs["jira-comment"];
    const content = readFileSync(stubPath, "utf8");
    expect(content).toContain("STUB_OUTPUT = {}");
  });

  it("stub_tools 拼写错误：抛错并列出可用程序名", () => {
    const config = makeConfig({ stub_tools: ["wecom-notfi"] });
    const ctx = assembleRunContext(config);
    expect(() => applyStubTools(ctx, config)).toThrow(
      /stub_tools 中的工具名不在解析后的 programs 中：wecom-notfi/,
    );
    try {
      applyStubTools(ctx, config);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      // 消息列出全部可用程序名，方便对照拼写
      for (const name of Object.keys(ctx.programs)) {
        expect(message).toContain(name);
      }
    }
  });

  it("stub_tools 为空：原样返回入参（同一对象）", () => {
    const config = makeConfig();
    const ctx = assembleRunContext(config);
    expect(applyStubTools(ctx, config)).toBe(ctx);
  });
});
