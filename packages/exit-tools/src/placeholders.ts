import type { ExitTool } from "./types.js";

/** 占位工具工厂：菜单登记用，真实实现待调研后补（后续任务）。
 *  destinationOf / bind 调用即抛 Error(`出口工具 '<kind>' 尚未实现`)；
 *  destination_id 提取规则按 spec §2 表执行（实现时的契约） */
export function createPlaceholderExitTool(
  kind: string,
  name: string,
): ExitTool {
  return {
    kind,
    name,
    implemented: false,
    configSchema: [],
    destinationOf() {
      throw new Error(`出口工具 '${kind}' 尚未实现`);
    },
    bind() {
      throw new Error(`出口工具 '${kind}' 尚未实现`);
    },
  };
}
