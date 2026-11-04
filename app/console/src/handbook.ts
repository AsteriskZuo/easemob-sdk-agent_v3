import type { HandbookPage } from "@asteriskzuo/agent-console-api";

/** 只展示正式条目；deprecated/draft 保留在生成物中供追溯，不进入当前页面。 */
export function handbookBody(
  entries: HandbookPage,
  id: string,
): string | undefined {
  const entry = entries[id];
  return entry?.status === "stable" ? entry.body.cn.trim() : undefined;
}

/** 抽屉标题使用文档条目标题，避免 UI 再维护一份长文标题。 */
export function handbookTitle(
  entries: HandbookPage,
  id: string,
): string | undefined {
  const entry = entries[id];
  return entry?.status === "stable" ? entry.title.cn : undefined;
}
