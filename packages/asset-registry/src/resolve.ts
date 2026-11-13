import { existsSync } from "node:fs";
import path from "node:path";

/** 调用方给定的资产视图项（绑定集合）；解析按传入顺序首个命中 */
export interface ResolvedAsset {
  asset_id: string;
  /** 物化后的资产根绝对路径（= 物化缓存目录/subpath，skill 叶子级时根本身即技能目录） */
  root: string;
  /** package/tool 的清单 programs；skill 资产传 {} */
  programs: Record<string, string>;
  /** skill 资产：技能名 → 相对资产根的技能目录（集合级 = 目录名；叶子级 = "."）；
   *  package/tool 传 {} */
  skills: Record<string, string>;
}

/** 由清单技能名列表构造 skills 映射：资产根本身含 SKILL.md 时为叶子级（spec 2026-11-13
 *  tool/skill 按单个登记，subpath 直指技能目录），统一映射 "."；否则按集合级原名映射目录名 */
export function skillRelMap(
  root: string,
  names: readonly string[],
): Record<string, string> {
  const leaf = existsSync(path.join(root, "SKILL.md"));
  return Object.fromEntries(names.map((n) => [n, leaf ? "." : n]));
}

export interface ResolvedResource {
  /** 命中资产 */
  asset_id: string;
  /** 资源名 */
  name: string;
  /** 绝对路径 = join(root, 相对路径) */
  path: string;
}

/** 名解析：kind='program' 查各资产 programs，kind='skill' 查各资产 skills。
 *  按集合顺序找首个命中（名唯一性由控制台绑定配置期保证，此处不设优先级与限定写法）；
 *  全无 → 抛 resource_not_found: <kind> <name> */
export function resolveResource(
  assets: readonly ResolvedAsset[],
  kind: "program" | "skill",
  name: string,
): ResolvedResource {
  for (const asset of assets) {
    if (kind === "program") {
      const rel = asset.programs[name];
      if (rel !== undefined) {
        return {
          asset_id: asset.asset_id,
          name,
          path: path.join(asset.root, rel),
        };
      }
    } else {
      const rel = asset.skills[name];
      if (rel !== undefined) {
        // skill 的资源路径 = 技能目录（相对资产根；叶子级 rel = "."，根本身即技能目录）
        return {
          asset_id: asset.asset_id,
          name,
          path: path.join(asset.root, rel),
        };
      }
    }
  }
  throw new Error(`resource_not_found: ${kind} ${name}`);
}
