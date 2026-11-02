import type {
  AssetInput,
  AssetRegistry,
} from "@asteriskzuo/agent-asset-registry";
import { assertPlaceholderKeysExist } from "@asteriskzuo/agent-console-api";
import type { EventSource } from "@asteriskzuo/agent-contracts";
import type {
  BusinessPatch,
  BusinessRegistry,
  CreateBusinessInput,
} from "@asteriskzuo/agent-registry";
import { findAssetReferencers } from "@asteriskzuo/agent-registry";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import type { UpdateHandler } from "./coordinator.js";

/** 应用处理器的注入面：registry/env/资产三个生效注册表（生产管理写只允许出现在这里） */
export interface BuildUpdateHandlersDeps {
  registry: BusinessRegistry;
  env: EnvProvider;
  assets: AssetRegistry;
}

/** 随建环境配置条目（business.create payload 的一部分） */
interface EnvEntryPayload {
  bucket: "vars" | "secrets";
  key: string;
  value: string;
}

/** 构建全部更新命令的应用处理器。命令 payload 语义见 spec §9.2 命令表；
 *  处理器抛错 = 应用失败（命令标 failed，错误文本须不含 secret） */
export function buildUpdateHandlers(
  deps: BuildUpdateHandlersDeps,
): Record<string, UpdateHandler> {
  const { registry, env, assets } = deps;

  /** 私有资产凭据：应用时从通用层安全桶按 credential_key 解析真值（凭据不复制进队列 payload） */
  const resolveCredential = (credentialKey?: string): string | undefined => {
    if (credentialKey === undefined) return undefined;
    const value = env.getFor("").secrets[credentialKey];
    if (value === undefined) {
      throw new Error(`credential_required: ${credentialKey}`);
    }
    return value;
  };

  return {
    "business.create": (payload) => {
      const p = payload as {
        input: CreateBusinessInput;
        env_entries?: EnvEntryPayload[];
        entry_config?: Record<string, unknown>;
      };
      const businessId = registry.create(p.input);
      // 随建 env 写入 + 占位 key 存在性校验（env 写入先于占位校验，刚写入的键对校验可见）；
      // 任一步失败 → 回滚：删除本次写入的 env 键 + 删除已建业务，再抛错
      const writtenEnvKeys: Array<{ bucket: "vars" | "secrets"; key: string }> =
        [];
      try {
        for (const entry of p.env_entries ?? []) {
          env.set(businessId, entry.bucket, entry.key, entry.value);
          writtenEnvKeys.push(entry);
        }
        if (p.entry_config !== undefined) {
          assertPlaceholderKeysExist(
            env,
            businessId,
            p.entry_config,
            "entry_config",
          );
        }
        for (const [index, binding] of (
          p.input.exit_bindings ?? []
        ).entries()) {
          assertPlaceholderKeysExist(
            env,
            businessId,
            binding.config,
            `exit_bindings[${index}].config`,
          );
        }
      } catch (err) {
        for (const entry of writtenEnvKeys) {
          env.remove(businessId, entry.bucket, entry.key);
        }
        registry.remove(businessId);
        throw err;
      }
      // 首个匹配行的入口配置：CreateBusinessInput 不含 entry_config（既有契约不改动），
      // 先建后删补 addMatch 落定
      if (p.entry_config !== undefined) {
        registry.removeMatch(businessId, p.input.source, p.input.event_type);
        registry.addMatch(
          businessId,
          p.input.source,
          p.input.event_type,
          p.entry_config,
        );
      }
      return registry.getProfile(businessId);
    },

    "business.patch": (payload) => {
      const p = payload as { business_id: string; patch: BusinessPatch };
      registry.update(p.business_id, p.patch);
      return null;
    },

    "business.delete": (payload) => {
      // 只删除 registry（匹配行/出口绑定随行删除）；不删除 businesses/{id} 工作区目录
      const p = payload as { business_id: string };
      registry.remove(p.business_id);
      return null;
    },

    "business.match.add": (payload) => {
      const p = payload as {
        business_id: string;
        source: EventSource;
        event_type: string;
        entry_config?: Record<string, unknown>;
      };
      registry.addMatch(p.business_id, p.source, p.event_type, p.entry_config);
      return registry.get(p.business_id);
    },

    "business.match.remove": (payload) => {
      const p = payload as {
        business_id: string;
        source: EventSource;
        event_type: string;
      };
      registry.removeMatch(p.business_id, p.source, p.event_type);
      return null;
    },

    "env.global.set": (payload) => {
      const p = payload as {
        bucket: "vars" | "secrets";
        key: string;
        value: string;
      };
      env.set(null, p.bucket, p.key, p.value);
      return null;
    },

    "env.global.remove": (payload) => {
      const p = payload as { bucket: "vars" | "secrets"; key: string };
      env.remove(null, p.bucket, p.key);
      return null;
    },

    "env.business.set": (payload) => {
      const p = payload as {
        business_id: string;
        bucket: "vars" | "secrets";
        key: string;
        value: string;
      };
      env.set(p.business_id, p.bucket, p.key, p.value);
      return null;
    },

    "env.business.remove": (payload) => {
      const p = payload as {
        business_id: string;
        bucket: "vars" | "secrets";
        key: string;
      };
      env.remove(p.business_id, p.bucket, p.key);
      return null;
    },

    "asset.register": (payload) => {
      // payload.input.ref 已在提交时固定为 40 位 commit；此处 register 的 resolveRef 原样透传
      const p = payload as { input: AssetInput };
      return assets.register(p.input, {
        credential: resolveCredential(p.input.credential_key),
      });
    },

    "asset.update": (payload) => {
      const p = payload as {
        asset_id: string;
        commit: string;
        credential_key?: string;
      };
      return assets.updateRef(p.asset_id, p.commit, {
        credential: resolveCredential(p.credential_key),
      });
    },

    "asset.enabled.set": (payload) => {
      const p = payload as { asset_id: string; enabled: boolean };
      return assets.setEnabled(p.asset_id, p.enabled);
    },

    "asset.remove": (payload) => {
      const p = payload as { asset_id: string };
      // 应用时一致性复检：排队期间被新业务绑定则失败（不制造悬空绑定）
      const referencers = findAssetReferencers(registry, p.asset_id);
      if (referencers.length > 0) {
        throw new Error(
          `conflict: 资产在排队期间被新业务绑定，不能删除: ${p.asset_id}（引用方: ${referencers.join(", ")}）`,
        );
      }
      assets.remove(p.asset_id);
      return null;
    },

    "asset.cache.clear": () => {
      assets.clearCache();
      return { cleared: true };
    },

    // 业务自定义 Pi 配置：配置与 model 在同一 registry 写操作中更新。
    // payload.config 已在确认前通过全部模型的真实探针验证；model 为服务端派生的默认模型
    // （第一个 provider 的第一个模型）；此处只负责原子写入
    "pi.set": (payload) => {
      const p = payload as {
        business_id: string;
        config: Record<string, unknown>;
        model: string;
      };
      registry.setPiModels(p.business_id, p.config, p.model);
      return null;
    },

    // 删除自定义配置：不再需要替代模型（全局配置概念已消失），
    // 生效后业务回到未配置状态（model=''，agent 调用将被拒绝 model_not_configured）
    "pi.remove": (payload) => {
      const p = payload as { business_id: string };
      registry.setPiModels(p.business_id, null, "");
      return null;
    },
  };
}
