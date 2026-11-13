import { join } from "node:path";
import { resolveResource } from "@asteriskzuo/agent-asset-registry";
import type {
  AssetManifest,
  AssetRegistry,
  ResolvedAsset,
} from "@asteriskzuo/agent-asset-registry";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import type { RunContext } from "@asteriskzuo/agent-run-core";
import type { SkillRef } from "@asteriskzuo/agent-service";
import type { EnvProvider } from "./env-provider.js";

export type { RunContext } from "@asteriskzuo/agent-run-core";

/** 业务自定义 Pi 配置的运行时解析器（平台装配根注入）：读当前生效配置并原子生成派生目录 */
export interface BusinessPiRuntimeResolver {
  /** 存在业务配置：原子生成 businesses/{business_id}/cache/pi/agent/models.json 并返回该目录；
   *  不存在返回 undefined（业务未配置大模型，agent 调用将被拒绝）；生成失败抛错（该 run 失败，不消费旧文件） */
  resolvePiAgentDir(business_id: string): string | undefined;
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
  piResolver?: BusinessPiRuntimeResolver; // 业务自定义 Pi 配置解析（缺省 = 无业务配置能力，走全局目录）
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
      // 上架/下架开关（fail-fast，不进入业务程序）：任一绑定资产已下架 → asset_disabled。
      // 未登记的资产由下方 assets.get 抛 asset_not_found（既有行为）
      for (const id of assetIds) {
        const meta = metas.get(id);
        if (meta !== undefined && !meta.enabled) {
          throw new Error(`asset_disabled: ${id}`);
        }
      }
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
      // 业务自定义 Pi 配置：每次 run 从当前生效值重新原子生成派生目录（失败即 run 失败，不回退全局）
      const piAgentDir = deps.piResolver?.resolvePiAgentDir(business_id);
      // pi 内置工具白名单：取包资产（objects[0]，assetIds 首位恒为 package）清单的 pi_tools 原样透传；
      // tool/skill 清单无此字段（登记期已拦）；缺省不带 = 不开放（装配侧恒 --no-tools）
      const pkgManifest = objects[0].manifest;
      return {
        business_id,
        channel_id,
        program,
        programs,
        prompt: profile.prompt,
        skills: [...skillByName.values()],
        model: profile.model,
        ...(piAgentDir !== undefined ? { pi_agent_dir: piAgentDir } : {}),
        ...(pkgManifest.kind === "package" && pkgManifest.pi_tools !== undefined
          ? { pi_tools: pkgManifest.pi_tools }
          : {}),
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
