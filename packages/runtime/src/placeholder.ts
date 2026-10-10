import type { EnvProvider } from "./env-provider.js";

/** 占位符形态：{{key}}；key = 非空、不含花括号（贪婪匹配内不允许跨括号） */
const PLACEHOLDER_PATTERN = /\{\{([^{}]+)\}\}/g;

/** 占位解析失败：message 只含缺失键名，绝不携带任何桶值（secrets 纪律） */
export class PlaceholderError extends Error {
  /** 缺失的占位 key（去重、排序） */
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`占位符缺失环境配置键：${keys.join(", ")}`);
    this.name = "PlaceholderError";
    this.keys = keys;
  }
}

/** 提取字符串中的全部占位 key（trim 后非空才计；去重） */
export function extractPlaceholderKeysFromString(value: string): string[] {
  const keys = new Set<string>();
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1]?.trim();
    if (key !== undefined && key !== "") keys.add(key);
  }
  return [...keys];
}

/** 提取配置对象全部字符串值的占位 key（去重、排序）；保存时校验用（只验存在性，不解析值） */
export function extractPlaceholderKeys(
  config: Record<string, unknown>,
): string[] {
  const keys = new Set<string>();
  for (const value of Object.values(config)) {
    if (typeof value !== "string") continue;
    for (const key of extractPlaceholderKeysFromString(value)) keys.add(key);
  }
  return [...keys].sort();
}

/** 解析单个字符串值：纯字符串替换（不做 URL 编码）；不递归（替换进来的值不再扫描）。
 *  缺失 key 收集后统一抛 PlaceholderError（一次报全，不逐个炸） */
export function resolveString(
  value: string,
  env: EnvProvider,
  business_id: string,
): string {
  const missing = new Set<string>();
  const resolved = value.replace(PLACEHOLDER_PATTERN, (raw, name: string) => {
    const key = name.trim();
    if (key === "") return raw; // 空占位原样保留（{{}} 不视为占位）
    const found = env.lookup(business_id, key);
    if (found === undefined) {
      missing.add(key);
      return raw;
    }
    return found;
  });
  if (missing.size > 0) throw new PlaceholderError([...missing].sort());
  return resolved;
}

/** 解析配置对象：仅第一层字符串值参与替换，非字符串原样透传（浅层，不下钻）。
 *  返回新对象，不改入参。缺失 key 汇总后抛 PlaceholderError */
export function resolveConfigPlaceholders(
  config: Record<string, unknown>,
  env: EnvProvider,
  business_id: string,
): Record<string, unknown> {
  const missing = new Set<string>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    try {
      out[key] = resolveString(value, env, business_id);
    } catch (err) {
      if (err instanceof PlaceholderError) {
        for (const k of err.keys) missing.add(k);
        continue;
      }
      throw err;
    }
  }
  if (missing.size > 0) throw new PlaceholderError([...missing].sort());
  return out;
}
