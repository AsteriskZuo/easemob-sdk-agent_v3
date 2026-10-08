import type { EventSource } from "@asterisk/agent-contracts";
import type { BusinessMatch, BusinessRegistry } from "@asterisk/agent-registry";

/** 全量扫注册表内存视图，取某 source 的全部匹配行（含 entry_config）。
 *  说明：registry 既有读面里 BusinessProfile 不含匹配行，匹配行（含 entry_config）
 *  只能经 get(business_id) 取——故 list() 取业务 id 后逐业务 get() 过滤。
 *  入口适配器按 path 路由 / 按 tick 对账都需要「按行扫」视角（match(source,event_type)
 *  是「按事件找业务」的反向视角，不适用）。
 *  规模 = 全部业务的匹配行总量（数十行级），每请求/每 tick 现扫，v1 接受 */
export function scanMatchRows(
  registry: BusinessRegistry,
  source: EventSource,
): BusinessMatch[] {
  const rows: BusinessMatch[] = [];
  for (const profile of registry.list()) {
    for (const row of registry.get(profile.business_id)) {
      if (row.source === source) rows.push(row);
    }
  }
  return rows;
}

/** 点分路径提取（如 "issue.key"）：任一中间层非 object 或终点缺失 → undefined */
export function getByPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 取 entry_config 里的可选字符串项：非字符串（含缺失）→ undefined */
export function configString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
