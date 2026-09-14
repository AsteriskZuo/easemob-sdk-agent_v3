# 企业微信调研

本目录记录企业微信作为 Docker 服务 Trigger Layer / Result Handler 的接入调研。

文件：

- [`2026-07-11-wecom-aibot-research.md`](./2026-07-11-wecom-aibot-research.md)：调研结论、推荐方案、接入边界和验证步骤。
- [`wecom-aibot-verify.mjs`](./wecom-aibot-verify.mjs)：企业微信智能机器人 API 模式验证脚本。

当前推荐：

```text
企业微信智能机器人 API 模式 - 长连接
+ @wecom/aibot-node-sdk
+ Docker 服务中的 wecom trigger / notifier 模块
```

第一版不建议直接复制旧项目正式代码，也不建议手写 WebSocket 协议；先用官方 SDK 跑通文本消息接收、回复和主动通知。
