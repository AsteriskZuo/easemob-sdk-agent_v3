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

// ─── 契约闸（契约设计 §6：package 类资产的物化强制） ───

// 类型词表与 SDK 运行期校验器（packages/sdk/src/contract.ts）同一份冻结语义（v1，设计 §4.3）：
// 两处机械重复是有意的——asset-registry 不反向依赖业务侧 SDK；schema 演进走 contract.json 顶层 version 升号
const CONTRACT_TYPE_WORDS = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "array",
]);

/** 类型词合法性：五个基词或 `<词>[]`（可叠层，如 string[][]） */
function isValidContractTypeWord(type: unknown): boolean {
  if (typeof type !== "string" || type === "") return false;
  if (type.endsWith("[]")) return isValidContractTypeWord(type.slice(0, -2));
  return CONTRACT_TYPE_WORDS.has(type);
}

/** 校验 contract 一侧（input/output）的字段声明形状，问题追加进 problems */
function lintContractSide(
  side: unknown,
  name: "input" | "output",
  problems: string[],
): void {
  if (side === null) return; // 显式 null = 无约束/无产出（合法）
  if (!isPlainObject(side) || !Array.isArray(side.fields)) {
    problems.push(`contract.json ${name} 必须是 null 或 { fields: [...] }`);
    return;
  }
  for (const [index, field] of (side.fields as unknown[]).entries()) {
    const at = `contract.json ${name}.fields[${index}]`;
    if (!isPlainObject(field)) {
      problems.push(`${at} 必须是对象`);
      continue;
    }
    if (typeof field.path !== "string" || field.path === "") {
      problems.push(`${at}.path 必须是非空字符串`);
    }
    if (!isValidContractTypeWord(field.type)) {
      problems.push(
        `${at}.type 非法：${JSON.stringify(field.type)}（词表：string/number/boolean/object/array/T[]）`,
      );
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      problems.push(`${at}.required 必须是布尔值`);
    }
    if (field.desc !== undefined && typeof field.desc !== "string") {
      problems.push(`${at}.desc 必须是字符串`);
    }
  }
}

/** 契约闸（物化强制，仅 package 类资产；tool/skill 非编排单元不适用）：
 *  ① programs 含 check-input / check-output 两个平台编排保留名（产物存在性归构建后 assertProgramsBuilt）；
 *  ② contract.json 存在于资产根且形状合法（version===1——未知版本拒绝；input/output 显式给出，null 或字段声明）。
 *  问题逐条收集、一次失败全部列出（validation_failed）。构建前调用（contract.json 与程序名是构建前事实，失败可省去构建） */
export function assertContractGate(
  assetRoot: string,
  manifest: AssetManifest,
): void {
  if (manifest.kind !== "package") return;

  const problems: string[] = [];
  for (const name of ["check-input", "check-output"] as const) {
    if (!(name in manifest.programs)) {
      problems.push(`programs 缺平台编排保留程序名：${name}`);
    }
  }

  const contractPath = path.join(assetRoot, "contract.json");
  let raw: string | null = null;
  try {
    raw = readFileSync(contractPath, "utf8");
  } catch {
    problems.push("contract.json 不存在于资产根或不可读");
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push("contract.json 不是合法 JSON");
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (!isPlainObject(parsed)) {
        problems.push("contract.json 顶层必须是 JSON 对象");
      } else {
        if (parsed.version !== 1) {
          problems.push(
            "contract.json version 缺失或不是 1（未知版本平台无法解释）",
          );
        }
        if (!("input" in parsed)) {
          problems.push(
            "contract.json 缺少 input 节（无输入约束也要显式写 null）",
          );
        } else {
          lintContractSide(parsed.input, "input", problems);
        }
        if (!("output" in parsed)) {
          problems.push(
            "contract.json 缺少 output 节（无产出也要显式写 null）",
          );
        } else {
          lintContractSide(parsed.output, "output", problems);
        }
      }
    }
  }

  if (problems.length > 0) {
    fail(`契约闸未通过：\n- ${problems.join("\n- ")}`);
  }
}
