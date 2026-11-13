import type { AssetMeta } from "@asteriskzuo/agent-console-api";

/** 资产清单名（AssetMeta.name）；v3 之前登记的存量资产为 null，展示层回退 */
export function assetName(a: AssetMeta): string | null {
  return a.name ?? null;
}
