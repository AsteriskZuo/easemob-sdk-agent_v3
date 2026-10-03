# 企业微信智能机器人（wecom-aibot）主动发送消息调研

调研日期：2026-10-03
调研目的：为「wecom-aibot 出口工具」（主动向用户/群投递业务产出）确认发送通道、消息体结构、限制与配置来源。已有三份前置调研（[wecom](../wecom/2026-07-11-wecom-aibot-research.md)、[wecom-aibot-mentions](../wecom-aibot-mentions/2026-07-16-wecom-aibot-mentions-research.md)、[wecom-bot-to-bot](../wecom-bot-to-bot/2026-08-05-wecom-bot-to-bot-research.md)），本文只补「主动发送」缺口，不重复其结论。

## 结论（先说结果）

**deliver 必须走 WebSocket 长连接（`aibot_send_msg`），没有独立的 HTTP 主动发送接口可用。** 智能机器人不是自建应用，拿不到 corpid/secret 换取的 access_token，`cgi-bin/message/send`、`cgi-bin/kf/send_msg` 均不适用。主动发送的唯一官方通道是长连接上的 `aibot_send_msg` 命令，SDK 已封装为 `sendMessage(chatid, body)`（本项目此前已真实验证）。

因此出口工具不能自建连接，**必须与入口 trigger 共享同一条长连接**（同一 botId 同时只能保持一个有效连接，新连接会踢掉旧连接，官方文档明确说明）。SDK 单实例天然支持「收回调 + 主动发」双用途，架构上该 botId 的 `WSClient` 收敛到连接属主类 `AibotConnector`（见「实现建议」），入口 trigger 与出口工具都从它注入收/发能力。

## 事实确认

### 1. sendMessage 完整请求体（msgtype、字段、长度、频率）

官方长连接文档（[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)）「主动推送消息」一节给出了 `aibot_send_msg` 的完整协议：

请求帧结构：

```json
{
  "cmd": "aibot_send_msg",
  "headers": { "req_id": "REQUEST_ID" },
  "body": {
    "chatid": "CHATID",
    "chat_type": 1,
    "msgtype": "markdown",
    "markdown": { "content": "..." }
  }
}
```

字段要点（官方文档原文）：

- `body.chatid`（必填）：会话 ID。单聊填用户 userid，群聊填群 chatid（从群聊相关回调事件中获取）。
- `body.chat_type`（选填）：`1` 单聊 / `2` 群聊 / `0` 或不填则兼容解析、**优先按群聊解析**，官方建议显式设置。⚠️ SDK 的 `sendMessage` 实现（[client.ts](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/client.ts)）只发送 `{ chatid, ...body }`，**不传 `chat_type`**，即默认走「优先群聊」解析——单聊 userid 恰好也未被占用为群 id 时可用（本项目已实测单聊 userid 发送成功），但存在歧义风险，实现时需注意。
- `body.msgtype`（必填）：官方文档明确支持 **`template_card`（模板卡片）、`markdown`**；「消息类型格式说明」表另列出 **file / image / voice / video**（均需先经长连接分片上传临时素材拿到 `media_id`）。
- **不支持 `text`，也不支持 `markdown_v2`**。SDK 类型 `SendMsgBody = SendMarkdownMsgBody | SendTemplateCardMsgBody | SendMediaMsgBody` 与官方一致。webhook 群机器人的 `text` / `markdown_v2` 类型不适用于智能机器人通道。

长度限制：

- `markdown.content`：最长 **20480 字节**（utf8）。来源：[主动回复消息](https://developer.work.weixin.qq.com/document/path/101138) 与长连接文档「markdown消息」节参数表。
- **webhook 的 markdown 4096 字节上限不适用**：4096 是「消息推送（原群机器人）」webhook 文档（[91770](https://developer.work.weixin.qq.com/document/path/91770)）里的限制，两套通道是不同接口。智能机器人主动发送按 20480 字节算。
- 媒体大小：图片 ≤10MB、语音 ≤2MB、视频 ≤10MB、普通文件 ≤20MB（上传初始化文档参数表）；分片 512KB/片、最多 100 片；`media_id` 3 天有效。

频率限制（官方长连接文档原文）：

- 「无论是回复还是主动推送消息，总共给某个会话发消息的限制为 **30 条/分钟，1000 条/小时**。」
- 「收到消息回调后，**24 小时内**可以往该会话回复消息。」
- 上传临时素材频率：30 次/分钟、1000 次/小时。
- 被动回复专属限制：欢迎语、更新模板卡片需事件回调后 5 秒内调用；流式消息 10 分钟内须 `finish=true`（长连接模式下无流式刷新回调，需主动推送刷新）。

### 2. 主动回复 API（`aibot/response?response_code=...`）

来源：[主动回复消息](https://developer.work.weixin.qq.com/document/path/101138)、[接收消息](https://developer.work.weixin.qq.com/document/path/100719)。

- `response_code` 内嵌在消息回调携带的 `response_url` 中（形如 `https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=XXX`），**只存在于「设置接收消息回调地址」（URL 短连接）模式的回调体里**。
- 有效期 1 小时，每个 `response_url` 只能调用一次。
- **不能脱离被动回复上下文主动发起**：`response_url` 只能由用户消息/模板卡片事件的回调下发，官方没有提供任何「凭空获取 response_code」的接口。它本质是给「异步被动回复」用的（先 ack 回调，业务处理完再补发结果）。
- 长连接模式的回调体**不含 `response_url`**（长连接文档的回调字段表无此字段），长连接场景下对应能力就是 `aibot_send_msg`。

结论：主动回复 API 不适合做出口工具通道——它依赖 entry 回调上下文、一次性、1 小时有效，且仅 URL 模式可用。出口应统一走 `sendMessage`。

### 3. 是否存在独立 HTTP 接口供主动发送

**未找到适用于智能机器人的 HTTP 主动发送接口。** 逐一核对：

- `cgi-bin/message/send`（发送应用消息）：属于**自建应用**体系，需要 corpid + 应用 secret 换取 `access_token` 和 agentid。智能机器人的凭证是 BotID + 长连接专用 Secret（长连接文档「获取凭证」节明确：Secret 是长连接专用密钥，与自建应用的 Token/EncodingAESKey 不同，文档未提供用其换 access_token 的任何方式），**不适用**。
- `cgi-bin/kf/send_msg`（微信客服消息）：面向客服账号，会话由用户咨询触发，与智能机器人是两套体系，**不适用**。
- 智能机器人全量官方接口（概述/接收消息/被动回复/主动回复/长连接/模板卡片）中，**没有任何一条 HTTP 主动发送接口**；主动发送只在长连接文档中以 `aibot_send_msg` 命令出现。

即：智能机器人是「长连接优先」设计，deliver 没有 HTTP 备选路径。

### 4. 主动触达限制

官方长连接文档「主动推送消息」节有明确前置条件（原文）：

> 「特殊的，**需要用户在会话中给机器人发消息，后续机器人才能主动推送消息给对应会话中**。」

即：**用户必须先在该会话（单聊或群聊）中给机器人发过消息**，机器人才获得向该会话主动推送的资格。对出口工具的含义：destination 里的会话 id 应来自真实发生过的用户交互（trigger 回调记录），不能凭空配置一个从未交互过的 userid/群 chatid 期望可达。

其他可达性约束（结合前置调研与错误码文档）：

- 群聊：机器人须在群内才能向群推送，否则 `errcode=93001`（前置调研实测）。
- chatid 必须是群 chatid 或用户 userid，否则 `93006`（前置调研实测）。
- 错误码官方释义（[全局错误码](https://developer.work.weixin.qq.com/document/path/90313)）：93001「当前群聊不允许推送消息」、93006「不合法的群ID」、93008「不在群里」、93017「发消息的请求内容不能为空」、93018「图片大小超过限制」、93019「不合法的机器人id」。全局错误码表挂在消息推送（webhook）章节下，但与 aibot 通道实测报错一致。
- 「用户从未交互过的单聊 userid 能否直接推送」：官方只给出上述「需先发过消息」的总括说明，**未找到针对单聊的更细则说明**；按官方总括要求实现即可覆盖。

### 5. 出口工具与 trigger 共享长连接的约束

官方长连接文档「连接数量限制」（原文）：

> 「每个智能机器人**同一时间只能保持一个有效的长连接**。当同一个机器人发起新的连接请求并完成订阅（aibot_subscribe）时，**新连接会踢掉旧连接**，旧连接将被服务端主动断开。」

并明确建议：「开发者需要在业务层面避免同一机器人建立多个长连接」「高可用建议主备切换而非同时多连接」。旧连接被踢时会收到 `disconnected_event` 事件（SDK 对应 `event.disconnected` / 内部 `onServerDisconnect`，此时 SDK 置 `started=false` 且不再自动重连——见 SDK client.ts `onServerDisconnect` 处理，它会断开旧连接后停在那里，不再重连）。

这与本项目此前实测互踢现象一致（见 bot-to-bot 调研）。对架构的硬约束：

- **同一 botId 的出口工具绝不可自行 `connect()`**，否则会把入口 trigger 的连接踢掉、且 SDK 被踢侧不会自动重连，入口静默失效。
- **SDK 单连接多用途**：同一个 `WSClient` 实例上，收消息回调（`on('message.text', ...)`）与主动发送（`sendMessage`，在 `authenticated` 后随时可发，无需回调帧）互不冲突，SDK README 的「主动推送消息」示例即在 `authenticated` 事件里直接 `sendMessage`。官方长连接整体交互流程也把「主动推送消息（无回调触发）」列为同一连接上的标准能力。相对地，多连接互踢行为已于 2026-10-03 实测确认（见本节下方「实测」小节）。
- 因此正确形态：**同一 botId 的收发能力收敛到一个连接属主对象上**，出口工具通过注入拿到该对象的发送能力，自己不持有连接生命周期。
- 无 trigger 常驻的场景（纯通知机器人）：由一个轻量连接属主服务持有连接，出口与入口一样从中取发送能力，仍然一个 botId 一条连接。

### 实测：同一 botId 单连接互踢（2026-10-03 本仓库 single-connection-verify.mjs 实测）

来源：2026-10-03 本仓库 `single-connection-verify.mjs` 实测（RESULT: PASS）。脚本用 v2 仓库 node_modules 里的 `@wecom/aibot-node-sdk` 构建产物，双 `WSClient` 同一 botId 先后建连，全程不发任何消息。

过程与结果：

1. A 先建连并 `authenticated`。
2. B 同一 botId 再建连并 `authenticated`。
3. A 立即收到 `event.disconnected_event`（服务端主动断开旧连接）和 `disconnected`，reason 原文为：

   ```text
   New connection established, server disconnected this connection
   ```

与官方文档「新连接踢掉旧连接」描述完全一致，且确认了 SDK 侧行为：被踢实例触发 `disconnected` 后不再自动重连（与 §5 对 `onServerDisconnect` 的源码分析一致）。

### 设计问题回答：出口工具是否可以自己持有 SDK 对象？

**可以持有 SDK 对象引用，但同一 botId 全平台只能有一个连接属主。** 具体规则：

- 收消息（入口）与发消息（出口）是同一个 `WSClient` 实例上的两类操作，互不冲突——SDK 对象本身同时支持两种用途，持有没有问题。
- 但每个 botId 同时只允许一条有效长连接。入口 trigger 与出口工具若**各自持有同 botId 的 `WSClient` 并各自 `connect()`**，后建者会把先建者踢掉，且被踢侧只收到 `disconnected_event`、SDK 不自动重连（见上方实测），入口静默失效、无消息可收，故障隐蔽。
- 结论：**接收入口和发送入口必须是同一个 SDK 实例上的操作**，该实例由装配根按 botId 管理的连接属主类持有（实现建议中的 `AibotConnector`）。入口与出口分别注入它的收/发能力，绝不可各自建连。
- 「持有」与「建连」要区分：出口工具持有连接属主的引用调用 `sendMessage` 是被允许的、也是推荐形态；禁止的是出口工具拿引用去 `connect()` 或自行 `new WSClient(...).connect()`。更稳妥的封装是出口只拿到一个「发送外观」（实现建议中的 `WecomAibotSender`，如 `sendMarkdown(chatid, text)`），从接口层面就不暴露 `connect()`。

## 风险与缺口

1. **SDK 不传 `chat_type`**：默认「优先按群聊解析」对单聊 userid 有理论歧义（若某 userid 恰好与某群 chatid 相同，消息会发进群）。官方建议显式设置。SDK `sendMessage` 无法传该字段（只收 `chatid, body`），如需消除歧义只能绕过 SDK 直接走 `wsManager`/自定义帧——第一版不建议，记录为已知风险；destination 里显式记录会话类型（single/group），便于将来必要时换实现。
2. **「先交互才能推送」的判定**：官方未提供查询接口确认某会话是否已获得推送资格，只能发送时以错误码（93001/93006 等）感知失败。出口工具失败处理应保留 errcode 原文。
3. **频率上限是「每会话」维度**（30/分钟、1000/小时），多出口绑定共享同一会话时互相挤占额度；批量投递场景需自行节流。
4. **上传素材 vs 消息发送两条频率通道**互相独立，但媒体投递（先 upload 再 send）链路长、失败点多，第一版建议只做 markdown 文本出口，媒体后续再做。
5. **连接被挤掉时出口静默失败**：SDK 被踢侧不自动重连（`started=false`），如果 trigger 与出口同进程同实例，被外部连接踢掉后两者一起失效。需要 trigger 层监控 `disconnected` 事件并告警/重连（重连又会踢掉对方，本质是配置冲突，应报警而非自动互踢）。
6. 官方文档对 `markdown` 主动推送**未列出 `feedback.id` 之外的扩展字段**（无 @ 参数），与 mentions 调研结论一致：需要 @ 提醒时只能另走 webhook 出口。

## 对出口工具实现的建议

### 通道选择

deliver 走**长连接 `sendMessage`**（不经 HTTP，不经 `aibot/response`）。出口工具自身不建连，从连接属主注入发送能力。

### 组件形态：工具类模式（owner 已定结论，与 jira/confluence/github 出口统一）

所有出口相关组件写成**无业务知识的工具类**：构造注入、类内零 `process.env`、零全局单例、调用方控生命周期（start/stop 由装配根负责）、可在别的程序/平台直接复用。具体到 wecom-aibot 拆两个类：

1. **`AibotConnector`（连接属主，按 botId 一个实例）**
   - 职责：一个 botId 全平台唯一的长连接——connect / 认证 / 断线重连 / 断开。这是它的唯一职责，也是「同一 botId 不能两条连接」这条铁律的落点。
   - 构造注入：botId + secret（从 EnvProvider 取值是装配根的事，类内不读环境）。
   - 对外接口：`onMessage(handler)`（订阅消息/事件回调）与 `sendMessage(chatId, body)`（主动发送）。
   - 不知道业务：不解析消息内容、不认识 jira/任务概念，只搬运消息。
2. **`WecomAibotSender`（出口工具用的发送外观）**
   - 构造注入 `AibotConnector` 实例——**不是 SDK 对象**，接口层面调不到 `connect()`，从类型上杜绝出口自建连接（呼应 §5 设计问题回答）。
   - 只暴露 `send`（如 `sendMarkdown(chatId, text)`），是出口工具实际依赖的接口。
   - 粒度说明：多业务、不同 botId/账号之间不做跨业务单例——每个 botId 一个 `AibotConnector` 实例，生命周期由装配根按部署配置管理。

### 出口薄适配（exit-tools 包）

`bind(config)` 拿到 `bot_id` 后向装配根**申请对应该 botId 的 `AibotConnector` 的 `WecomAibotSender`**（连接属主不在 bind 里创建，避免绑定层持有凭证/连接生命周期）；返回的 `Exit.deliver(payload)` 只做格式转换：payload → markdown 文本（字符串原样、对象走 json 围栏），按字节截断后调 sender.send。

### configSchema 建议（kind：`wecom-aibot`）

参照 `packages/exit-tools/src/types.ts` 的 `ConfigField` 形态：

| key | label | required | secret | 说明 |
| --- | --- | --- | --- | --- |
| `bot_id` | 机器人 ID（BotID） | 是 | 否 | 用于向装配根匹配对应 botId 的连接属主；凭证本身（botSecret）不入绑定配置，走 EnvProvider（装配根据此构造 AibotConnector） |
| `chat_id` | 会话 ID（群 chatid 或用户 userid） | 是 | 否 | 投递目标，来自真实交互过的会话 |
| `chat_type` | 会话类型（single/group） | 是 | 否 | 冗余记录用于消除 SDK 不传 `chat_type` 的解析歧义、以及日志可读性 |

botSecret 不进 configSchema（secret 项不落绑定配置、由控制台写入 EnvProvider；且出口与 trigger 必须共用同一凭证/同一连接，不应在绑定层重复填写）。

### destination_id 配置来源建议

destination_id = 「机器人 id + 会话 id + 用户 id」三维的来源：

- **机器人 id**：决定走哪条长连接（一个绑定对应一个 botId 的 AibotConnector）。来源：绑定配置的 `bot_id`。
- **会话 id（群 chatid 或单聊对象）**：**必须来自真实交互**——该机器人真实收到过的消息/事件回调（`chatid` 或 `from.userid`），满足「用户先交互才能推送」的官方前置条件，保证 destination 可达。建议由 trigger 在会话建立时沉淀「会话目录」（botId → 见过的 chatid/userid + chattype），出口配置从目录中选取或校验，而不是允许手填任意 id。
- **用户 id**：投递落点归因/日志用（谁触发了这条业务产出、结果发回给谁），来自触发该任务的回调 `from.userid`；群聊投递时用户 id 用于记录触发者，单聊时与 chat_id 同值。

destination_id 拼接待定（由 spec 定），但三维数据来源即上述：绑定配置提供 bot_id，trigger 会话目录提供会话 id，任务事件提供用户 id。

### 实现注意

1. 截断阈值按 **20480 字节**（utf8）留余量（如 20000），不要沿用 `wecom-webhook.ts` 的 4000。
2. 消息体用 `msgtype: 'markdown'`（唯一可用的文本类主动发送类型；无 text）。
3. 失败时保留 errcode/errmsg 原文；93001/93006 视为目标不可达，调度循环按失败处理即可，不做无限重试。
4. 出口 `bind`/`deliver` 时若对应 botId 的连接未建立，`WecomAibotSender.send` 抛带 botId 的明确错误（由 AibotConnector 的在线状态决定；出口不自连、不重连）。
