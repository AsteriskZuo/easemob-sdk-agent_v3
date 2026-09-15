# 入口适配器

> 机制文档。术语定义见 `design/glossary.md`。接口契约定义见 `design/core-modules.md` §4.8，本文是入口机制与规则的收口。

## 1. 定位

一个事件源一个独立小模块（wecom / jira / github / cron / manual / …）。**新事件源 = 新增一个入口小模块，不动内核**（出入口对称抽象，见骨架 §2）。同一类平台的不同实例/生态按独立 source 处理（如 github / gitee / feishu 各自一个入口）。

## 2. 职责链（固定四步）

**验签 → 包装信封（含 session_id）→ 落队 → 立即返回。**

- **入口永远轻快**：接收即落库，落库才算收到，背压天然成立（见 `design/event-contract.md` §3）；
- **入口懂业务，信封带答案**：源适配（含各来源会话标识提取规则）在入口完成，心脏只读信封字段；
- 形态为**接口而非基类**（已定）：各源差异大（webhook 接收 / 定时触发 / 手动触发），契约一致即可；重复代码真出现时以普通工具函数沉淀，不立继承体系（见 `design/core-modules.md` §4.8）。

## 3. 各源规则索引

| 事项 | 唯一定义处 |
|------|-----------|
| 验签（HMAC / 时间戳防重放） | `design/security.md` |
| 信封字段与包装规则 | `design/event-contract.md` §1 |
| session_id 提取（源生会话标识，平台不生成） | `design/channel-model.md` §4 |
| 第一层入口幂等（event_id 识别源生重推并丢弃） | `design/event-contract.md` §1 |
| EntryAdapter / EntryDeps 接口 | `design/core-modules.md` §4.8 |

## 4. 定时与手动入口

- **定时到点 = 包装成任务入队，不直接执行**——所有触发走同一条队列，语义统一（见 `design/console-design.md` §5）；
- cron / manual 天然无会话：session_id 以业务标识兜底 → **业务级串行**（见 `design/scheduler.md` §3）。

## 5. 入口与业务的绑定

入口配置即业务的触发身份，与业务**机械绑定**（不会错配）；一个业务可绑定多个入口，**每个入口独立决定自己的会话标识规则**（见 `design/channel-model.md` §5）。

## 6. 出口说明（对照）

出口不是入口的对称模块，而是**任务队列中的可选任务**：业务结果统一包装成信封回队，由出口型业务（结果处置 = 终结）关注并消化；触达外部系统的能力（企微通知、Jira 编辑等）以 public skill 形式由 Skill 包仓提供（见 `design/glossary.md` 出口词条）。
