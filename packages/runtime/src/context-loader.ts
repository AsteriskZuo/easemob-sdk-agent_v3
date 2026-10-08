import { join } from "node:path";
import { resolveResource } from "@asterisk/agent-asset-registry";
import type {
  AssetManifest,
  AssetRegistry,
  ResolvedAsset,
} from "@asterisk/agent-asset-registry";
import type { BusinessRegistry } from "@asterisk/agent-registry";
import type { SkillRef } from "@asterisk/agent-service";
import type { EnvProvider } from "./env-provider.js";

/** 可执行上下文：四步时序第①步的产物，Lifecycle 据此装配 serve 与 run 的入参 */
export interface RunContext {
  business_id: string;
  channel_id: string; // buildBusinessChannelId 计算结果（回显用）
  program: string; // 流程程序入口绝对路径（名解析命中）
  programs: Record<string, string>; // 程序名→物化绝对路径全量映射（本包 ∪ 绑定工具；runner 注入信封）
  prompt: string; // 总纲（可空串，agent-service 原样传）
  skills: SkillRef[]; // 白名单全集：绑定 skill 集合的技能并集（name + 物化绝对路径）
  model: string;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  quota: { timeout_minutes: number; max_agent_calls: number }; // 已解析（业务优先于全局默认）
}

export interface ContextLoader {
  /** 组装运行上下文；同步（asset-registry 物化是同步接口）。
   *  业务不存在 → 抛 business_not_found: <business_id>；
   *  未绑定包/入口程序 → 抛 invalid_business: <原因>（控制台本应拦住，运行时兜底） */
  load(business_id: string, channel_id: string): RunContext;
}

/** 创建 ContextLoader：profile → 物化闭包 → 名解析 → RunContext。
 *  每次 run 都重新组装（物化命中缓存是廉价路径），不引入缓存失效问题 */
export function createContextLoader(deps: {
  registry: BusinessRegistry; // 扩展后的（含 getProfile）
  assets: AssetRegistry; // 物化闭包与名解析（get / materialize / resolveResource）
  env: EnvProvider; // 两桶配置（先取：凭据解析与注入都要用）
  defaults: { task_timeout_minutes: number; max_agent_calls: number }; // 全局默认（装配根注入）
}): ContextLoader {
  return {
    load(business_id: string, channel_id: string): RunContext {
      // 1. 业务资料
      const profile = deps.registry.getProfile(business_id);
      if (!profile) {
        throw new Error(`business_not_found: ${business_id}`);
      }

      // 2. 两桶配置（先取：下一步私有资产凭据解析要用）
      const { vars, secrets } = deps.env.getFor(business_id);

      // 3. 物化闭包：包在前、工具随后、skill 最后。凭据按操作者维度解析：
      // 触发者是业务 → 取该业务两桶中 credential_key 同名的值（secrets 优先、vars 兜底）
      if (!profile.package_asset_id) {
        throw new Error("invalid_business: 未绑定包");
      }
      const metas = new Map(
        deps.assets.list({}).map((meta) => [meta.asset_id, meta]),
      );
      const credentialFor = (
        assetId: string,
      ): { credential: string } | undefined => {
        const meta = metas.get(assetId);
        if (!meta?.is_private || !meta.credential_key) return undefined;
        const value = secrets[meta.credential_key] ?? vars[meta.credential_key];
        // 仍无 → 不传：asset-registry 自己抛 credential_required（原样上抛）
        return value !== undefined ? { credential: value } : undefined;
      };
      const assetIds = [
        profile.package_asset_id,
        ...profile.tool_asset_ids,
        ...profile.skill_asset_ids,
      ];
      const objects = assetIds.map((id) =>
        deps.assets.get(id, credentialFor(id)),
      );

      // 4. 名解析视图（get 已物化，此处 materialize 命中缓存）
      const resolved: ResolvedAsset[] = objects.map((obj, index) => {
        const manifest: AssetManifest = obj.manifest;
        return {
          asset_id: assetIds[index],
          root: deps.assets.materialize(
            assetIds[index],
            credentialFor(assetIds[index]),
          ),
          programs: manifest.kind === "skill" ? {} : manifest.programs,
          skills: manifest.kind === "skill" ? manifest.skills : [],
        };
      });
      if (!profile.entry_program) {
        throw new Error("invalid_business: 未指定入口程序");
      }
      const program = resolveResource(
        resolved,
        "program",
        profile.entry_program,
      ).path;

      // 全量 programs 映射（名→物化绝对路径）：同名按 resolved 数组顺序首个命中
      // （与 resolveResource 同语义；名冲突本应被 console-api 配置期校验拦住，此处为运行时兜底）
      const programs: Record<string, string> = {};
      for (const asset of resolved) {
        for (const [name, rel] of Object.entries(asset.programs)) {
          if (programs[name] === undefined)
            programs[name] = join(asset.root, rel);
        }
      }

      // skills 白名单全集：绑定 skill 集合的技能并集（同名按集合顺序首个命中，去重）
      const skillByName = new Map<string, SkillRef>();
      for (const obj of objects) {
        if (obj.manifest.kind !== "skill") continue;
        for (const name of obj.manifest.skills) {
          if (skillByName.has(name)) continue;
          const hit = resolveResource(resolved, "skill", name);
          skillByName.set(name, { name: hit.name, path: hit.path });
        }
      }

      // 5. quota：业务资料覆盖值 ?? 全局默认
      return {
        business_id,
        channel_id,
        program,
        programs,
        prompt: profile.prompt,
        skills: [...skillByName.values()],
        model: profile.model,
        vars,
        secrets,
        quota: {
          timeout_minutes:
            profile.timeout_minutes ?? deps.defaults.task_timeout_minutes,
          max_agent_calls:
            profile.max_agent_calls ?? deps.defaults.max_agent_calls,
        },
      };
    },
  };
}
