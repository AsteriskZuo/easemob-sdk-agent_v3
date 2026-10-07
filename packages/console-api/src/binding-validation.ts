import type {
  AssetManifest,
  AssetObject,
  AssetRegistry,
} from "@easemob/agent-asset-registry";
import type { EnvProvider } from "@easemob/agent-runtime";
import type { User } from "./accounts.js";
import type { EffectiveConfigView } from "./dto.js";
import { ApiError } from "./errors.js";

/** 生效绑定集合（create = 请求体原值；patch = 既有 profile 与 patch 覆盖合并后的结果） */
export interface EffectiveBinding {
  package_asset_id?: string; // 绑定的包资产；未绑定 = undefined
  entry_program?: string; // 流程程序入口名
  tool_asset_ids: string[]; // 绑定的工具资产 id 列表
  skill_asset_ids: string[]; // 绑定的 skill 集合资产 id 列表
}

/** 业务写操作（create/patch）落库前的配置期校验：全量收集问题一次性报出（不遇一错即停），
 *  任一不过 → 400 invalid_input。
 *  - binding 为 undefined = 本次写不涉及绑定字段（如 patch 只改 prompt）→ 绑定校验整体跳过（零物化）；
 *  - model/agent_kind 与绑定无关：字段出现且非空时必须 ∈ config.models / config.agents
 *    （可选集合由部署侧 models.json 驱动）。
 *  注意：assets.get 是同步接口且可能触发 git clone——管理 API 的单线程事件循环会被阻塞，
 *  本版接受（配置期低频操作） */
export function validateBusinessWrite(
  deps: {
    assets: AssetRegistry;
    env: EnvProvider;
    config: EffectiveConfigView;
  },
  actor: User,
  write: {
    binding?: EffectiveBinding;
    model?: string;
    agent_kind?: string;
  },
): void {
  const { config } = deps;
  const problems: string[] = [];

  // model/agent_kind 合法性（与绑定无关，create/patch 均执行）
  if (
    write.model !== undefined &&
    write.model !== "" &&
    !config.models.includes(write.model)
  ) {
    problems.push(
      `model 不在可选集合: ${write.model}（可选: ${config.models.join(", ") || "无"}）`,
    );
  }
  if (
    write.agent_kind !== undefined &&
    write.agent_kind !== "" &&
    !config.agents.includes(write.agent_kind)
  ) {
    problems.push(
      `agent_kind 不在可选集合: ${write.agent_kind}（可选: ${config.agents.join(", ") || "无"}）`,
    );
  }

  const binding = write.binding;
  if (binding !== undefined) {
    collectBindingProblems(deps, actor, binding, problems);
  }

  if (problems.length > 0) {
    throw new ApiError(
      "invalid_input",
      `业务配置校验未通过:\n- ${problems.join("\n- ")}`,
    );
  }
}

/** 绑定校验：存在性/物化、绑定权限、entry_program 合法性、程序名查重、skill 名查重、requires 覆盖。
 *  问题逐个 push 进 problems；取用成功（顺带落实「业务初始化物化」）的资产进 objects 供后续键位检查 */
function collectBindingProblems(
  deps: { assets: AssetRegistry; env: EnvProvider },
  actor: User,
  binding: EffectiveBinding,
  problems: string[],
): void {
  const { assets, env } = deps;

  // asset-registry 无「按 id 取 meta」读口，控制台规模下 list({}) 全量查找可接受（同 routes-assets）
  const metas = new Map(assets.list({}).map((meta) => [meta.asset_id, meta]));
  const bound: Array<{
    role: "package" | "tool" | "skill";
    asset_id: string;
  }> = [];
  if (binding.package_asset_id !== undefined) {
    bound.push({ role: "package", asset_id: binding.package_asset_id });
  }
  for (const id of binding.tool_asset_ids) {
    bound.push({ role: "tool", asset_id: id });
  }
  for (const id of binding.skill_asset_ids) {
    bound.push({ role: "skill", asset_id: id });
  }

  const objects = new Map<string, AssetObject>();
  for (const item of bound) {
    const meta = metas.get(item.asset_id);
    if (meta === undefined) {
      problems.push(`资产不存在: ${item.asset_id}`);
      continue;
    }
    // 绑定权限：包不共享（owner 必须是操作者本人）；tool/skill 须自有或共享。
    // admin 也不例外（admin 对资产只读，不替成员持有绑定）
    const allowed =
      item.role === "package"
        ? meta.owner_id === actor.user_id
        : meta.owner_id === actor.user_id || meta.shared;
    if (!allowed) {
      problems.push(
        item.role === "package"
          ? `无权限绑定包资产: ${item.asset_id}（包不共享，仅属主本人可绑）`
          : `无权限绑定资产: ${item.asset_id}（仅属主本人或共享资产可绑）`,
      );
      continue;
    }
    // 凭据解析与资产登记接口同约定：is_private 资产从通用层安全桶取 credential_key 的值
    let credential: string | undefined;
    if (meta.is_private && meta.credential_key !== undefined) {
      credential = env.getFor("").secrets[meta.credential_key];
      if (credential === undefined) {
        problems.push(
          `资产 ${item.asset_id} 的凭据 key 未在通用配置安全桶登记: ${meta.credential_key}（请先在通用配置安全桶登记该 credential_key）`,
        );
        continue;
      }
    }
    try {
      objects.set(item.asset_id, assets.get(item.asset_id, { credential }));
    } catch (err) {
      problems.push(
        `资产取用失败: ${item.asset_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const manifestOf = (assetId: string): AssetManifest | undefined =>
    objects.get(assetId)?.manifest;
  const programsOf = (assetId: string): Record<string, string> => {
    const manifest = manifestOf(assetId);
    return manifest !== undefined && manifest.kind !== "skill"
      ? manifest.programs
      : {};
  };
  const skillsOf = (assetId: string): string[] => {
    const manifest = manifestOf(assetId);
    return manifest !== undefined && manifest.kind === "skill"
      ? manifest.skills
      : [];
  };

  // entry_program 合法性：绑定集合含包且指定了入口时，必须是该包清单 programs 的键
  const pkgId = binding.package_asset_id;
  if (pkgId !== undefined && binding.entry_program !== undefined) {
    const pkgPrograms = programsOf(pkgId);
    if (
      manifestOf(pkgId) !== undefined &&
      !(binding.entry_program in pkgPrograms)
    ) {
      problems.push(
        `entry_program 不是包清单 programs 的键: ${binding.entry_program}（可选: ${Object.keys(pkgPrograms).join(", ") || "无"}）`,
      );
    }
  }

  // 程序名查重：包 programs 键 ∪ 各工具 programs 键，重复 → 问题（报出冲突名与来源资产）
  const programSources = new Map<string, string>();
  for (const item of bound) {
    if (item.role === "skill") continue;
    for (const name of Object.keys(programsOf(item.asset_id))) {
      const prev = programSources.get(name);
      if (prev !== undefined) {
        problems.push(`程序名冲突: ${name}（${prev} 与 ${item.asset_id}）`);
      } else {
        programSources.set(name, item.asset_id);
      }
    }
  }

  // skill 名查重：各 skill 集合技能名并集查重
  const skillSources = new Map<string, string>();
  for (const item of bound) {
    if (item.role !== "skill") continue;
    for (const name of skillsOf(item.asset_id)) {
      const prev = skillSources.get(name);
      if (prev !== undefined) {
        problems.push(`skill 名冲突: ${name}（${prev} 与 ${item.asset_id}）`);
      } else {
        skillSources.set(name, item.asset_id);
      }
    }
  }

  // requires 覆盖：包清单 requires.tools ∈ 绑定工具 programs 键并集；
  // requires.skills ∈ 绑定 skill 技能名并集。缺 → 问题（报出缺绑名）
  if (pkgId !== undefined) {
    const manifest = manifestOf(pkgId);
    if (manifest !== undefined && manifest.kind === "package") {
      const toolNames = new Set(
        binding.tool_asset_ids.flatMap((id) => Object.keys(programsOf(id))),
      );
      const skillNames = new Set(
        binding.skill_asset_ids.flatMap((id) => skillsOf(id)),
      );
      for (const name of manifest.requires.tools) {
        if (!toolNames.has(name)) {
          problems.push(
            `requires.tools 缺绑: ${name}（未在绑定工具的 programs 中）`,
          );
        }
      }
      for (const name of manifest.requires.skills) {
        if (!skillNames.has(name)) {
          problems.push(
            `requires.skills 缺绑: ${name}（未在绑定 skill 集合中）`,
          );
        }
      }
    }
  }
}
