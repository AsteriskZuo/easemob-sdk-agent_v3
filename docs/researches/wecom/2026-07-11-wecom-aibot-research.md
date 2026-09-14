# 企业微信智能机器人接入调研

> 日期：2026-07-11  
> 状态：调研结论  
> 范围：企业微信作为本项目 Docker 服务的消息入口和通知出口

## 结论

企业微信支持把用户消息转给外部系统处理。对本项目来说，推荐第一版使用：

```text
企业微信智能机器人 API 模式 - 长连接
+ 官方 Node SDK：@wecom/aibot-node-sdk
```

原因：

- 符合当前架构：企业微信只负责 Trigger Layer 和 Result Handler，智能、Jira、Codex CLI、skill / tool 编排仍由本项目 Docker 服务负责。
- 不需要公网 URL。长连接由 Docker 服务主动连到企业微信 WebSocket 网关，适合内网部署。
- 官方 SDK 已处理认证、心跳、重连、事件分发、文本回复、主动发送、文件下载解密等底层问题，不需要复制第一版正式代码，也不需要手写 WebSocket 协议。
- 当前真实配置中已经存在 `WECOM__BOT_ID` / `WECOM__BOT_SECRET`，和 API 模式长连接的凭证模型一致。

第一版建议只做文本闭环：

```text
收到企业微信文本消息
-> 转成内部 task 或 command
-> 调用 Task Router / Codex Runtime
-> 把最终结果回复企业微信
```

图片、文件、语音、卡片交互、群聊复杂上下文可以后续再做。

## 资料来源

第一版已有调研资料：

- `/Users/asterisk/Codes/ai/easemob-sdk-agent/docs/research/wecom/README.md`
- `/Users/asterisk/Codes/ai/easemob-sdk-agent/docs/research/wecom/path-handling.md`

官方资料：

- 企业微信 API 模式机器人帮助页：<https://open.work.weixin.qq.com/help2/pc/21704>
- 企业微信消息推送配置说明：<https://developer.work.weixin.qq.com/document/path/91770>
- 企业微信发送应用消息：<https://developer.work.weixin.qq.com/document/path/90236>
- 企业微信智能机器人 Node SDK：<https://www.npmjs.com/package/@wecom/aibot-node-sdk>
- 企业微信 OpenClaw 插件 CLI：<https://www.npmjs.com/package/@wecom/wecom-openclaw-cli>

本次没有读取第一版正式代码，只读取了第一版调研文档，避免把旧实现结构带入当前项目。

## 方案对比

| 方案 | 能否收消息 | 是否需要公网 | 是否适合本项目 | 结论 |
| --- | --- | --- | --- | --- |
| 智能机器人普通模式 | 是 | 否 | 不适合，智能在企业微信侧 | 不采用 |
| 智能机器人 API 模式 - 长连接 | 是 | 否 | 适合，智能在本项目侧 | 推荐 |
| 智能机器人 API 模式 - URL 回调 | 是 | 是 | 可用，但部署前置条件多 | 备选 |
| 自建应用回调 + 发送应用消息 | 是 | 是 | 可做企业应用入口，但体验不是智能机器人 | 兜底 |
| 普通群机器人 Webhook | 主要用于发送通知 | 否 | 不适合作为收消息入口 | 不采用 |

## 长连接能力确认

企业微信 API 模式机器人官方帮助页说明长连接是 WebSocket 通道，由开发者服务器主动连接企业微信。关键机制包括：

- 使用 `wss://` 建立持久连接。
- 建连后通过 Bot ID 和 Secret 订阅认证。
- 通过心跳保持连接。
- 支持流式回复，适合大模型逐步输出。
- 适合内网部署，因为不需要公网 IP 或对外 URL。

`@wecom/aibot-node-sdk` 是官方 Node SDK，npm 包信息显示：

```text
name: @wecom/aibot-node-sdk
version: 1.0.7
description: 企业微信智能机器人 Node.js SDK - WebSocket 长连接通道
repository: https://github.com/WecomTeam/aibot-node-sdk
```

SDK README 记录的能力包括：

- `WSClient.connect()` / `disconnect()`。
- 自动认证、心跳、断线重连。
- 事件：`message.text`、`message.image`、`message.file`、`event.enter_chat`、`event.template_card_event` 等。
- 被动回复：`replyStream()`、`replyWelcome()`、`replyTemplateCard()`。
- 主动发送：`sendMessage(chatid, body)`。
- 文件下载解密：`downloadFile(url, aesKey)`。

这已经覆盖第一版需要验证的“收到用户消息”和“回复 / 通知用户”两类能力。

## 管理员配置要求

长连接机器人不是任意成员都一定能创建。企业微信帮助页记录：

- 管理员可在企业微信管理后台的智能机器人管理页配置“API 模式管理”。
- 管理员可授权哪些成员能创建长连接方式智能机器人。
- 如果成员无权限，可以向超级管理员申请。
- URL 回调方式还涉及可信域名或 IP 配置。

因此实际落地前需要运维 / 管理员确认：

1. 当前企业是否开放智能机器人 API 模式。
2. 机器人是否选择“使用长连接”。
3. 当前 Bot ID / Secret 是否仍有效。
4. 机器人可见范围是否包含测试用户 / 测试群。
5. Docker 运行环境能否访问 `wss://openws.work.weixin.qq.com`，私有部署企业需确认专用 `wsUrl`。

## URL 回调备选

如果后续不用长连接，也可以选 API 模式 URL 回调。但它有明确前置条件：

- 企业微信需要从公网访问我们的回调 URL。
- `127.0.0.1`、`localhost`、`10.x.x.x`、`192.168.x.x` 等内网地址不可用。
- HTTPS 证书需要有效，不能用自签名或过期证书。
- URL 校验阶段必须返回解密后的明文 `echostr`。

URL 回调比长连接多出公网、证书、Token、EncodingAESKey、消息加解密和验签处理。第一版不推荐把它作为主路径，但验证脚本保留了本地验签 / 解密工具，方便后续运维配置公网回调时自测。

## 与当前架构的关系

企业微信在当前架构中不是普通业务 skill，而是长期运行的服务模块：

```text
Docker 服务
├── Trigger Layer
│   └── 企业微信长连接监听
├── Task Router
│   └── 根据文本命令 / 会话上下文创建 task
├── Runtime Adapter
│   └── Codex CLI
└── Result Handler
    └── 企业微信回复 / 通知
```

推荐边界：

- `wecom trigger` 负责连接、接收、鉴权、重连、消息去重和最小解析。
- `Task Router` 决定消息属于 `jira_ticket_review`、`bug_fix` 还是普通命令。
- `Result Handler` 负责把最终结果发回企业微信。
- skill 只描述业务能力和操作约束，不直接维护长连接生命周期。

第一版必要文件可以很少：

```text
src/wecom/
  client.ts          # 包装 @wecom/aibot-node-sdk，隐藏 SDK 细节
  message-mapper.ts  # 企业微信消息 -> 内部 trigger event
  notifier.ts        # 内部结果 -> 企业微信消息
```

不建议沿用第一版“拆很多文件”的结构，除非实现时出现真实复杂度。

## 会话和去重建议

SDK 消息体包含这些重要字段：

- `msgid`：消息唯一标识，可用于去重。
- `aibotid`：机器人 ID。
- `chatid`：群聊 ID，群聊时返回。
- `chattype`：`single` 或 `group`。
- `from.userid`：发送者。
- `msgtype`：消息类型。
- `text.content`：文本内容。

第一版内部事件建议保留最小字段：

```ts
type WecomTriggerEvent = {
  source: 'wecom';
  msgid: string;
  chattype: 'single' | 'group';
  chatid?: string;
  userId: string;
  text: string;
  rawCreatedAt?: number;
};
```

会话 key 建议：

```text
单聊：wecom:single:<userId>
群聊：wecom:group:<chatId>
```

群聊里是否按用户再隔离上下文，属于产品行为决策，不建议第一版提前扩展。当前只需要支持“群里 @ 机器人触发任务”，就先按群会话处理。

去重建议写入 Task Store：

```text
dedupeKey = wecom:<msgid>
```

如果同一个 `msgid` 已处理，不再创建新 task。

## 文件和附件

沿用第一版路径处理结论：

```text
文件内容不穿透 agent/core。
远端文件用 URL 表示。
本地文件必须用 agent 进程可访问的绝对路径表示。
相对路径不支持。
```

企业微信图片 / 文件消息通常包含加密 URL 和 `aeskey`。SDK 已提供 `downloadFile(url, aesKey)`，因此后续支持附件时推荐：

```text
wecom adapter 收到文件
-> 立即 downloadFile 解密
-> 保存到 Docker 内部临时目录
-> 把本地绝对路径放入内部上下文
```

第一版先忽略非文本消息，并回复明确提示即可。

## 验证脚本

脚本路径：

```bash
docs/research/wecom/wecom-aibot-verify.mjs
```

默认配置文件：

```bash
/Users/asterisk/Codes/ai/easemob-sdk-agent/.easemob-agent/config.json
```

### 1. 本地配置检查

不连接企业微信，不发送消息，只检查配置中是否存在 Bot ID / Secret：

```bash
node docs/research/wecom/wecom-aibot-verify.mjs
```

使用第二组机器人凭证：

```bash
node docs/research/wecom/wecom-aibot-verify.mjs --bot-index 2
```

### 2. 长连接验证

需要安装官方 SDK：

```bash
npm install @wecom/aibot-node-sdk
```

连接企业微信并监听 30 秒：

```bash
node docs/research/wecom/wecom-aibot-verify.mjs --connect
```

连接后，给机器人发一条文本消息。脚本应该输出：

```text
[event] connected
[event] authenticated
[event] message.text {"msgid":"...","chattype":"single","from":"...","content":"..."}
```

如果要测试回复闭环：

```bash
node docs/research/wecom/wecom-aibot-verify.mjs --connect --reply-echo --listen-seconds 60
```

脚本收到文本后会用 `replyStream()` 回复：

```text
echo: <用户消息>
```

这个参数会真实发消息，测试前需要确认机器人可见范围和测试对象。

私有部署企业如果有专用 WebSocket 地址：

```bash
node docs/research/wecom/wecom-aibot-verify.mjs --connect --ws-url 'wss://<private-wecom-ws>'
```

### 3. URL 回调验签 / 解密验证

如果后续选择 URL 回调，可用脚本验证企业微信 URL 校验参数：

```bash
node docs/research/wecom/wecom-aibot-verify.mjs \
  --verify-callback '{"token":"...","encodingAesKey":"...","corpId":"...","msg_signature":"...","timestamp":"...","nonce":"...","echostr":"..."}'
```

脚本会：

- 按企业微信回调规则计算 SHA1 签名。
- 比对 `msg_signature`。
- 使用 `encodingAesKey` 解密 `echostr`。
- 如果传入 `corpId`，额外检查解密出的 receiveId 是否匹配。

## 本次已执行的验证

已在当前项目执行：

```bash
node --check docs/research/wecom/wecom-aibot-verify.mjs
node docs/research/wecom/wecom-aibot-verify.mjs
```

结果：

- 脚本语法检查通过。
- 真实配置中存在 `WECOM__BOT_ID` 和 `WECOM__BOT_SECRET`。
- 默认模式不会连接企业微信，也不会发送消息。

未执行 `--connect`，因为当前项目未安装 `@wecom/aibot-node-sdk`，并且真实连接 / 回复会触达企业微信环境。后续安装 SDK 后可以直接按上面的步骤验证。

## 后续实现建议

第一版实现建议保持小边界：

1. 引入 `@wecom/aibot-node-sdk`。
2. 封装一个 `WecomClient`，只暴露：
   - `start()`
   - `stop()`
   - `onTextMessage(handler)`
   - `replyText(frameRef, text)`
   - `sendMarkdown(chatid, markdown)`
3. 把企业微信消息映射成内部 trigger event。
4. 使用 `msgid` 做幂等，避免断线重连或重复回调导致重复任务。
5. 非文本消息第一版直接提示“不支持，请发送文本或 Jira key”。
6. 把主动通知能力放在 Result Handler，不让模型直接操作企业微信连接。

暂不建议第一版做：

- 完整 OpenClaw 插件集成。
- 自研 WebSocket 协议。
- 卡片交互。
- 文件 / 图片下载和解析。
- 多机器人动态路由。
- 企业微信 MCP。

这些能力都有价值，但不是当前 Jira 审查 / bug_fix 最小闭环的前置条件。
