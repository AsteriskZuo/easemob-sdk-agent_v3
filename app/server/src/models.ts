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
