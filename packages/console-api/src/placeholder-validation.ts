import { extractPlaceholderKeys } from "@asteriskzuo/agent-runtime";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import { ApiError } from "./errors.js";

/** 占位 key 存在性校验（保存时 fail fast，T24 spec §6）：
 *  提取 config 全部字符串值中的 {{key}} 占位，逐一核对
 *  业务 secrets ∪ 业务 vars ∪ 全局 secrets ∪ 全局 vars 四个键名集合
 *  （env.list 只取键名，不读明文、不解析值）。
 *  无占位 → 直接放行（零查询，现状行为不变）；
 *  有缺失 → ApiError invalid_input，message 列出缺失 key 并提示先建键。
 *  调用纪律：写 entry_config / exit_bindings 的路由在落库前调用；
 *  business_id 用目标业务的 id（创建路由在业务 id 生成后调用） */
export function assertPlaceholderKeysExist(
  env: EnvProvider,
  businessId: string,
  config: Record<string, unknown>,
  field: string,
): void {
  const keys = extractPlaceholderKeys(config);
  if (keys.length === 0) return;
  const available = new Set<string>();
  for (const scope of [businessId, null] as const) {
    const listing = env.list(scope);
    for (const key of Object.keys(listing.vars)) available.add(key);
    for (const key of listing.secret_keys) available.add(key);
  }
  const missing = keys.filter((key) => !available.has(key));
  if (missing.length > 0) {
    throw new ApiError(
      "invalid_input",
      `${field} 占位符引用了不存在的环境配置键: ${missing.join(", ")}（请先在业务/通用环境配置中创建对应键）`,
    );
  }
}
