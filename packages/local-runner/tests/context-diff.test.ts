import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { RunContext } from "@asteriskzuo/agent-run-core";
import type { FieldDiff } from "../src/context-diff.js";
import { diffContexts } from "../src/context-diff.js";

/**
 * 测试夹具：临时目录下两个资产根 platformRoot/ 与 localRoot/，
 * 各自含 dist/*.js 程序产物、skills/<名>/ 技能目录、pi/agent/models.json，
 * 两侧物理路径不同、内容默认相同（验证 digest 比较与路径无关）。
 */
let root: string;
let platformRoot: string;
let localRoot: string;

/** 在指定资产根下写入一套标准资产（内容可由 overrides 覆盖）。 */
function writeAssets(
  base: string,
  overrides: {
    main?: string;
    check?: string;
    skillFiles?: Record<string, string>;
    modelsJson?: string | null; // null = 不写 models.json
  } = {},
): void {
  const main = overrides.main ?? "console.log('main');";
  const check = overrides.check ?? "console.log('check');";
  const skillFiles = overrides.skillFiles ?? {
    "SKILL.md": "# review guide\n",
    "refs/rules.md": "rule 1\n",
  };
  const modelsJson =
    overrides.modelsJson === undefined
      ? '{"models":[{"id":"qwen/qwen3.8-max"}]}'
      : overrides.modelsJson;

  mkdirSync(path.join(base, "dist"), { recursive: true });
  writeFileSync(path.join(base, "dist", "main.js"), main);
  writeFileSync(path.join(base, "dist", "check.js"), check);
  for (const [rel, content] of Object.entries(skillFiles)) {
    const full = path.join(base, "skills", "review-guide", rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (modelsJson !== null) {
    mkdirSync(path.join(base, "pi", "agent"), { recursive: true });
    writeFileSync(path.join(base, "pi", "agent", "models.json"), modelsJson);
  } else {
    // 目录存在但缺 models.json 的场景
    mkdirSync(path.join(base, "pi", "agent"), { recursive: true });
  }
}

/** 由资产根构造 RunContext（标量字段两侧一致，由调用方按需改）。 */
function makeContext(base: string): RunContext {
  return {
    business_id: "jira-ticket-review",
    channel_id: "jira:HIM-12345",
    program: path.join(base, "dist", "main.js"),
    programs: {
      main: path.join(base, "dist", "main.js"),
      check: path.join(base, "dist", "check.js"),
    },
    prompt: "业务提示词总纲",
    skills: [
      { name: "review-guide", path: path.join(base, "skills", "review-guide") },
    ],
    model: "qwen/qwen3.8-max",
    pi_agent_dir: path.join(base, "pi", "agent"),
    vars: { JIRA_PROJECT: "HIM" },
    secrets: { JIRA_PASSWORD: "s3cret", WECOM_WEBHOOK: "https://hook" },
    quota: { timeout_minutes: 30, max_agent_calls: 50 },
  };
}

function fieldOf(fields: FieldDiff[], name: string): FieldDiff {
  const found = fields.find((f) => f.field === name);
  if (!found) throw new Error(`报告中缺少字段 ${name}`);
  return found;
}

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "local-runner-diff-"));
  platformRoot = path.join(root, "platform");
  localRoot = path.join(root, "local");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("diffContexts", () => {
  it("全等：两侧路径不同但内容一致，报告 equal 且逐字段 equal", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);

    const report = diffContexts(makeContext(platformRoot), makeContext(localRoot));

    expect(report.equal).toBe(true);
    expect(report.fields.every((f) => f.kind === "equal")).toBe(true);
    // digest 类字段展示短哈希（前 12 位），与内容 sha256 对应
    const program = fieldOf(report.fields, "program");
    expect(program.platform).toBe(shortHash("console.log('main');"));
    expect(program.platform).toBe(program.local);
    // 键集合展开为逐名字段
    for (const name of [
      "programs.main",
      "programs.check",
      "skills.review-guide",
      "pi_agent_dir",
      "vars.JIRA_PROJECT",
      "secrets.JIRA_PASSWORD",
      "quota.timeout_minutes",
      "quota.max_agent_calls",
    ]) {
      expect(fieldOf(report.fields, name).kind).toBe("equal");
    }
  });

  it("program 内容不同：program 字段 different，展示两侧不同短哈希", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot, { main: "console.log('main v2');" });

    const report = diffContexts(makeContext(platformRoot), makeContext(localRoot));

    expect(report.equal).toBe(false);
    const program = fieldOf(report.fields, "program");
    expect(program.kind).toBe("different");
    expect(program.platform).toBe(shortHash("console.log('main');"));
    expect(program.local).toBe(shortHash("console.log('main v2');"));
    // programs.main 同样受影响，programs.check 不受影响
    expect(fieldOf(report.fields, "programs.main").kind).toBe("different");
    expect(fieldOf(report.fields, "programs.check").kind).toBe("equal");
  });

  it("programs 键集合不同：仅平台有记 platform_only，仅本地有记 local_only", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    // 平台多一个 notify 程序
    writeFileSync(path.join(platformRoot, "dist", "notify.js"), "n");
    const platform = makeContext(platformRoot);
    platform.programs.notify = path.join(platformRoot, "dist", "notify.js");
    const local = makeContext(localRoot);
    delete local.programs.check;
    local.programs.extra = path.join(localRoot, "dist", "check.js");

    const report = diffContexts(platform, local);

    expect(report.equal).toBe(false);
    const notify = fieldOf(report.fields, "programs.notify");
    expect(notify.kind).toBe("platform_only");
    expect(notify.platform).toBe(shortHash("n"));
    expect(notify.local).toBeUndefined();
    const extra = fieldOf(report.fields, "programs.extra");
    expect(extra.kind).toBe("local_only");
    expect(extra.local).toBe(shortHash("console.log('check');"));
    expect(extra.platform).toBeUndefined();
  });

  it("skill 目录内容不同：skills.<名> 记 different", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot, {
      skillFiles: { "SKILL.md": "# review guide v2\n", "refs/rules.md": "rule 1\n" },
    });

    const report = diffContexts(makeContext(platformRoot), makeContext(localRoot));

    expect(report.equal).toBe(false);
    const skill = fieldOf(report.fields, "skills.review-guide");
    expect(skill.kind).toBe("different");
    expect(skill.platform).not.toBe(skill.local);
  });

  it("skills 数组顺序无关：两侧顺序不同但内容一致仍全等", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    // 两侧各加一个第二个技能，数组顺序相反
    for (const base of [platformRoot, localRoot]) {
      const dir = path.join(base, "skills", "lint-guide");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), "# lint\n");
    }
    const platform = makeContext(platformRoot);
    platform.skills.push({
      name: "lint-guide",
      path: path.join(platformRoot, "skills", "lint-guide"),
    });
    const local = makeContext(localRoot);
    local.skills.unshift({
      name: "lint-guide",
      path: path.join(localRoot, "skills", "lint-guide"),
    });

    const report = diffContexts(platform, local);

    expect(report.equal).toBe(true);
  });

  it("secrets 一致：equal 且展示值恒 ***，不泄露原值", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);

    const report = diffContexts(makeContext(platformRoot), makeContext(localRoot));

    for (const f of report.fields.filter((f) => f.field.startsWith("secrets."))) {
      expect(f.kind).toBe("equal");
      expect(f.platform).toBe("***");
      expect(f.local).toBe("***");
      expect(JSON.stringify(f)).not.toContain("s3cret");
    }
  });

  it("secrets 不一致：different，展示值仍为 *** 不落原值", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    const local = makeContext(localRoot);
    local.secrets.JIRA_PASSWORD = "different-secret";

    const report = diffContexts(makeContext(platformRoot), local);

    expect(report.equal).toBe(false);
    const secret = fieldOf(report.fields, "secrets.JIRA_PASSWORD");
    expect(secret.kind).toBe("different");
    expect(secret.platform).toBe("***");
    expect(secret.local).toBe("***");
    expect(JSON.stringify(report)).not.toContain("s3cret");
    expect(JSON.stringify(report)).not.toContain("different-secret");
  });

  it("secrets 仅一侧有：platform_only / local_only，展示值 ***", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    const local = makeContext(localRoot);
    delete local.secrets.WECOM_WEBHOOK;
    local.secrets.LOCAL_ONLY_TOKEN = "x";

    const report = diffContexts(makeContext(platformRoot), local);

    expect(report.equal).toBe(false);
    const webhook = fieldOf(report.fields, "secrets.WECOM_WEBHOOK");
    expect(webhook.kind).toBe("platform_only");
    expect(webhook.platform).toBe("***");
    expect(webhook.local).toBeUndefined();
    const token = fieldOf(report.fields, "secrets.LOCAL_ONLY_TOKEN");
    expect(token.kind).toBe("local_only");
    expect(token.local).toBe("***");
  });

  it("vars / quota / prompt 直比差异：逐字段 different", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    const local = makeContext(localRoot);
    local.vars.JIRA_PROJECT = "OTHER";
    local.quota = { timeout_minutes: 60, max_agent_calls: 50 };
    local.prompt = "另一份提示词";

    const report = diffContexts(makeContext(platformRoot), local);

    expect(report.equal).toBe(false);
    expect(fieldOf(report.fields, "vars.JIRA_PROJECT")).toMatchObject({
      kind: "different",
      platform: "HIM",
      local: "OTHER",
    });
    expect(fieldOf(report.fields, "quota.timeout_minutes")).toMatchObject({
      kind: "different",
      platform: "30",
      local: "60",
    });
    expect(fieldOf(report.fields, "quota.max_agent_calls").kind).toBe("equal");
    expect(fieldOf(report.fields, "prompt").kind).toBe("different");
  });

  it("本地文件缺失（未构建）：不抛错，记 different 且展示值注明 missing", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    const local = makeContext(localRoot);
    // 本地 dist/main.js 不存在（未构建）
    local.program = path.join(localRoot, "dist", "main.js");
    rmSync(path.join(localRoot, "dist"), { recursive: true, force: true });

    const report = diffContexts(makeContext(platformRoot), local);

    expect(report.equal).toBe(false);
    const program = fieldOf(report.fields, "program");
    expect(program.kind).toBe("different");
    expect(program.platform).toBe(shortHash("console.log('main');"));
    expect(program.local).toBe("missing");
    expect(fieldOf(report.fields, "programs.main").local).toBe("missing");
  });

  it("pi_agent_dir 目录存在但缺 models.json：记 different 并注明", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot, { modelsJson: null });

    const report = diffContexts(makeContext(platformRoot), makeContext(localRoot));

    expect(report.equal).toBe(false);
    const pi = fieldOf(report.fields, "pi_agent_dir");
    expect(pi.kind).toBe("different");
    expect(pi.local).toBe("missing models.json");
  });

  it("pi_agent_dir 仅一侧配置：另一侧 undefined 记 platform_only / local_only；两侧都缺省记 equal", () => {
    writeAssets(platformRoot);
    writeAssets(localRoot);
    const platform = makeContext(platformRoot);
    const local = makeContext(localRoot);
    delete local.pi_agent_dir;

    const report = diffContexts(platform, local);

    expect(report.equal).toBe(false);
    const pi = fieldOf(report.fields, "pi_agent_dir");
    expect(pi.kind).toBe("platform_only");
    expect(pi.local).toBeUndefined();

    // 两侧都不配置 pi_agent_dir
    const platform2 = makeContext(platformRoot);
    const local2 = makeContext(localRoot);
    delete platform2.pi_agent_dir;
    delete local2.pi_agent_dir;
    const report2 = diffContexts(platform2, local2);
    expect(fieldOf(report2.fields, "pi_agent_dir").kind).toBe("equal");
    expect(report2.equal).toBe(true);
  });
});
