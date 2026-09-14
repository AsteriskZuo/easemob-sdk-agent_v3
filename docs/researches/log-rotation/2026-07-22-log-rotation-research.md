# 日志轮转与膨胀治理调研

日期：2026-07-22

## 背景

开发过程中发现 `.easemob-agent/logs/_global.log` 增长到 33000+ 行，引出生产环境日志膨胀的治理问题。本次调研回答：

1. 能否不改代码，把日志切割、压缩、清理交给部署环境（"零代码"方案）。
2. 各种做法与本项目日志写入方式是否兼容。
3. 各部署场景（Linux 生产、macOS 开发机、Docker）分别推荐什么。

## 本项目日志写入方式（事实确认）

`src/utils/logger.ts` 的 `JsonlLogger`：

- 每条日志调用 `fs.promises.appendFile()`，**每次写入都重新按路径打开文件**，不持有常驻文件句柄。
- 文件名固定：有 `sessionId` 时写 `<sessionId>.log`，否则写 `_global.log`，均在 `<dataDir>/logs/` 下。
- 实际产生的日志分两类：`_global.log`（无 session 上下文的日志汇聚于此，持续增长，是需要治理的对象）；按工单维度的会话日志（如 `jira_forwarded__issue__HIM-22374.log`），每工单一个文件、体量小且随工单生命周期自然停止增长，**不需要切割**。
- 格式为 JSONL（每行一个 JSON 对象），gzip 压缩率通常在 90% 以上。
- 支持 `LOG_LEVEL` 级别过滤（debug/info/warn/error/silent）。

**关键结论**：因为每次写入都重新打开文件，logrotate 默认的"重命名旧文件"策略天然兼容——重命名后应用下次写入会自动创建新的同名文件，**不强制要求 `copytruncate`**。这与常见的"应用持有常驻句柄的流式写入"不同（那种场景必须 `copytruncate` 或通知应用重开文件）。

注意：如果未来 logger 改为常驻句柄的流式写入（出于性能考虑是常见演进方向），本结论失效，届时 logrotate 配置必须补 `copytruncate`。

## 方案对比

### 方案 A：Linux logrotate（生产推荐，零代码）

宿主机放置配置文件（如 `/etc/logrotate.d/easemob-agent`）：

切割范围只针对 `_global.log`；按工单维度的会话日志（`jira_forwarded__issue__*.log`）不切割，保留原文件。

```text
/app/.easemob-agent/logs/_global.log {
    weekly             # 每 7 天切割一次
    rotate 4           # 保留最近 4 份（约 1 个月），更老的自动删除
    maxsize 100M       # 不到 7 天就超过 100M 也立即切割
    dateext            # 归档按日期命名（_global.log-20260722.gz），便于排查且避免重名
    compress           # 旧日志 gzip 压缩
    delaycompress      # 最近一份不压，方便直接 tail 排查
    missingok          # 文件不存在不报错
    notifempty         # 空文件不切
    su <app用户> <组>   # 日志目录属主非 root 时需要，按部署用户填写；目录属主即 root 可删除此行
}
```

- logrotate 由系统 cron 每日自动执行，与应用进程无关。
- 当前 logger 实现下无需 `copytruncate`；如上所述，若未来改为常驻句柄写入则必须补上。
- 不加 `create`：切割后不预建空文件，应用下次写入时自动重建。
- 只切割 `_global.log` 也回避了一个 logrotate 的坑：若用 `*.log` 匹配按工单的会话文件，工单结束后原文件消失，`missingok` 会跳过该条目，其历史归档（`.1`、`.2.gz`）永远不会推进到 `rotate` 上限被清理，长期积累不受控。
- Docker 场景：前提是日志目录挂载了宿主机 volume，在**宿主机**上配置 logrotate，路径指向挂载点。容器内不需要安装任何东西。若未挂载 volume 则本方案不适用。

### 方案 B：macOS newsyslog（开发机可选）

macOS 无 logrotate，对应物为 newsyslog。在 `/etc/newsyslog.d/easemob-agent.conf` 写一行：

```text
# logfile                                                                                  owner:group     mode count size   when flags
/Users/<user>/Codes/ai/easemob-sdk-agent_v2/.easemob-agent/logs/_global.log               <user>:staff    644  7     10240  *    Z
```

含义：超过 10MB 切割，保留 7 份，压缩。由系统定时任务自动执行。

**判断**：开发机一般不值得配置。日志膨胀的治本是减少源头日志量（见"源头减量"），偶发膨胀时手动截断即可：

```bash
: > .easemob-agent/logs/_global.log
```

用重定向截断而不是 `rm`，避免删除后被打开的引用造成困惑（当前 logger 每次重新打开文件，`rm` 后也会自动重建，但截断更稳妥）。

### 方案 C：Docker 日志驱动（不适用）

Docker 的 `json-file` driver 支持 `--log-opt max-size=10m --log-opt max-file=5` 自动轮转，**但只管理容器的 stdout/stderr，不管容器内文件**。本项目日志写文件，因此不适用。除非把日志改为输出到 stdout（如 symlink 到 `/dev/stdout` 的 hack），但会与企微 SDK 的 console debug 输出混杂，可读性差，不推荐。

## 源头减量（与轮转互补）

轮转解决"文件无限增长"，不解决"有效信息被噪音淹没"。三个减量手段：

1. **日志级别**：生产配置 `LOG_LEVEL=info`（或更高），开发排查时临时开 `debug`。
2. **减少重复日志**：例如 Jira polling 对已知非 Bug 工单每轮重审并重复打日志的问题（截至本文档日期，skip 结果未纳入去重，只有 pass 去重）。这类源头优化优先级高于轮转。
3. **排查丢失 sessionId 的日志**：`_global.log` 膨胀到 33000+ 行说明大量日志没有带上 `sessionId`（`withLogContext` 上下文覆盖不全）。把它们归位到对应工单/会话日志，既减小 `_global.log`，也让排查更聚焦。

另注意：企微 SDK（`@wecom/aibot-node-sdk`）的 `[AiBotSDK] [DEBUG]` 输出走 `console.debug`，不经过 `JsonlLogger`，文件轮转方案管不到它。如需纳入文件日志，要在创建 WSClient 时注入自定义 logger 桥接（SDK 支持注入含 debug/info/warn/error 四方法的 logger）。

## 结论

| 场景 | 推荐做法 | 改动量 |
|---|---|---|
| 生产（Linux 宿主机 + 挂载 volume） | 宿主机 logrotate（方案 A） | 一个配置文件，代码零改动 |
| 开发机（macOS） | 不配轮转；调日志级别 + 手动截断 | 0 |
| Docker stdout 方案 | 不适用（日志在文件里） | — |

落地路径：生产环境配一个 logrotate 文件（只切割 `_global.log`，每 7 天一次）即可，代码零改动；按工单的会话日志不切割；开发机的膨胀靠日志级别和源头减量解决。
