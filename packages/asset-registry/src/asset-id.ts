import { createHash } from "node:crypto";

/** asset_id 计算：(属主 + url + kind + 子路径) 的紧凑编码。
 *  hash 输入 = `${owner_id}\n${url}\n${kind}\n${subpath ?? ""}` 的 UTF-8 字节；
 *  asset_id = `ast_` + sha256 hex 前 16 位（全长 20 字符）。
 *  不含 commit：版本升级（updateRef）asset_id 不变，业务绑定不断（T26） */
export function computeAssetId(
  ownerId: string,
  url: string,
  kind: string,
  subpath?: string,
): string {
  const input = `${ownerId}\n${url}\n${kind}\n${subpath ?? ""}`;
  const hex = createHash("sha256").update(input, "utf8").digest("hex");
  return `ast_${hex.slice(0, 16)}`;
}
