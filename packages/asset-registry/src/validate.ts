import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 资产三族：package（业务代码单位）/ tool（可复用代码组件）/ skill（可复用提示词组件集合） */
export type AssetKind = "package" | "tool" | "skill";

/** 清单解析结果：package/tool 来自 agent-package.json；skill 来自集合扫描。
 *  requires 是 package 专属字段（工具是叶子组件，组合归包的胶水代码） */
export type AssetManifest =
  | {
      kind: "package";
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
      kind: "tool";
      /** 清单 name（非空） */
      name: string;
      /** 清单 version（可选） */
      version?: string;
      /** 子程序名 → 入口文件（相对资产根）；清单缺省时归一为 {} */
      programs: Record<string, string>;
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

/** 校验相对路径形态：非绝对、不含 .. 段、扩展名 .js（清单 programs 形状规则，物化构建前校验） */
function assertInnerRelativePath(assetRoot: string, p: string): string {
  if (path.isAbsolute(p)) {
    fail(`programs 路径必须是相对路径: ${p}`);
  }
  if (p.split(/[\\/]/).includes("..")) {
    fail(`programs 路径不允许含 .. 段: ${p}`);
  }
  if (!p.endsWith(".js")) {
    fail(
      `programs 路径必须是 .js 产物（所有 program 入口须 node 可执行）: ${p}`,
    );
  }
  const resolved = path.resolve(assetRoot, p);
  if (resolved !== assetRoot && !resolved.startsWith(assetRoot + path.sep)) {
    fail(`programs 路径越出资产根: ${p}`);
  }
  return resolved;
}

/** 清单形状校验（物化构建前）：只验形状不验产物存在性——
 *  programs 指向的是物化构建产物，存在性归构建后的 assertProgramsBuilt */
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
      assertInnerRelativePath(assetRoot, value);
      programs[key] = value;
    }
  }

  // requires 是 package 专属字段：工具是叶子组件（机械能力、零 token），
  // 需要组合时由包的胶水代码编排；tool 清单出现 requires 即失败（防误配，作者立刻知道）
  if (kind === "tool" && manifest.requires !== undefined) {
    fail("tool 清单不支持 requires（requires 是 package 专属字段）");
  }

  const requires = { tools: [] as string[], skills: [] as string[] };
  if (kind === "package" && manifest.requires !== undefined) {
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

  const base = {
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    programs,
  };
  if (kind === "tool") {
    return { kind, ...base };
  }
  return { kind, ...base, requires };
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

/** 清单形状校验（构建前阶段）：逐条不过即抛 validation_failed: <原因>。
 *  package/tool 验 agent-package.json 形状（programs 相对路径/不含 ../必须 .js），不验产物存在性；
 *  skill 走集合扫描（扫描本身即全部校验） */
export function validateAssetShape(
  assetRoot: string,
  kind: AssetKind,
): AssetManifest {
  if (kind === "skill") {
    return validateSkill(assetRoot);
  }
  return validatePackageLike(assetRoot, kind);
}

/** 产物校验（物化构建后阶段）：清单 programs 每个路径必须真实存在且是文件，
 *  缺一即失败并列出全部缺失清单（skill 清单无 programs，恒过） */
export function assertProgramsBuilt(
  assetRoot: string,
  manifest: AssetManifest,
): void {
  if (manifest.kind === "skill") {
    return;
  }
  const missing: string[] = [];
  for (const rel of Object.values(manifest.programs)) {
    let isFile = false;
    try {
      isFile = statSync(path.resolve(assetRoot, rel)).isFile();
    } catch {
      // 不存在：进缺失清单
    }
    if (!isFile) {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    fail(
      `产物校验失败：programs 产物缺失（构建后仍不存在）: ${missing.join(", ")}`,
    );
  }
}

/** 按 kind 的完整内容校验（spec §5.4）= 形状校验 + 产物存在性校验。
 *  用于「取用」场景（get()）：此时物化构建已完成，产物必须存在；
 *  物化流程内部请勿用它——构建前只能 validateAssetShape，产物存在性在构建后 assertProgramsBuilt */
export function validateAsset(
  assetRoot: string,
  kind: AssetKind,
): AssetManifest {
  const manifest = validateAssetShape(assetRoot, kind);
  assertProgramsBuilt(assetRoot, manifest);
  return manifest;
}
