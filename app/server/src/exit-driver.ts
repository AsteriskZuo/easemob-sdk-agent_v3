import type { ExitRegistry } from "@asterisk/agent-exit-tools";
import type { EnvProvider } from "@asterisk/agent-runtime";
import type { ExitDriver } from "@asterisk/agent-scheduler";

/** 出口机密回填键规则（全平台唯一定义处）：exit.{kind}.{field.key}。
 *  控制台（T13/T14）写 secrets 桶与装配根回填共用此规则（决策点 4） */
export function exitSecretKey(kind: string, fieldKey: string): string {
  return `exit.${kind}.${fieldKey}`;
}

/** 创建出口执行器：ExitRegistry 取用 + 机密回填 + bind/deliver。
 *  绑定配置只存非机密项；configSchema 标注 secret:true 的项在投递前从该业务
 *  secrets 桶按 exit.{kind}.{field.key} 回填合并，再 bind。
 *  required 机密缺失由 bind 校验抛错，出口循环按有界重试处置
 *  （配置类错误重试无用，耗尽死信，语义可接受） */
export function createExitDriver(deps: {
  /** 出口工具注册表（七个内置工具） */
  exits: ExitRegistry;
  /** 两桶环境配置（机密回填数据源） */
  env: EnvProvider;
}): ExitDriver {
  return {
    // 纯函数：binding.config 只有非机密项，恰好满足 destinationOf「只能来自非机密配置」的约束
    destinationOf(binding) {
      return deps.exits.get(binding.tool).destinationOf(binding.config);
    },

    async deliver(binding, payload) {
      const tool = deps.exits.get(binding.tool);
      // 机密回填：非机密项原样，secret:true 的项有才合入（缺失留给 bind 的 required 校验）
      const config: Record<string, string> = { ...binding.config };
      const { secrets } = deps.env.getFor(binding.business_id);
      for (const field of tool.configSchema) {
        if (field.secret !== true) continue;
        const value = secrets[exitSecretKey(tool.kind, field.key)];
        if (value !== undefined) {
          config[field.key] = value;
        }
      }
      await tool.bind(config).deliver(payload);
    },
  };
}
