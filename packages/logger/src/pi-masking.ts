/** Pi models.json 复合对象脱敏：与普通 vars/secrets 的单字段脱敏不同，
 *  Pi 配置是含嵌套 headers/多 provider 的复合对象，敏感键递归命中即掩码。
 *  三个纯函数互不依赖，不持有状态 */

/** 掩码占位符：展示对象中的敏感值一律写成它；用户更新时必须重新填写（占位符不得当真值保存） */
export const PI_MASK_PLACEHOLDER = "******";

/** 敏感键判定（大小写不敏感）：
 *  apiKey/api_key/apikey、authorization、proxy-authorization、accessToken/access_token、
 *  clientSecret/client_secret、password、cookie/set-cookie；
 *  headers 场景常见形态 api-key 及任意以 -api-key 结尾的字段 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (
    lower === "apikey" ||
    lower === "api_key" ||
    lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "accesstoken" ||
    lower === "access_token" ||
    lower === "clientsecret" ||
    lower === "client_secret" ||
    lower === "password" ||
    lower === "cookie" ||
    lower === "set-cookie"
  ) {
    return true;
  }
  return lower === "api-key" || lower.endsWith("-api-key");
}

/** 深拷贝输入并递归掩码敏感字段；不修改原对象，非敏感字段和数组结构原样保留。
 *  命中敏感键时无论值形状（字符串/对象/数组）都写 ****** */
export function maskPiModelsConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = isSensitiveKey(key) ? PI_MASK_PLACEHOLDER : walk(item);
      }
      return out;
    }
    return value;
  };
  return walk(config) as Record<string, unknown>;
}

/** 收集配置中敏感字段的非空字符串真值（供日志与错误文本专用脱敏）；不返回其他字段值 */
export function collectPiModelsSecrets(
  config: Record<string, unknown>,
): string[] {
  const secrets: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
          if (typeof item === "string" && item !== "") secrets.push(item);
          continue; // 敏感键不深入（值已整体视为敏感）
        }
        walk(item);
      }
    }
  };
  walk(config);
  return secrets;
}

/** 仅在 Pi 配置链路替换敏感真值：按长度从长到短替换，空串忽略；
 *  不改变普通 logger 的短值规则（本函数不注册进全局外观） */
export function maskPiText(text: string, secrets: readonly string[]): string {
  let out = text;
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (secret === "") continue;
    out = out.split(secret).join(PI_MASK_PLACEHOLDER);
  }
  return out;
}

/** 递归检查敏感字段是否仍为掩码占位符（更新时未重填）；返回首个占位字段路径，无则 undefined。
 *  验证/保存前调用：命中占位符必须拒绝，绝不把掩码当真值 */
export function findPiMaskPlaceholder(
  config: Record<string, unknown>,
): string | undefined {
  const walk = (value: unknown, path: string): string | undefined => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const hit = walk(item, `${path}[${index}]`);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        const nextPath = path === "" ? key : `${path}.${key}`;
        if (isSensitiveKey(key)) {
          if (item === PI_MASK_PLACEHOLDER) return nextPath;
          continue;
        }
        const hit = walk(item, nextPath);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(config, "");
}
