import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface PiModelDefinition {
  /** 模型在 provider 内的唯一标识 */
  id: string;
  [key: string]: unknown;
}

export interface PiProviderDefinition {
  /** 兼容接口地址 */
  baseUrl: string;
  /** Pi 协议适配器名 */
  api: string;
  /** 模型凭据；不得进入日志或 API 回显 */
  apiKey: string;
  /** 该 provider 的可用模型 */
  models: PiModelDefinition[];
  [key: string]: unknown;
}

export interface PiModelsConfig {
  /** provider 名到完整 Pi 配置的映射 */
  providers: Record<string, PiProviderDefinition>;
  [key: string]: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 校验完整 Pi 模型配置并提取 provider/id 列表；错误只包含字段路径，不包含配置值。 */
export function validatePiModelsConfig(
  value: unknown,
  source = "AGENT_PI_MODELS",
): { config: PiModelsConfig; models: string[] } {
  if (!isPlainObject(value)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  if (!isPlainObject(value.providers)) {
    throw new Error(`${source} providers 必须是对象`);
  }

  const problems: string[] = [];
  const models: string[] = [];
  const providerEntries = Object.entries(value.providers);
  if (providerEntries.length === 0) {
    problems.push("providers 至少包含一个 provider");
  }
  for (const [provider, providerConfig] of providerEntries) {
    const providerPath = `providers.${provider}`;
    if (provider.trim() === "") {
      problems.push("provider 名不能为空");
    }
    if (!isPlainObject(providerConfig)) {
      problems.push(`${providerPath} 必须是对象`);
      continue;
    }
    for (const field of ["baseUrl", "api", "apiKey"] as const) {
      if (!isNonEmptyString(providerConfig[field])) {
        problems.push(`${providerPath}.${field} 必须是非空字符串`);
      }
    }
    if (
      !Array.isArray(providerConfig.models) ||
      providerConfig.models.length === 0
    ) {
      problems.push(`${providerPath}.models 必须是非空数组`);
      continue;
    }
    const ids = new Set<string>();
    for (const [index, model] of providerConfig.models.entries()) {
      const modelPath = `${providerPath}.models[${index}]`;
      if (!isPlainObject(model)) {
        problems.push(`${modelPath} 必须是对象`);
        continue;
      }
      if (!isNonEmptyString(model.id)) {
        problems.push(`${modelPath}.id 必须是非空字符串`);
        continue;
      }
      if (ids.has(model.id)) {
        problems.push(`${modelPath}.id 重复`);
        continue;
      }
      ids.add(model.id);
      models.push(`${provider}/${model.id}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${source} 配置非法:\n- ${problems.join("\n- ")}`);
  }
  return { config: value as PiModelsConfig, models };
}

/** 创建平台受管 agent 目录并原子同步 models.json；失败时中止启动，不消费旧文件。 */
export function preparePiModels(
  piAgentDir: string,
  config: PiModelsConfig,
): void {
  validatePiModelsConfig(config);
  const path = join(piAgentDir, "models.json");
  const tempPath = join(
    piAgentDir,
    `.models.json.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(piAgentDir, { recursive: true, mode: 0o700 });
    chmodSync(piAgentDir, 0o700);
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } catch (err) {
    throw new Error(`models.json 生成失败: ${path}: ${errorMessage(err)}`);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 清理失败不覆盖生成结果或原始错误。
    }
  }
}

/** 读取并严格校验派生 models.json，产出可选模型全量列表（provider/id 形式）。 */
export function loadModelList(piAgentDir: string): string[] {
  const path = join(piAgentDir, "models.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`models.json 不可读: ${path}: ${errorMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`models.json 不是合法 JSON: ${path}`);
  }
  return validatePiModelsConfig(parsed, path).models;
}

/** 业务自定义 Pi 配置的结构校验（独立于全局严格校验，支持 Pi 内置 provider 简写）：
 *  1. 顶层为非数组 object，providers 为非空 object；provider 名非空，provider 配置为 object；
 *  2. baseUrl/api/apiKey 如出现必须为字符串；models 如出现必须为非空数组，
 *     每项为 object 且含非空 id，同 provider 内 id 不重复；
 *  3. 未知顶层/provider/model 字段全部保留（不重建、不深合并、不自动修正）；
 *  4. model 必须是非空 provider/id，provider 必须存在于配置；provider 显式声明 models 时
 *     id 必须在该数组，未声明 models 时允许使用 Pi 内置目录（能否工作由真实探针判定）。
 *  错误只含字段路径，不含配置值。通过则原样返回配置对象 */
export function validateBusinessPiModels(
  value: unknown,
  model: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("业务 Pi 配置必须是 JSON object");
  }
  if (
    !isPlainObject(value.providers) ||
    Object.keys(value.providers).length === 0
  ) {
    throw new Error("业务 Pi 配置 providers 必须是非空对象");
  }
  const problems: string[] = [];
  for (const [provider, providerConfig] of Object.entries(value.providers)) {
    const providerPath = `providers.${provider}`;
    if (provider.trim() === "") {
      problems.push("provider 名不能为空");
    }
    if (!isPlainObject(providerConfig)) {
      problems.push(`${providerPath} 必须是对象`);
      continue;
    }
    for (const field of ["baseUrl", "api", "apiKey"] as const) {
      const fieldValue = providerConfig[field];
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        problems.push(`${providerPath}.${field} 必须是字符串`);
      }
    }
    if (providerConfig.models !== undefined) {
      const models = providerConfig.models;
      if (!Array.isArray(models) || models.length === 0) {
        problems.push(`${providerPath}.models 如出现必须是非空数组`);
      } else {
        const ids = new Set<string>();
        for (const [index, item] of models.entries()) {
          const modelPath = `${providerPath}.models[${index}]`;
          if (!isPlainObject(item)) {
            problems.push(`${modelPath} 必须是对象`);
            continue;
          }
          if (!isNonEmptyString(item.id)) {
            problems.push(`${modelPath}.id 必须是非空字符串`);
            continue;
          }
          if (ids.has(item.id)) {
            problems.push(`${modelPath}.id 重复`);
          }
          ids.add(item.id);
        }
      }
    }
  }
  // 所选 model 的归属校验：provider/id 形式、provider 存在、显式 models 时 id 在其中
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const modelId = slash > 0 ? model.slice(slash + 1) : "";
  if (provider === "" || modelId.trim() === "") {
    problems.push(`model 必须是 provider/id 形式: ${JSON.stringify(model)}`);
  } else {
    const providerConfig = value.providers[provider];
    if (providerConfig === undefined) {
      problems.push(`model 的 provider 不在配置中: ${provider}`);
    } else if (
      isPlainObject(providerConfig) &&
      Array.isArray(providerConfig.models)
    ) {
      const ids = new Set(
        providerConfig.models
          .filter((item) => isPlainObject(item) && isNonEmptyString(item.id))
          .map((item) => (item as { id: string }).id),
      );
      if (!ids.has(modelId)) {
        problems.push(
          `model 的 id 不在 provider.${provider}.models 中: ${modelId}`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`业务 Pi 配置非法:\n- ${problems.join("\n- ")}`);
  }
  return value;
}

/** 原子生成业务自定义 Pi 派生文件 <businessPiRoot>/agent/models.json（目录 0700、文件 0600）。
 *  返回派生 agent 目录绝对路径；写失败抛错（调用方让该 run 失败，不消费旧文件、不回退全局）。
 *  调用方纪律：config 必须先过 validateBusinessPiModels */
export function prepareBusinessPiModels(
  businessPiRoot: string,
  config: Record<string, unknown>,
): string {
  const agentDir = join(businessPiRoot, "agent");
  const path = join(agentDir, "models.json");
  const tempPath = join(
    agentDir,
    `.models.json.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    chmodSync(agentDir, 0o700);
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tempPath, path);
    return agentDir;
  } catch (err) {
    throw new Error(`业务 models.json 生成失败: ${path}: ${errorMessage(err)}`);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 清理失败不覆盖生成结果或原始错误
    }
  }
}
