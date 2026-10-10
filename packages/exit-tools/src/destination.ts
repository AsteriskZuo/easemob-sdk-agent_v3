import { createHash } from "node:crypto";

/** 配置字段是否含占位符（{{key}} 模板）；destinationOf 的占位守卫判定用 */
export function hasPlaceholder(...values: Array<string | undefined>): boolean {
  return values.some((v) => v !== undefined && v.includes("{{"));
}

/** 含占位模板的目标标识：tpl_ + sha256(原始模板串) 前 12 位。
 *  十六进制字符集天然合法（无 '__'、无路径/控制字符，过 assertSafeSegment）。
 *  同模板 = 同目标（串行身份稳定，secret 轮换不重建通道）；
 *  不解析占位——destinationId 明文嵌入 channel_id，解析会把 secret 泄进标识与日志 */
export function templateDestination(rawTemplate: string): string {
  return `tpl_${createHash("sha256").update(rawTemplate, "utf8").digest("hex").slice(0, 12)}`;
}
