import path from "node:path";

/** 调用方给定的资产视图项（绑定集合）；解析按传入顺序首个命中 */
export interface ResolvedAsset {
  asset_id: string;
  /** 物化后的资产根绝对路径 */
  root: string;
  /** package/tool 的清单 programs；skill 资产传 {} */
  programs: Record<string, string>;
  /** skill 资产的技能名列表；package/tool 传 [] */
  skills: string[];
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
    } else if (asset.skills.includes(name)) {
      // skill 的资源路径 = 技能目录（技能名 = 目录名）
      return {
        asset_id: asset.asset_id,
        name,
        path: path.join(asset.root, name),
      };
    }
  }
  throw new Error(`resource_not_found: ${kind} ${name}`);
}
