import { createHash } from "node:crypto";

/** asset_id 计算：(属主 + 三元组) 的紧凑编码。
 *  hash 输入 = `${owner_id}\n${url}\n${commit}\n${subpath ?? ""}` 的 UTF-8 字节；
 *  asset_id = `ast_` + sha256 hex 前 16 位（全长 20 字符） */
export function computeAssetId(
  ownerId: string,
  url: string,
  commit: string,
  subpath?: string,
): string {
  const input = `${ownerId}\n${url}\n${commit}\n${subpath ?? ""}`;
  const hex = createHash("sha256").update(input, "utf8").digest("hex");
  return `ast_${hex.slice(0, 16)}`;
}
