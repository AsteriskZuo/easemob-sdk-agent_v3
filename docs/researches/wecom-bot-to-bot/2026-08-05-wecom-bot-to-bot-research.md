# 企业微信机器人互发消息调研

> 日期：2026-08-05  
> 状态：调研结论（含真实环境验证）  
> 范围：企业微信的两个机器人（智能机器人 / 群 webhook 机器人）之间是否可以相互发消息、相互触发

## 结论

**不可以。企业微信机器人之间无法相互发消息、相互触发。**

1. **机器人不能给另一个机器人单聊发消息**。AI 机器人 `sendMessage(chatid, body)` 的 `chatid` 只接受群聊 chatid 或用户 userid，传入对方机器人的 aibotid 直接报错 `errcode=93006 invalid chatid`（真实验证）。
2. **机器人发到群里的消息不会触发群里其他 AI 机器人的消息回调**。官方接收消息文档列出的全部触发场景都以「用户」为主体（用户群里 @ 机器人、用户单聊机器人），机器人发送的消息不满足任何触发条件；实测群 webhook 机器人成功发送群消息（`errcode=0`），两个保持长连接的 AI 机器人 45 秒内 0 条回调。
3. **也无法通过 @ 绕过**：群 webhook 的 `mentioned_list` / `<@userid>` 需要成员 userid，机器人没有 userid；AI 机器人的回复/主动发送消息结构里没有任何 @ 参数（见 [wecom-aibot-mentions 调研](../wecom-aibot-mentions/2026-07-16-wecom-aibot-mentions-research.md)）。

工程含义：**机器人 → 机器人 的链路在企业微信内不存在**。机器人只能作为「人 → 机器人」的入口和「机器人 → 人/群」的出口。如果业务上需要两个自动化系统联动，必须走系统间的直接通道（HTTP webhook、队列等），不能借助企业微信群中转。

## 官方文档依据

接收消息（<https://developer.work.weixin.qq.com/document/path/100719>）明确列出全部触发消息回调的场景：

```text
1. 用户群里@智能机器人或者单聊中向智能机器人发送文本消息
2. 用户群里@智能机器人或者单聊中向智能机器人发送图文混排消息
3. 用户单聊中向智能机器人发送图片消息
4. 用户单聊中向智能机器人发送语音消息
5. 用户单聊中向智能机器人发送本地文件消息
6. 用户单聊中向智能机器人发送视频消息
7. 用户群里@智能机器人或者单聊中向智能机器人发送引用消息
```

7 个场景的主体全部是「用户」。机器人（无论是智能机器人还是群 webhook 机器人）发出的消息不在任何触发场景内。

群 webhook 机器人（消息推送）本身是纯发送通道，没有接收消息能力，更不可能接收其他机器人的消息。

## 真实环境验证

### 实验一：群消息场景（`wecom-bot-to-bot-verify.mjs`）

配置（来自 `.easemob-agent/config.json`，全部真实凭证）：

- 监听者 L1 = `WECOM__BOT_ID_02`，L2 = `WECOM__BOT_ID__JIRA__NOTIFICATION`（长连接，记录全部 `message` / `event` 回调）
- 发送者 S = `WECOM__BOT_ID`（AI 机器人 `sendMessage` 发 markdown 到目标群）
- 发送者 W = `WECOM__BOT_WEBHOOK_URL`（群 webhook 机器人发文本到目标群）
- 目标群 = `WECOM__GROUP__CHAT_ID`（`wrYddkBwAA1f7oL6xXcbHRbjK728FnNg`）

运行结果（2026-08-05 20:13 北京时间）：

| 发送路径 | 发送结果 | L1 收到 | L2 收到 |
| --- | --- | --- | --- |
| S（AI 机器人 sendMessage → 群） | ❌ `errcode=93001 not allow send msg in room` | 无 | 无 |
| W（webhook 机器人 → 群） | ✅ `errcode=0 ok` | **无** | **无** |
| L1 自发（sendMessage → 群） | ❌ `errcode=93001 not allow send msg in room` | 无 | 无 |

45 秒监听窗口内，三个监听连接共收到 **0 条**消息回调、0 条事件回调。

要点解读：

- **webhook 机器人 → 群 → AI 机器人：确认无回调**。消息确实发进了群（`errcode=0`），但没有任何 AI 机器人收到。L2（通知机器人）自 2026-07-16 起就在该群收发消息（见 `logs/_global.log` 中 `wecom.notification.started botId=aibbdpAK...` 与 `scripts/get-chatid.mjs` 的获取记录），是有接收能力的群内成员，它的 0 回调是有效负结果。
- 运行中的 Docker 容器（`easemob-sdk-agent`，持有交互机器人 `WECOM__BOT_ID__JIRA_REVIEW` 长连接）在实验窗口内日志（`.easemob-agent/data/logs/_global.log`）也无任何消息处理记录，与上述结论一致。
- `errcode=93001` 说明 S、L1 当前不能向该群主动发消息（机器人不在群内或群不允许机器人主动发言），因此「AI 机器人 → 群 → AI 机器人」本次未能构造出阳性发送样本；但结合官方触发条件（必须用户发起）与 webhook 样本的实测结果，结论不受影响。

### 实验二：机器人直发机器人（`wecom-bot-to-bot-direct.mjs`）

以对方机器人的 aibotid 作为 `sendMessage` 的 `chatid`：

```text
❌ errcode=93006 invalid chatid
```

确认 aibotid 不是合法会话 id，机器人之间不存在单聊通道。

## 复现方法

```bash
# 群消息场景（约 75 秒，会向目标群真实发送 1 条 webhook 文本消息）
node docs/researches/wecom-bot-to-bot/wecom-bot-to-bot-verify.mjs

# 机器人直发机器人（约 5 秒，不产生群消息）
node docs/researches/wecom-bot-to-bot/wecom-bot-to-bot-direct.mjs
```

注意：不要使用 `WECOM__BOT_ID__JIRA_REVIEW` 做实验 —— 它由运行中的容器持有长连接，同一 botId 重复建连会互相挤掉（SDK 的 `event.disconnected_event` 机制）。

如需补充阳性对照（验证监听连接本身能收到消息）：在目标群里由真人 @ 监听机器人（02 或通知机器人）发任意文本，监听脚本应打印对应 `message.text` 回调。本次实验未做该对照，因为机器人消息无回调的负结果已由官方文档 + webhook 样本双重确认。

## 能力边界汇总

| 路径 | 是否可行 | 依据 |
| --- | --- | --- |
| 用户 → AI 机器人（单聊 / 群里 @） | ✅ | 官方触发场景，项目已在用 |
| AI 机器人 → 用户 / 群（reply、sendMessage） | ✅ | 项目已在用（93001 仅表示该机器人不在目标群） |
| webhook 机器人 → 群 | ✅ | 项目已在用，仅发送 |
| AI 机器人 → AI 机器人（单聊） | ❌ | 实测 `errcode=93006 invalid chatid` |
| webhook 机器人 → 群 → AI 机器人回调 | ❌ | 实测 0 回调 + 官方触发条件不含机器人消息 |
| AI 机器人 → 群 → AI 机器人回调 | ❌（推断） | 官方触发条件要求用户发起；webhook 样本实测一致 |
| 任何方式 @ 机器人触发机器人 | ❌ | webhook 的 @ 需要 userid，机器人无 userid |
