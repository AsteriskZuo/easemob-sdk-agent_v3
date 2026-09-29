// 平台审计 extension（黑匣子）：挂在 before_provider_request（请求出边界的最后一刻），
// 把每次发给 LLM 的真实请求体逐行追加落盘，作为脱敏有效性的唯一直接证据。
// 由平台装配时统一 -e 注入（--no-extensions 白名单纪律），业务不可摘除；默认开启。
// fail-closed：写盘失败即抛错（pi 语义：hook 抛错 = 阻断该请求）——宁可调用失败，不留无审计的 LLM 请求。
// plain JS、不经构建（pi 经 jiti 直接加载）；落盘路径取环境变量 AUDIT_LOG_PATH（由 agent-service 注入）。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export default function audit(pi) {
  pi.on("before_provider_request", (event) => {
    const target = process.env.AUDIT_LOG_PATH;
    if (!target) {
      throw new Error(
        "audit extension: AUDIT_LOG_PATH 未设置，拒绝放行无审计的 LLM 请求",
      );
    }
    // 事件主体是 event.payload（真实请求体）；provider/model 字段防御式提取
    const payload =
      event && typeof event === "object" ? (event.payload ?? event) : event;
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        provider: (event && event.provider) ?? null,
        model: (event && event.model) ?? null,
        body: payload ?? null,
      }) + "\n";
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, line);
  });
}
