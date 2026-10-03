# wecom-aibot-send

企业微信智能机器人「主动发送消息」通道调研，为 wecom-aibot 出口工具（主动向用户/群投递业务产出）提供实现依据：发送协议、消息体与限制、共享长连接约束、configSchema 与 destination_id 配置来源建议。

## 文件清单

- `2026-10-03-wecom-aibot-send-research.md` — 调研正文：结论先行、事实确认（带来源 URL + 2026-10-03 单连接互踢实测）、风险与缺口、出口工具实现建议。
- `single-connection-verify.mjs` — 「同一 botId 单连接互踢」实测脚本（双 WSClient 同 botId 先后建连，不发消息，2026-10-03 实测 RESULT: PASS）。

复跑实测：

```bash
node docs/researches/wecom-aibot-send/single-connection-verify.mjs
# 使用第二组机器人凭证：
node docs/researches/wecom-aibot-send/single-connection-verify.mjs --bot-index 2
```

