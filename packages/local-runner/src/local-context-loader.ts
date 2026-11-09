import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { RunContext } from "@asteriskzuo/agent-run-core";
import type { SkillRef } from "@asteriskzuo/agent-service";
import type { LocalRunConfig } from "./config.js";
import { resolveResource } from "./name-resolve.js";
import type { ResolvedAsset } from "./name-resolve.js";
import { stubFileContent } from "./stub.js";

/**
 * 本地 RunContext 装配器（spec §6.1）与 stub 应用（spec §6.2）。
 * 装配语义逐条对齐平台 packages/runtime/src/context-loader.ts：
 * 资产顺序 = 包在前、工具随后、skill 最后；programs 并集同名首个命中；
 * skills 并集同名首个命中去重；失败（如 entry_program 找不到）原样上抛。
 * 本地不做：凭据解析（path 资产无需凭据）、上下架检查、注册表查询。
 */

/** 判断是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读 package/tool 资产根的 agent-package.json。
 * package 资产清单已经过 config.ts 校验（存在/合法/programs 形状），这里是兜底；
 * tool 资产清单 config.ts 未校验（只验了目录存在），非法时在此 fail-fast。
 *
 * @returns 清单 name（非字符串时归一为 undefined）与 programs 映射（缺失归一为 {}）。
 * @throws {Error} 清单不可读 / 非合法 JSON / 非对象 / programs 形状非法。
 */
function readManifest(assetRoot: string): {
  name: string | undefined;
  programs: Record<string, string>;
} {
  const manifestPath = path.join(assetRoot, "agent-package.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `资产清单不可读：${manifestPath}（${(error as Error).message}）`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `资产清单不是合法 JSON：${manifestPath}（${(error as Error).message}）`,
    );
  }
  if (!isPlainObject(manifest)) {
    throw new Error(`资产清单必须是 JSON 对象：${manifestPath}`);
  }
  let programs: Record<string, string> = {};
  if (manifest.programs !== undefined) {
    if (
      !isPlainObject(manifest.programs) ||
      Object.values(manifest.programs).some((v) => typeof v !== "string")
    ) {
      throw new Error(
        `资产清单 programs 必须是「程序名 → 相对路径」的对象：${manifestPath}`,
      );
    }
    programs = manifest.programs as Record<string, string>;
  }
  const name =
    typeof manifest.name === "string" && manifest.name.length > 0
      ? manifest.name
      : undefined;
  return { name, programs };
}

/**
 * 扫描 skill 资产根：每个含 SKILL.md 文件的直接子目录是一个技能，
 * 技能名 = 目录名，结果按字典序（对齐 packages/asset-registry/src/validate.ts:155-170
 * 的集合扫描约定；skill 资产无清单文件）。扫描不到技能不视为错误
 * （平台「no skill found」是资产上架期的校验，装载期清单可空）。
 */
function scanSkills(assetRoot: string): string[] {
  return readdirSync(assetRoot, { withFileTypes: true })
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
}

/**
 * 按 spec §6.1 对齐表把本地配置装配为 RunContext（stub 应用前的「等值上下文」，
 * 上下文 diff 应以本函数结果为本地侧输入）。
 *
 * @param config loadConfig 的返回（必填已校验、路径已绝对化）。
 * @returns 与平台 ContextLoader.load 同构的 RunContext。
 * @throws {Error} `resource_not_found: program <entry_program>` 等名解析失败
 *                 （config.ts 已做存在性校验，这里是兜底），以及清单/技能扫描失败。
 */
export function assembleRunContext(config: LocalRunConfig): RunContext {
  // 资产视图：包在前、工具随后、skill 最后（数组顺序即名解析优先级，对齐平台）
  const pkg = readManifest(config.assets.package.path);
  const resolved: ResolvedAsset[] = [
    {
      name: pkg.name ?? "package",
      root: config.assets.package.path,
      programs: pkg.programs,
      skills: [],
    },
    ...config.assets.tools.map((asset) => ({
      name: asset.name,
      root: asset.path,
      programs: readManifest(asset.path).programs,
      skills: [],
    })),
    ...config.assets.skills.map((asset) => ({
      name: asset.name,
      root: asset.path,
      programs: {},
      skills: scanSkills(asset.path),
    })),
  ];

  // 主程序：entry_program 经名解析出绝对路径（找不到抛 resource_not_found，原样上抛）
  const program = resolveResource(resolved, "program", config.entry_program).path;

  // 全量 programs 映射（名 → 绝对路径）：同名按资产顺序首个命中
  const programs: Record<string, string> = {};
  for (const asset of resolved) {
    for (const [name, rel] of Object.entries(asset.programs)) {
      if (programs[name] === undefined) {
        programs[name] = path.join(asset.root, rel);
      }
    }
  }

  // skills 白名单全集：全部 skill 资产的技能并集（同名首个命中去重）
  const skillByName = new Map<string, SkillRef>();
  for (const asset of resolved) {
    for (const name of asset.skills) {
      if (skillByName.has(name)) continue;
      const hit = resolveResource(resolved, "skill", name);
      skillByName.set(name, { name: hit.name, path: hit.path });
    }
  }

  return {
    business_id: config.business_id,
    channel_id: config.channel_id,
    program,
    programs,
    prompt: config.prompt,
    skills: [...skillByName.values()],
    model: config.model,
    // pi_agent_dir 仅在配置时带上（undefined = 未配置模型，与平台语义一致）
    ...(config.pi_agent_dir !== undefined
      ? { pi_agent_dir: config.pi_agent_dir }
      : {}),
    vars: config.vars,
    secrets: config.secrets,
    quota: config.quota,
  };
}

/**
 * stub 应用点（spec §6.2）：装配完成之后、生成执行请求之前调用。
 * 对 config.stub_tools 的每个工具名，把 stubFileContent(工具名, 固定输出) 写入
 * `{config.workspace_root}/.local-run-stubs/{工具名}.js`（每次 run 前重新生成），
 * 并把 programs[工具名] 替换为该文件路径，使业务经 sdk.run 调用时实际执行替身，
 * 出口副作用（发企微、回写 Jira 等）不会真实外发。
 *
 * @param context assembleRunContext 的结果（不被修改）。
 * @param config 本地运行配置（取 stub_tools / stub_outputs / workspace_root）。
 * @returns programs 替换后的新 RunContext，其余字段与入参相同（不可变更新）；
 *          stub_tools 为空时原样返回入参。
 * @throws {Error} stub_tools 中的名字不在 context.programs 中时抛错
 *                 （消息列出可用程序名，防止拼写错误导致护栏静默失效）。
 */
export function applyStubTools(
  context: RunContext,
  config: LocalRunConfig,
): RunContext {
  if (config.stub_tools.length === 0) {
    return context;
  }
  // 命中校验（spec §4 校验规则之一，依赖解析后的 programs，故归装配器）
  const available = Object.keys(context.programs);
  for (const tool of config.stub_tools) {
    if (context.programs[tool] === undefined) {
      throw new Error(
        `stub_tools 中的工具名不在解析后的 programs 中：${tool}` +
          `（可用程序：${available.join(", ")}）`,
      );
    }
  }

  const stubDir = path.join(config.workspace_root, ".local-run-stubs");
  mkdirSync(stubDir, { recursive: true });

  const programs = { ...context.programs };
  for (const tool of config.stub_tools) {
    const stubPath = path.join(stubDir, `${tool}.js`);
    // 未配置固定输出的工具默认 output: {}（spec §9 决策 D2）
    writeFileSync(stubPath, stubFileContent(tool, config.stub_outputs[tool] ?? {}));
    programs[tool] = stubPath;
  }
  return { ...context, programs };
}
