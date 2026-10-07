import { readFileSync } from "node:fs";
import { join } from "node:path";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 pi 的 models.json（{pi_agent_dir}/models.json），产出可选模型全量列表（provider/id 形式）。
 *  结构非法（非 JSON / providers 非对象 / 无任一 provider 含非空 models 数组）→ 抛错（消息说明原因）。
 *  解析规则：遍历 providers 每个键值对，对其 models 数组的每项取 id，产出 `${provider}/${id}`；
 *  任一 provider 的 models 为空数组或项缺 id 字段 → 跳过该项不算错，但最终全平台列表为空 = 抛错。
 *  只取 provider 名与 model id：apiKey 不读、不记、不回显（它只属 pi 子进程） */
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
  if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) {
    throw new Error(`models.json 结构非法: providers 必须是对象: ${path}`);
  }
  const models: string[] = [];
  for (const [provider, providerConfig] of Object.entries(parsed.providers)) {
    if (
      !isPlainObject(providerConfig) ||
      !Array.isArray(providerConfig.models)
    ) {
      continue;
    }
    for (const model of providerConfig.models) {
      if (
        isPlainObject(model) &&
        typeof model.id === "string" &&
        model.id.length > 0
      ) {
        models.push(`${provider}/${model.id}`);
      }
    }
  }
  if (models.length === 0) {
    throw new Error(
      `models.json 无可用模型（无任一 provider 含非空 models 数组）: ${path}`,
    );
  }
  return models;
}
