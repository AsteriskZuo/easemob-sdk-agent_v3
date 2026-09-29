/** POST JSON。非 2xx 抛错（含状态码与响应片段）；默认 10s 超时（AbortSignal.timeout）。
 *  fetchImpl 可注入（测试用），缺省全局 fetch */
export async function postJson(
  url: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body ?? null),
    signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    const snippet = await res.text().catch(() => "");
    throw new Error(
      `POST ${url} 失败：HTTP ${res.status} ${snippet.slice(0, 200)}`,
    );
  }
}
