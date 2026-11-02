import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 生效 models.json 的运行时解析产物（models op 视图 + agent op 白名单） */
export interface EffectiveModels {
  /** 派生 agent 目录（models.json 所在；pi 子进程 PI_CODING_AGENT_DIR） */
  agent_dir: string;
  /** 按配置声明顺序（models op 原样返回） */
  providers: Array<{ name: string; models: string[] }>;
  /** 全部 provider/id（显式 model 参数的白名单） */
  allowed: Set<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析生效 models.json（运行时宽松版结构校验：只保证可枚举——
 *  providers 非空 object；每 provider.models 为非空数组、每项含非空字符串 id）。
 *  保存期已过严格校验（含显式 models 强制），运行期解析失败 = 文件被篡改或手写，
 *  抛错让 serve 失败、run 失败（fail-fast，不消费可疑文件）。
 *  纪律：错误文本只含字段路径，绝不携带文件内容（内含 apiKey 等敏感字段）。 */
export function parseEffectiveModels(piAgentDir: string): EffectiveModels {
  const path = join(piAgentDir, "models.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // fs 错误只含路径与系统码，可携带；JSON.parse 错误文本可能回显文件片段（V8 摘录），绝不携带
    throw new Error(
      `models.json 不可读: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`models.json 不是合法 JSON: ${path}`);
  }
  const problems: string[] = [];
  const providers: Array<{ name: string; models: string[] }> = [];
  const allowed = new Set<string>();
  if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) {
    problems.push("providers 必须是对象");
  } else {
    const entries = Object.entries(parsed.providers);
    if (entries.length === 0) problems.push("providers 至少包含一个 provider");
    for (const [name, config] of entries) {
      const providerPath = `providers.${name}`;
      if (name.trim() === "") {
        problems.push("provider 名不能为空");
        continue;
      }
      if (!isPlainObject(config)) {
        problems.push(`${providerPath} 必须是对象`);
        continue;
      }
      if (!Array.isArray(config.models) || config.models.length === 0) {
        problems.push(`${providerPath}.models 必须是非空数组`);
        continue;
      }
      const ids: string[] = [];
      for (const [index, item] of config.models.entries()) {
        const modelPath = `${providerPath}.models[${index}]`;
        if (
          !isPlainObject(item) ||
          typeof item.id !== "string" ||
          item.id.trim() === ""
        ) {
          problems.push(`${modelPath}.id 必须是非空字符串`);
          continue;
        }
        ids.push(item.id);
        allowed.add(`${name}/${item.id}`);
      }
      if (ids.length > 0) providers.push({ name, models: ids });
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `models.json 结构非法: ${path}:\n- ${problems.join("\n- ")}`,
    );
  }
  return { agent_dir: piAgentDir, providers, allowed };
}
