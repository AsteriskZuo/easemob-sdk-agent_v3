import type { ExitRegistry } from "@asteriskzuo/agent-exit-tools";
import { resolveConfigPlaceholders } from "@asteriskzuo/agent-runtime";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import type { ExitDriver } from "@asteriskzuo/agent-scheduler";

/** 创建出口执行器：ExitRegistry 取用 + 占位解析 + bind/deliver。
 *  绑定配置全字段原样落库（任何字符串值可含 {{key}} 占位）；投递前按该业务
 *  两桶环境配置统一解析占位（resolveConfigPlaceholders），再 bind。
 *  占位缺失抛 PlaceholderError——配置类错误重试无用，出口循环有界重试耗尽死信，
 *  与现状语义一致（T24 决策：平台只认占位语法，不认字段语义） */
export function createExitDriver(deps: {
  /** 出口工具注册表（七个内置工具） */
  exits: ExitRegistry;
  /** 两桶环境配置（占位解析数据源，严格按 binding.business_id 隔离） */
  env: EnvProvider;
}): ExitDriver {
  return {
    // 关键设计：destinationOf 吃未解析的原始配置——channel_id 明文嵌入 destinationId，
    // 解析会把 secret 泄进通道标识与日志；同模板 = 同目标（串行身份由模板文本决定，
    // secret 轮换不重建通道）。含占位字段由工具侧 destinationOf 走模板哈希身份
    destinationOf(binding) {
      return deps.exits.get(binding.tool).destinationOf(binding.config);
    },

    async deliver(binding, payload) {
      const tool = deps.exits.get(binding.tool);
      // 原 config 值都是字符串，解析结果同样全是字符串终值
      const resolved = resolveConfigPlaceholders(
        binding.config,
        deps.env,
        binding.business_id,
      ) as Record<string, string>;
      await tool.bind(resolved).deliver(payload);
    },
  };
}
