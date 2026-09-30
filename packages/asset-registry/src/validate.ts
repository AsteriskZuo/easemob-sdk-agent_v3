import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 资产三族：package（业务代码单位）/ tool（可复用代码组件）/ skill（可复用提示词组件集合） */
export type AssetKind = "package" | "tool" | "skill";

/** 清单解析结果：package/tool 来自 agent-package.json；skill 来自集合扫描 */
export type AssetManifest =
  | {
      kind: "package" | "tool";
      /** 清单 name（非空） */
      name: string;
      /** 清单 version（可选） */
      version?: string;
      /** 子程序名 → 入口文件（相对资产根）；清单缺省时归一为 {} */
      programs: Record<string, string>;
      /** 依赖声明；清单缺省时归一为 { tools: [], skills: [] } */
      requires: { tools: string[]; skills: string[] };
    }
  | {
      kind: "skill";
      /** 技能名列表（= 含 SKILL.md 的直接子目录名，按字典序） */
      skills: string[];
    };

function fail(reason: string): never {
  throw new Error(`validation_failed: ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验相对路径：非绝对、不含 .. 段、resolve 后仍在 assetRoot 内 */
function assertInnerRelativePath(assetRoot: string, p: string): string {
  if (path.isAbsolute(p)) {
    fail(`programs 路径必须是相对路径: ${p}`);
  }
  if (p.split(/[\\/]/).includes("..")) {
    fail(`programs 路径不允许含 .. 段: ${p}`);
  }
  const resolved = path.resolve(assetRoot, p);
  if (resolved !== assetRoot && !resolved.startsWith(assetRoot + path.sep)) {
    fail(`programs 路径越出资产根: ${p}`);
  }
  return resolved;
}

function validatePackageLike(
  assetRoot: string,
  kind: "package" | "tool",
): AssetManifest {
  const manifestPath = path.join(assetRoot, "agent-package.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    fail("agent-package.json 不存在或不可读");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail("agent-package.json 不是合法 JSON");
  }
  if (!isPlainObject(manifest)) {
    fail("agent-package.json 必须是 JSON 对象");
  }

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    fail("name 必须是非空字符串");
  }
  if (manifest.version !== undefined && typeof manifest.version !== "string") {
    fail("version 必须是字符串");
  }

  const programs: Record<string, string> = {};
  if (manifest.programs !== undefined) {
    if (!isPlainObject(manifest.programs)) {
      fail("programs 必须是对象");
    }
    for (const [key, value] of Object.entries(manifest.programs)) {
      if (key.length === 0) {
        fail("programs 键不能为空");
      }
      if (typeof value !== "string") {
        fail(`programs.${key} 必须是字符串`);
      }
      const resolved = assertInnerRelativePath(assetRoot, value);
      let stat;
      try {
        stat = statSync(resolved);
      } catch {
        fail(`programs.${key} 指向的文件不存在: ${value}`);
      }
      if (!stat.isFile()) {
        fail(`programs.${key} 指向的不是文件: ${value}`);
      }
      programs[key] = value;
    }
  }

  const requires = { tools: [] as string[], skills: [] as string[] };
  if (manifest.requires !== undefined) {
    if (!isPlainObject(manifest.requires)) {
      fail("requires 必须是对象");
    }
    for (const field of ["tools", "skills"] as const) {
      const list = manifest.requires[field];
      if (list === undefined) {
        continue;
      }
      if (
        !Array.isArray(list) ||
        list.some((item) => typeof item !== "string")
      ) {
        fail(`requires.${field} 必须是字符串数组`);
      }
      requires[field] = list;
    }
  }

  return {
    kind,
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    programs,
    requires,
  };
}

function validateSkill(assetRoot: string): AssetManifest {
  let entries;
  try {
    entries = readdirSync(assetRoot, { withFileTypes: true });
  } catch {
    fail(`资产根不可读: ${assetRoot}`);
  }
  // 集合扫描：每个含 SKILL.md 文件的直接子目录是一个 skill，技能名 = 目录名
  const skills = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      try {
        return statSync(path.join(assetRoot, entry.name, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();
  if (skills.length === 0) {
    fail("no skill found");
  }
  return { kind: "skill", skills };
}

/** 按 kind 的内容校验（spec §5.4）：逐条不过即抛 validation_failed: <原因> */
export function validateAsset(
  assetRoot: string,
  kind: AssetKind,
): AssetManifest {
  if (kind === "skill") {
    return validateSkill(assetRoot);
  }
  return validatePackageLike(assetRoot, kind);
}
