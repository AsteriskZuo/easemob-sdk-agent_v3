import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 配额配置（对应平台 RunContext.quota）。
 * 本地运行要求填写「最终生效值」，不做业务覆盖 ?? 全局默认的推导（推导规则留在平台）。
 */
export interface LocalRunQuota {
  /** main 程序超时分钟数；必须为大于 0 的有限数。 */
  timeout_minutes: number;

  /** 每 run agent 调用上限；必须为大于 0 的有限数。 */
  max_agent_calls: number;
}

/** 命名 path 资产（tools/skills 条目）；path 在加载后一律为绝对路径。 */
export interface NamedAssetPath {
  /** 资产名；名解析与 stub_tools 命中均以该名为键。 */
  name: string;

  /** 资产目录的绝对路径；配置中的相对路径按配置文件所在目录解析。 */
  path: string;
}

/**
 * path 资产集合（对应平台资产物化结果）。
 * 数组顺序即名解析优先级，与平台「包在前、工具随后、skill 最后」对齐。
 */
export interface LocalRunAssets {
  /** 业务包资产：目录内必须含 agent-package.json 且 programs[entry_program] 指向的 .js 产物存在。 */
  package: { path: string };

  /** 工具资产列表；缺省为 []。 */
  tools: NamedAssetPath[];

  /** skill 资产列表；缺省为 []。 */
  skills: NamedAssetPath[];
}

/**
 * 本地运行配置（spec §4）。
 * 由 loadConfig 返回：必填项已校验、缺省项已填充、所有路径字段已解析为绝对路径，
 * 下游（装配器 / CLI）可直接消费，不再需要关心配置文件所在目录。
 */
export interface LocalRunConfig {
  /** 业务标识（对应平台 BusinessProfile 的 business_id）；必填，非空字符串。 */
  business_id: string;

  /** 通道标识；回放时建议与平台 run 一致（影响会话映射键）；必填，非空字符串。 */
  channel_id: string;

  /** 业务提示词总纲（对应 profile.prompt）；可选，缺省为 ""。 */
  prompt: string;

  /** 主程序名（对应 profile.entry_program）；必填，必须能在 package 资产的 programs 中命中。 */
  entry_program: string;

  /** 默认模型 provider/id（对应 profile.model）；必填，非空字符串。 */
  model: string;

  /** path 资产集合；assets.package 必填，tools/skills 缺省为 []。 */
  assets: LocalRunAssets;

  /** 非机密配置桶（对应平台 env.getFor 的 vars）；可选，缺省为 {}，值必须为字符串。 */
  vars: Record<string, string>;

  /** 机密配置桶（对应平台 env.getFor 的 secrets）；可选，缺省为 {}，值必须为字符串。只在本地，严禁提交 git。 */
  secrets: Record<string, string>;

  /**
   * 含生效 models.json 的 Pi 配置目录（对应平台 pi_agent_dir 派生目录）；可选。
   * 配置后解析为绝对路径；目录必须存在且内含 models.json。
   * 未配置时保持 undefined（与平台「未配置模型」语义一致）。
   */
  pi_agent_dir?: string;

  /**
   * pi CLI 路径（传给 createAgentService）；可选。
   * null 或未配置 = 缺省解析（同平台缺省行为）；字符串原样保留（可为 PATH 可执行名，不做存在性校验）。
   */
  pi_cli_path: string | null;

  /** 传给 pi 子进程的环境变量覆盖（传给 createAgentService）；可选，缺省为 {}，值必须为字符串。 */
  pi_env: Record<string, string>;

  /**
   * pi 内置工具白名单（对应平台包清单的 pi_tools 字段）；可选。
   * 存在时必须为非空字符串数组，每项 ∈ PI_BUILTIN_TOOLS；
   * 缺省 undefined = 不开放（--no-tools，与平台语义一致）。
   */
  pi_tools?: string[];

  /** 配额最终生效值；必填，两个字段都必须为大于 0 的有限数。 */
  quota: LocalRunQuota;

  /**
   * 本地运行根目录（spec §6.3 的 local_root）；可选。
   * 缺省 = 配置文件所在目录下的 workspace/；配置后解析为绝对路径。
   * 不要求预先存在（由 CLI 在运行前创建）。
   */
  workspace_root: string;

  /**
   * 出口护栏：被 stub 的工具名列表（spec §9）；可选，缺省为 []。
   * 本模块只校验形状（非空字符串数组）；「必须命中解析后 programs」的校验在装配器（local-context-loader）完成。
   */
  stub_tools: string[];

  /** 各 stub 工具的固定输出（键 = 工具名，值 = output 的 JSON）；可选，缺省为 {}；未配置的工具默认输出 {}。 */
  stub_outputs: Record<string, unknown>;
}

/** 配置文件加载/校验失败的统一错误类型；message 中含字段路径与原因，供 CLI 直接打印。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 抛出带字段路径的校验错误。 */
function fail(field: string, reason: string): never {
  throw new ConfigError(`配置字段 ${field} 非法：${reason}`);
}

/** 平台开放的 pi 内置工具枚举（与 packages/asset-registry/src/validate.ts 的
 *  PI_BUILTIN_TOOLS 同一份冻结语义；local-runner 不依赖 asset-registry，机械重复是有意的——扩枚举两处同改） */
const PI_BUILTIN_TOOLS = ["read", "grep", "glob"] as const;

/** 判断是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验未知字段（防拼写漂移，与平台「机械校验」风格一致）。 */
function assertNoUnknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(where, `存在未知字段 "${key}"（允许字段：${allowed.join(", ")}）`);
    }
  }
}

/** 校验必填非空字符串。 */
function readRequiredString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = obj[key];
  if (value === undefined) {
    fail(where, `缺少必填字段 "${key}"`);
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(`${where}.${key}`, "必须为非空字符串");
  }
  return value;
}

/** 校验可选字符串；undefined 时返回 defaultValue。 */
function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  defaultValue: string,
): string {
  const value = obj[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    fail(`${where}.${key}`, "必须为字符串");
  }
  return value;
}

/** 校验字符串值字典（vars / secrets / pi_env 共用）。 */
function readStringRecord(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, string> {
  const value = obj[key];
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    fail(`${where}.${key}`, "必须为对象（键值均为字符串）");
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      fail(`${where}.${key}.${k}`, "值必须为字符串");
    }
    result[k] = v;
  }
  return result;
}

/** 把配置中的路径解析为绝对路径：相对路径基于配置文件所在目录。 */
function resolvePath(configDir: string, p: string): string {
  return path.resolve(configDir, p);
}

/** 校验路径存在且为目录，返回原路径。 */
function assertExistingDir(p: string, field: string): string {
  if (!existsSync(p)) {
    fail(field, `路径不存在：${p}`);
  }
  if (!statSync(p).isDirectory()) {
    fail(field, `路径不是目录：${p}`);
  }
  return p;
}

/** 校验 quota 字段（必填，两个字段都必须为大于 0 的有限数，不允许未知字段）。 */
function readQuota(raw: unknown): LocalRunQuota {
  if (raw === undefined) {
    fail("config", '缺少必填字段 "quota"');
  }
  if (!isPlainObject(raw)) {
    fail("config.quota", "必须为对象 { timeout_minutes, max_agent_calls }");
  }
  assertNoUnknownFields(raw, ["timeout_minutes", "max_agent_calls"], "config.quota");
  const readNumber = (key: "timeout_minutes" | "max_agent_calls"): number => {
    const value = raw[key];
    if (value === undefined) {
      fail("config.quota", `缺少必填字段 "${key}"`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail(`config.quota.${key}`, "必须为大于 0 的有限数");
    }
    return value;
  };
  return {
    timeout_minutes: readNumber("timeout_minutes"),
    max_agent_calls: readNumber("max_agent_calls"),
  };
}

/** 校验 tools/skills 资产条目数组。 */
function readNamedAssets(
  raw: unknown,
  field: string,
  configDir: string,
): NamedAssetPath[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail(field, "必须为数组（元素为 { name, path }）");
  }
  return raw.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (!isPlainObject(entry)) {
      fail(entryField, "必须为对象 { name, path }");
    }
    assertNoUnknownFields(entry, ["name", "path"], entryField);
    const name = readRequiredString(entry, "name", entryField);
    const rawPath = readRequiredString(entry, "path", entryField);
    const resolved = resolvePath(configDir, rawPath);
    assertExistingDir(resolved, `${entryField}.path`);
    return { name, path: resolved };
  });
}

/**
 * 校验 package 资产：
 * 目录存在、内含可解析的 agent-package.json、其 programs[entry_program] 存在且指向的 .js 产物存在。
 */
function readPackageAsset(
  raw: unknown,
  entryProgram: string,
  configDir: string,
): { path: string } {
  if (raw === undefined) {
    fail("config.assets", '缺少必填字段 "package"');
  }
  if (!isPlainObject(raw)) {
    fail("config.assets.package", "必须为对象 { path }");
  }
  assertNoUnknownFields(raw, ["path"], "config.assets.package");
  const rawPath = readRequiredString(raw, "path", "config.assets.package");
  const packageDir = assertExistingDir(
    resolvePath(configDir, rawPath),
    "config.assets.package.path",
  );

  const manifestPath = path.join(packageDir, "agent-package.json");
  if (!existsSync(manifestPath)) {
    fail(
      "config.assets.package.path",
      `目录内缺少 agent-package.json：${manifestPath}`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(
      "config.assets.package.path",
      `agent-package.json 不是合法 JSON：${manifestPath}（${(error as Error).message}）`,
    );
  }
  if (!isPlainObject(manifest) || !isPlainObject(manifest.programs)) {
    fail(
      "config.assets.package.path",
      `agent-package.json 缺少 programs 映射：${manifestPath}`,
    );
  }
  const entryRel = manifest.programs[entryProgram];
  if (typeof entryRel !== "string" || entryRel.length === 0) {
    fail(
      "config.entry_program",
      `package 资产 agent-package.json 的 programs 中不存在程序 "${entryProgram}"`,
    );
  }
  if (!entryRel.endsWith(".js")) {
    fail(
      "config.entry_program",
      `programs["${entryProgram}"] 必须指向 .js 产物，实际为 "${entryRel}"`,
    );
  }
  const entryAbs = path.resolve(packageDir, entryRel);
  if (!existsSync(entryAbs)) {
    fail(
      "config.entry_program",
      `programs["${entryProgram}"] 指向的产物不存在：${entryAbs}，请先构建业务包（如 npm run build）`,
    );
  }
  return { path: packageDir };
}

/** 顶层允许字段（未知字段报错，防拼写漂移）。 */
const TOP_LEVEL_FIELDS = [
  "business_id",
  "channel_id",
  "prompt",
  "entry_program",
  "model",
  "assets",
  "vars",
  "secrets",
  "pi_agent_dir",
  "pi_cli_path",
  "pi_env",
  "pi_tools",
  "quota",
  "workspace_root",
  "stub_tools",
  "stub_outputs",
] as const;

/**
 * 加载并校验本地配置文件（spec §4）。
 *
 * 行为：
 * - 读文件 → JSON 解析 → 形状校验（必填项 / 类型 / 未知字段）→ 存在性校验 → 路径解析；
 * - 所有相对路径（assets.*.path、pi_agent_dir、workspace_root）基于配置文件所在目录解析为绝对路径；
 * - 缺省项填充：prompt ""、tools/skills []、vars/secrets/pi_env {}、pi_cli_path null、
 *   stub_tools []、stub_outputs {}、workspace_root = 配置目录/workspace；
 * - 不在此处做「stub_tools 命中解析后 programs」的校验（依赖名解析，归装配器）。
 *
 * @param configPath 配置文件路径（建议 .local-run/config.json）。
 * @returns 校验通过且路径已绝对化的配置。
 * @throws {ConfigError} 文件不存在、JSON 非法、必填缺失、未知字段、资产/目录校验失败等一切装载前错误。
 */
export function loadConfig(configPath: string): LocalRunConfig {
  const absConfigPath = path.resolve(configPath);
  if (!existsSync(absConfigPath)) {
    throw new ConfigError(`配置文件不存在：${absConfigPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absConfigPath, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `配置文件不是合法 JSON：${absConfigPath}（${(error as Error).message}）`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(`配置文件顶层必须为 JSON 对象：${absConfigPath}`);
  }
  assertNoUnknownFields(raw, TOP_LEVEL_FIELDS, "config");

  const configDir = path.dirname(absConfigPath);

  const businessId = readRequiredString(raw, "business_id", "config");
  const channelId = readRequiredString(raw, "channel_id", "config");
  const prompt = readOptionalString(raw, "prompt", "config", "");
  const entryProgram = readRequiredString(raw, "entry_program", "config");
  const model = readRequiredString(raw, "model", "config");

  // assets：package 必填（含清单与入口产物校验），tools/skills 可选。
  if (raw.assets === undefined) {
    fail("config", '缺少必填字段 "assets"（至少含 assets.package）');
  }
  if (!isPlainObject(raw.assets)) {
    fail("config.assets", "必须为对象 { package, tools?, skills? }");
  }
  assertNoUnknownFields(raw.assets, ["package", "tools", "skills"], "config.assets");
  const assets: LocalRunAssets = {
    package: readPackageAsset(raw.assets.package, entryProgram, configDir),
    tools: readNamedAssets(raw.assets.tools, "config.assets.tools", configDir),
    skills: readNamedAssets(raw.assets.skills, "config.assets.skills", configDir),
  };

  const vars = readStringRecord(raw, "vars", "config");
  const secrets = readStringRecord(raw, "secrets", "config");

  // pi_agent_dir：可选；配置后必须为存在且含 models.json 的目录。
  let piAgentDir: string | undefined;
  if (raw.pi_agent_dir !== undefined) {
    if (typeof raw.pi_agent_dir !== "string" || raw.pi_agent_dir.length === 0) {
      fail("config.pi_agent_dir", "必须为非空字符串");
    }
    const resolved = assertExistingDir(
      resolvePath(configDir, raw.pi_agent_dir),
      "config.pi_agent_dir",
    );
    const modelsJson = path.join(resolved, "models.json");
    if (!existsSync(modelsJson)) {
      fail("config.pi_agent_dir", `目录内缺少 models.json：${modelsJson}`);
    }
    piAgentDir = resolved;
  }

  // pi_cli_path：null/缺省 = 缺省解析；字符串原样保留（可为 PATH 可执行名，不做存在性校验）。
  let piCliPath: string | null = null;
  if (raw.pi_cli_path !== undefined) {
    if (raw.pi_cli_path !== null && typeof raw.pi_cli_path !== "string") {
      fail("config.pi_cli_path", "必须为字符串或 null");
    }
    piCliPath = raw.pi_cli_path;
  }

  const piEnv = readStringRecord(raw, "pi_env", "config");

  // pi_tools：可选；非空字符串数组，每项 ∈ 平台枚举（同 asset-registry PI_BUILTIN_TOOLS）；
  // 缺省 undefined = 不开放（--no-tools，与平台语义一致）
  let piTools: string[] | undefined;
  if (raw.pi_tools !== undefined) {
    if (!Array.isArray(raw.pi_tools) || raw.pi_tools.length === 0) {
      fail("config.pi_tools", "必须为非空字符串数组");
    }
    piTools = raw.pi_tools.map((tool, index) => {
      if (
        typeof tool !== "string" ||
        !(PI_BUILTIN_TOOLS as readonly string[]).includes(tool)
      ) {
        fail(
          `config.pi_tools[${index}]`,
          `非法工具名（允许：${PI_BUILTIN_TOOLS.join(", ")}）`,
        );
      }
      return tool;
    });
  }

  const quota = readQuota(raw.quota);

  // workspace_root：可选，缺省 = 配置目录/workspace；只解析路径，不要求存在（由 CLI 运行前创建）。
  let workspaceRoot: string;
  if (raw.workspace_root === undefined) {
    workspaceRoot = path.join(configDir, "workspace");
  } else {
    if (typeof raw.workspace_root !== "string" || raw.workspace_root.length === 0) {
      fail("config.workspace_root", "必须为非空字符串");
    }
    workspaceRoot = resolvePath(configDir, raw.workspace_root);
  }

  // stub_tools：本模块只校验形状；命中解析后 programs 的校验在装配器完成。
  let stubTools: string[] = [];
  if (raw.stub_tools !== undefined) {
    if (!Array.isArray(raw.stub_tools)) {
      fail("config.stub_tools", "必须为字符串数组");
    }
    stubTools = raw.stub_tools.map((tool, index) => {
      if (typeof tool !== "string" || tool.length === 0) {
        fail(`config.stub_tools[${index}]`, "必须为非空字符串");
      }
      return tool;
    });
  }

  // stub_outputs：键 = 工具名，值 = 任意 JSON（替身原样输出）。
  let stubOutputs: Record<string, unknown> = {};
  if (raw.stub_outputs !== undefined) {
    if (!isPlainObject(raw.stub_outputs)) {
      fail("config.stub_outputs", "必须为对象（键 = 工具名，值 = 固定输出 JSON）");
    }
    stubOutputs = raw.stub_outputs;
  }

  return {
    business_id: businessId,
    channel_id: channelId,
    prompt,
    entry_program: entryProgram,
    model,
    assets,
    vars,
    secrets,
    pi_agent_dir: piAgentDir,
    pi_cli_path: piCliPath,
    pi_env: piEnv,
    pi_tools: piTools,
    quota,
    workspace_root: workspaceRoot,
    stub_tools: stubTools,
    stub_outputs: stubOutputs,
  };
}
