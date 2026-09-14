# 企业微信智能机器人 @ 群成员能力调研

> 日期：2026-07-16  
> 状态：调研结论  
> 范围：企业微信智能机器人 / AI Bot 回复消息是否支持 @ 群成员

## 结论

企业微信智能机器人当前官方文档没有提供“机器人回复时 @ 群成员”的能力参数。

如果业务使用的是企业微信智能机器人 API 模式，无论是被动回复还是主动回复，官方文档列出的回复消息结构里都没有 `mentioned_list`、`mentioned_mobile_list` 或等价的 @ 参数。把这些字段直接塞进智能机器人回复体，或在内容里拼 `@张三`、`<@userid>`，不能按官方文档推断为可用能力。

支持 @ 群成员的是另一套能力：`消息推送（原“群机器人”）` webhook。它不是智能机器人回复接口。

## 官方资料

### 消息推送支持 @

官方文档：<https://developer.work.weixin.qq.com/document/path/91770>

文档确认点：

- `消息推送（原“群机器人”）` 可以通过 webhook 向群组发送消息。
- 文本消息支持 `mentioned_list` 和 `mentioned_mobile_list`。
- `mentioned_list` 是 userid 列表，可提醒群中的指定成员；`@all` 表示提醒所有人。
- `mentioned_mobile_list` 是手机号列表，也可用于提醒对应群成员；`@all` 表示提醒所有人。
- 文档还说明 `text/markdown` 类型消息支持在 `content` 中使用 `<@userid>` 扩展语法来 @ 群成员，但 `markdown_v2` 不支持该扩展语法。

示意结构：

```json
{
  "msgtype": "text",
  "text": {
    "content": "广州今日天气：29度，大部分多云，降雨概率：60%",
    "mentioned_list": ["wangqing", "@all"],
    "mentioned_mobile_list": ["13800001111", "@all"]
  }
}
```

### 智能机器人回复未暴露 @ 参数

官方文档：

- 智能机器人概述：<https://developer.work.weixin.qq.com/document/path/101039>
- 接收消息：<https://developer.work.weixin.qq.com/document/path/100719>
- 被动回复消息：<https://developer.work.weixin.qq.com/document/path/101031>
- 主动回复消息：<https://developer.work.weixin.qq.com/document/path/101138>

文档确认点：

- `接收消息` 示例中，用户发给机器人的消息内容可能包含 `@RobotA hello robot`。这说明“用户 @ 机器人触发机器人”是支持场景。
- `被动回复消息` 的文本消息结构只包含 `msgtype: "text"` 和 `text.content`。
- `主动回复消息` 示例使用 `aibot/response?response_code=...`，消息结构示例为 `msgtype: "markdown"` 和 `markdown.content`。
- 上述智能机器人回复文档没有列出 `mentioned_list`、`mentioned_mobile_list`、`<@userid>` 或其他提醒群成员的参数说明。

示意结构：

```json
{
  "msgtype": "text",
  "text": {
    "content": "hello\nI'm RobotA\n"
  }
}
```

## 能力边界

| 能力 | 是否支持 @ 群成员 | 说明 |
| --- | --- | --- |
| 消息推送（原“群机器人”）webhook | 支持 | 文本消息支持 `mentioned_list`、`mentioned_mobile_list`；`text/markdown` 支持 `<@userid>` 扩展语法 |
| 智能机器人接收消息 | 不适用 | 用户可以 @ 机器人，机器人收到包含 @ 机器人的文本内容 |
| 智能机器人被动回复消息 | 官方未提供 | 回复格式没有 @ 参数 |
| 智能机器人主动回复消息 | 官方未提供 | 回复格式没有 @ 参数 |

## 工程判断

如果当前目标是“机器人回复时提醒某个群成员”，不要继续在智能机器人回复体里尝试 `mentioned_list`、`mentioned_mobile_list` 或 `<@userid>`。这些字段属于消息推送 webhook 文档，不属于智能机器人回复接口。

更稳妥的实现边界是：

- 智能机器人负责接收用户消息、参与对话、返回普通文本或 markdown。
- 需要强提醒时，由服务端另行调用 `消息推送（原“群机器人”）` webhook 发送一条带 @ 的通知。

## 可行替代方案

### 方案一：智能机器人回复 + 群机器人 webhook 强提醒

流程：

```text
用户 @ 智能机器人
-> 本服务处理任务
-> 智能机器人回复普通结果
-> 如需提醒指定人，本服务调用群机器人 webhook 发送带 @ 的消息
```

适用场景：

- 既需要保留智能机器人交互入口。
- 又需要企业微信原生 @ 提醒效果。

约束：

- 群里需要额外配置消息推送 webhook。
- 这会产生两条消息：一条 AI Bot 回复，一条 webhook 通知。

### 方案二：仅使用消息推送 webhook 做通知

流程：

```text
本服务完成任务
-> 调用消息推送 webhook
-> 发送文本或 markdown，并使用 mentioned_list / mentioned_mobile_list @ 人
```

适用场景：

- 只需要通知结果，不需要 AI Bot 对话链路。

约束：

- webhook 更像通知出口，不适合作为完整的消息接收入口。

## 后续建议

当前不要把“AI Bot 回复支持 @”作为实现前提。若产品上必须有 @ 提醒，应把它设计为独立通知出口，并明确依赖企业微信群里的 `消息推送（原“群机器人”）` webhook 配置。

