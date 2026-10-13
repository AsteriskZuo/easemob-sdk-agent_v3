/** POST JSON，返回响应 JSON body（空响应或非 JSON 响应返回 undefined）。
 *  非 2xx 抛错（含状态码与响应片段；**不含 url**——url 可能携带密钥参数，如企微机器人 key）。
 *  默认 10s 超时（AbortSignal.timeout）。fetchImpl 可注入（测试用），缺省全局 fetch */
export async function postJson(
  url: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<unknown> {
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
      `POST 请求失败：HTTP ${res.status} ${snippet.slice(0, 200)}`,
    );
  }
  const text = await res.text().catch(() => "");
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
