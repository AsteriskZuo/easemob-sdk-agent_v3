# 企业微信机器人互发消息调研

本目录记录「企业微信的两个机器人之间是否可以相互发消息」的调研与真实环境验证。

文件：

- [`2026-08-05-wecom-bot-to-bot-research.md`](./2026-08-05-wecom-bot-to-bot-research.md)：官方文档核对、真实实验数据、结论。
- [`wecom-bot-to-bot-verify.mjs`](./wecom-bot-to-bot-verify.mjs)：群消息场景验证脚本（webhook 机器人 / AI 机器人发群消息，两个 AI 机器人监听回调）。
- [`wecom-bot-to-bot-direct.mjs`](./wecom-bot-to-bot-direct.mjs)：机器人直发机器人验证脚本（以对方 aibotid 作为 chatid）。
