# 决策：agent 内核选型与执行模式

- **日期**：2026-09-27
- **状态**：已定
- **依据**：`docs/researches/pi-hooks/2026-09-26-pi-hooks-research.md`、`docs/researches/codex-cli-hooks/2026-09-26-codex-cli-hooks-research.md`、`docs/researches/jira-review-masking-hooks/`（2026-09-27 两份，真实工单 HIM-23706 + 外部模型实测）

## 结论

1. **agent 内核选 pi**（npm 包 `@earendil-works/pi-coding-agent`，项目依赖锁定版本，不依赖系统安装）。不支持 codex-cli 作为内核。
2. **业务 run 一律子进程执行**（pi CLI + `-e` 注入业务 hook），不用 SDK 同进程模式。
3. **沙箱分期**：第一阶段不上沙箱（可信内置业务 + hook 守卫 + systemd 加固）；服务化/开放自定义 skill 前必须上 OS 级隔离。macOS 用 Seatbelt（`sandbox-exec`），Linux/Ubuntu 用 Docker 或 bubblewrap——均免费。
4. **沙箱不需要桥接模块**：第一阶段就把执行器收敛为薄 Runner 契约（任务 = 工作目录 + 注入凭据 + extension 集 + 模型配置），第二阶段换 Runner 实现即可。

## 依据

### pi vs codex-cli（hooks 能力实测对照）

| | pi 0.87.1 | codex-cli 0.154.0 |
|---|---|---|
| 前置检查 | `input` 可阻断可**改写** | `UserPromptSubmit` 只能阻断，不能改写 |
| 中间处理 | `tool_call` 阻断/改入参、`tool_result` 改结果，handler 抛错 fail-safe | `PreToolUse` deny/改入参、`PostToolUse` 替换模型可见结果 |
| 后置检查 | `message_end` **可直接改写最终输出** | `Stop` 只能打回重写，不能改文本 |
| 边界审计 | `before_provider_request` 落盘真实 LLM 请求体，**泄漏审计可闭环** | 无请求体挂点，transcript 留档与模型可见内容不可区分，**审计无法闭环** |
| hook 形态 | 同进程 TS 模块，直接 import 业务模块 | 外部子进程脚本（stdin/stdout JSON） |
| 动态注入 | `-e` 白名单、环境变量、按业务 agent 目录、SDK 内联 | `-c` 内联、`-p` profile、`CODEX_HOME`、项目级 |
| 独有大坑 | 阻断 ≠ 终止 run；exit=0 无报错 | 无头未信任 hook **静默跳过**；resume 场景 hook 不齐全 |

实测对照（同一份真实工单 + deepseek 外部模型）：pi 版链路一次跑通（约 10 分钟，LLM 请求体 0 泄漏、还原 8/8）；codex 版 41 分钟卡在泄漏审计无法闭环，按用户决策中止。两者 hook 语义差异大，双内核适配代价高，**不值得保留 codex 适配层**。

### 子进程 vs SDK 同进程

SDK 同进程（`createAgentSession` + `extensionFactories`）实测可行且 hook 注入最方便，但放弃，理由三条汇合：

- **故障隔离**：同进程下任一业务 hook/skill 的崩溃、死循环、`process.exit` 会拖垮整个平台进程；
- **沙箱兼容**：沙箱隔离的单位是进程，同进程模式与未来沙箱天然冲突，现在用了将来要拆债；
- **工作目录与权限**：业务 run 需要各自的工作目录（如日志分析读各自 git 仓库）并执行 shell，子进程的 cwd + 权限边界天然到位。

Node 并发不是约束：平台负载是 I/O 密集（等 LLM API），事件循环天然胜任；`task_concurrency` 闸门是信号量逻辑，与线程无关。CPU 密集环节出现时再用 `worker_threads`，属实现期事项。

### 沙箱分期与免费方案

- 威胁模型：无人值守 + 工单内容半不可信（提示注入可诱导 LLM 动作）→ 服务化前必须有 OS 级隔离；MVP 阶段（内置可信业务）可缓。
- macOS：Seatbelt（`sandbox-exec`，系统自带，免费，codex 同款机制）。
- Ubuntu：首选 Docker（隔离 + 依赖打包一体，衔接 `docs/researches/docker/`）；轻量过渡用 bubblewrap（无守护进程，包一层 pi 子进程）；systemd 加固指令作零成本基线。
- 零桥接的前提（第一阶段的纪律）：业务 run 从第一天起就走子进程；每个 run 的资源需求（可写工作目录、只读仓库、注入凭据）显式声明——这些声明就是第二阶段沙箱 profile/容器配置的直接输入；裸跑期警惕代码产生越界隐性依赖，可用沙箱模式冒烟及早暴露。

## hooks 三条设计纪律（回写设计文档时采用）

1. **fail-closed**：hook 解析/执行异常 = 阻断，不是放行（codex 是 fail-open，pi 需平台侧保证）。
2. **判定自写日志**：hook 阻断不反映在进程退出码（两家都是 exit 0），平台门禁判定以 hook 自写的结构化判定日志为准。
3. **边界审计挂点**：`before_provider_request` 落盘真实 LLM 请求体，是「敏感内容不出边界」的唯一直接证据。

## 待回写设计文档（后续任务）

- 执行器契约：Runner 接口 + per-run 资源声明（含「pi 无沙箱、平台外层补」的说明）。
- hooks 机制：挂接点 + 契约 + 上述三条纪律；glossary 门禁词条改写（机械部分归平台钩子，语义部分留 skill）。
- skill 规范：skill 可附带 pi extension 做 run 内钩子（脱敏、工具拦截），平台经 `-e` 白名单注入。
- 已知待修：脱敏模块白名单缺 `attachments[].content`（实测内网域名曾因此泄漏，见 pi 版调研报告）。
