import path from "node:path";

/**
 * 名解析：逐条复刻平台 packages/asset-registry/src/resolve.ts 的语义（spec §6.1），
 * 差别仅在于资产视图项的标识字段——平台用 asset_id，本地用配置中的逻辑名。
 * 命中规则、路径拼接规则、错误消息格式与平台完全一致，保证本地装配与平台可对照。
 */

/** 调用方给定的资产视图项（配置中的资产绑定集合）；解析按传入顺序首个命中。 */
export interface ResolvedAsset {
  /** 资产逻辑名（对应平台 asset_id 的角色）：tools/skills 取配置中的 name，
   *  package 资产取清单 name（缺省 "package"）。仅用于排查定位，不参与命中逻辑。 */
  name: string;

  /** 资产根绝对路径（LocalRunConfig 已把配置路径绝对化）。 */
  root: string;

  /** package/tool 清单的 programs（程序名 → 相对资产根路径）；skill 资产传 {}。 */
  programs: Record<string, string>;

  /** skill 资产的技能名列表（= 含 SKILL.md 的直接子目录名）；package/tool 传 []。 */
  skills: string[];
}

/** 名解析命中结果。 */
export interface ResolvedResource {
  /** 命中资产的逻辑名（平台对应字段为 asset_id）。 */
  asset_name: string;

  /** 资源名（程序名或技能名）。 */
  name: string;

  /** 绝对路径：program = join(root, 清单相对路径)；skill = join(root, 技能名)（技能目录）。 */
  path: string;
}

/** 名解析：kind='program' 查各资产 programs，kind='skill' 查各资产 skills。
 *  按集合顺序找首个命中（名唯一性由开发者配置保证，此处不设优先级与限定写法）；
 *  全无 → 抛 `resource_not_found: <kind> <name>`（与平台逐字一致）。
 *
 *  @param assets 资产视图数组，顺序即优先级（装配方保证：包在前、工具随后、skill 最后）
 *  @param kind 资源种类
 *  @param name 资源名
 *  @throws {Error} `resource_not_found: <kind> <name>` 全部资产都未命中时 */
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
          asset_name: asset.name,
          name,
          path: path.join(asset.root, rel),
        };
      }
    } else if (asset.skills.includes(name)) {
      // skill 的资源路径 = 技能目录（技能名 = 目录名）
      return {
        asset_name: asset.name,
        name,
        path: path.join(asset.root, name),
      };
    }
  }
  throw new Error(`resource_not_found: ${kind} ${name}`);
}
