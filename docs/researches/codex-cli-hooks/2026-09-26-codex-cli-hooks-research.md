# codex-cli hooks 能力调研报告

- **调研对象**：codex-cli **0.154.0**（本机 `/opt/homebrew/bin/codex`，homebrew arm64 构建）
- **调研日期**：2026-09-26
- **调研目的**：评估 codex-cli 作为平台无头 agent 内核时，对「前置检查 / run 内中间处理 / 后置检查」三类钩子的支持程度，以及 hook 配置能否按业务动态注入。
- **证据标注约定**：【实测】= 本机真实调用模型验证通过（实验脚本与留档见 `demo/`）；【文档】= 仅依据官方文档（[developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks)，对应 openai/codex 仓库 main 分支），未经实跑。

> 实验方法：全程使用 `mktemp -d` 临时目录作为 `CODEX_HOME`，复制 `~/.codex/auth.json` 与脱敏后的 `config.toml` 进入临时目录（不读取、不修改原文件），用户全局配置零污染。模型经用户本机代理 provider 真实调用。

---

## 一、结论先行

| 平台需求 | codex-cli 对应能力 | 支持与否 | 证据 |
|---|---|---|---|
| ① 前置检查（会话/任务开始前后可执行脚本、可阻断） | `SessionStart`、`UserPromptSubmit` hook | **支持**（阻断发生在模型调用前，可省 token） | 【实测】 |
| ② 中间处理（run 期间工具调用前/后拦截、阻断、修改） | `PreToolUse`（deny + `updatedInput` 改写）、`PermissionRequest`、`PostToolUse`（替换模型可见结果） | **支持**（阻断/改写均已验证；改写仅限入参，不能改出参） | 【实测】 |
| ③ 后置检查（任务/turn 完成时执行脚本、拿结果、阻断/改写结果） | `Stop` hook（输入含 `last_assistant_message`，可 `decision:block` 强制续跑）、`SessionEnd`（仅通知，不可干预） | **部分支持**：能拿到最终文本、能强制 agent 继续修改结果；**不能**直接改写最终结果文本 | 【实测】 |
| hook 动态配置（按次/按业务注入，不改全局配置） | `-c` 内联 TOML 覆盖、`-p/--profile` 业务 profile 文件、`CODEX_HOME` 环境隔离、项目级 `.codex/hooks.json` | **支持**，且有 4 条可行路径（详见第四节） | 【实测】 |
| 无头嵌入配套（exec / JSONL / output-last-message / resume / sandbox） | 与 hook 组合基本正常；**resume 场景 hook 覆盖不完整** | 支持但有坑（详见第五、六节） | 【实测】 |

**一句话结论**：codex-cli 0.154.0 的 hooks 子系统（feature `hooks`，stable，默认开启）已覆盖平台三类钩子需求，且 hook 可通过 `-c` / `-p` 按次注入，满足"同一进程跑不同业务、不同业务不同 hook"的平台场景；主要坑是**信任门控**（headless 下未信任 hook 静默跳过）与 **resume 场景 hook 不齐全**。

---

## 二、hooks 子系统总览

【文档 + 实测】codex-cli 0.154.0 内置生命周期 hooks 框架，与 Claude Code hooks 设计高度同构：

- **事件清单**：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop`、`SubagentStart`、`SubagentStop`、`Interrupt`。
- **handler 类型**：`command`（子进程脚本，stdin 收 JSON、stdout 返回 JSON 决策）与 `mcp_tool`（调用已连接 MCP server 的工具）；`prompt`/`agent` 类型仅解析不执行。
- **配置形式**：`hooks.json` 或 `config.toml` 内联 `[hooks]` 表，二者同层可合并。
- **匹配器**：`matcher` 为正则；`PreToolUse`/`PostToolUse`/`PermissionRequest` 按工具名匹配（`Bash`、`apply_patch`（亦可用 `Edit`/`Write` 别名）、`mcp__server__tool`、其他本地函数工具名）；`"*"` 或省略表示全匹配。
- **生效开关**：feature flag `hooks` 默认开启（`codex features list` 实测为 `stable / true`）；`[features] hooks = false` 可关。
- **旧版 `notify` 配置在本版本已不存在**（二进制与官方 config 文档均无 `notify` 项），hooks 是唯一的事件外发机制。

### 工具覆盖面（【文档】，部分实测）

`PreToolUse`/`PostToolUse` 覆盖：shell 命令（含 unified exec，匹配名 `Bash`）、`apply_patch` 文件编辑、MCP 工具、其他本地函数工具（如 `update_plan`）；**不覆盖** `WebSearch` 等 hosted tools。官方明确提示："把工具 hook 当作护栏，而非完整的强制边界"。本调研实测了 `Bash` 路径。

---

## 三、各挂接点详解（输入格式 / 阻断语义 / 实测证据）

所有 command hook 通过 **stdin 收一个 JSON 对象**，公共字段【实测逐字段核对与文档一致】：

`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`；turn 级事件另有 `turn_id`、`permission_mode`（exec 下实测值为 `bypassPermissions`）。

### 3.1 前置检查：`SessionStart` + `UserPromptSubmit`【实测】

- `SessionStart`：附加字段 `source`（`startup`/`resume`/`clear`/`compact`）。stdout 可返回 `hookSpecificOutput.additionalContext` 注入为 developer 上下文；`continue:false` 可终止。
- `UserPromptSubmit`：附加字段 `prompt`（完整用户输入）。**阻断方式**：stdout 返回 `{"decision":"block","reason":"..."}` 或 **exit 2 + stderr 写原因**。

实测（`demo/hooks/prompt_block.sh`，留档 `demo/out/exp3b-userprompt-block.jsonl`）：prompt 含关键词时 exit 2，**turn 直接结束、`turn.completed` 的 usage 全为 0**——阻断发生在任何模型调用之前，满足"前置检查拦截且零 token 成本"。

⚠️ 注意：被阻断时 `codex exec` **进程退出码仍为 0**，`--json` 事件流中也**没有**任何"被 hook 阻断"的显式事件——平台感知阻断必须靠 hook 自身落盘/上报，不能依赖退出码或事件流。

### 3.2 中间处理：`PreToolUse` / `PermissionRequest` / `PostToolUse`【实测】

`PreToolUse` 附加字段：`tool_name`、`tool_use_id`、`tool_input`（Bash 为 `{"command": "..."}`）。

- **阻断**：返回 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`（旧式 `{"decision":"block","reason":"..."}` 或 exit 2 亦可）。
  实测（`demo/out/exp2a-pretooluse-deny.jsonl`）：命令**未执行**，deny reason 作为工具结果反馈给模型，模型如实报告"被 PreToolUse 钩子拦截"。
- **改写**：返回 `permissionDecision:"allow"` + `updatedInput`（Bash 须含 `command` 字段）。
  实测：模型请求 `echo ORIGINAL-COMMAND`，实际执行的是 hook 改写后的 `echo rewritten-by-hook`。
- **注入上下文**：`hookSpecificOutput.additionalContext`（不阻断）。
- 不支持项（【文档】）：`permissionDecision:"ask"`、`continue:false` 等会标记 hook 失败并**放行**工具调用（fail-open）。

`PermissionRequest`：在即将发起人工审批时触发，可返回 `decision.behavior = allow/deny` 代替审批；无 hook 决策时走正常审批流。【文档】（exec 下 approval policy 为 never，该事件在平台无头场景作用有限。）

`PostToolUse` 附加字段：`tool_response`（实测 Bash 为命令 stdout 字符串）。

- **结果替换**：返回 `{"decision":"block","reason":"..."}`（或 exit 2）→ **副作用已发生、无法撤销**，但模型可见的工具结果被替换为 hook 反馈。
  实测（`demo/out/exp6-posttooluse-block.jsonl`）：命令真实执行并输出 `REAL-OUTPUT-123`，模型却回复"输出被审计钩子拦截，无法读取原始输出"。
- `updatedMCPToolOutput`（改写工具输出）已解析但**尚未支持**【文档】。

### 3.3 后置检查：`Stop` + `SessionEnd`【实测】

`Stop`（turn 收尾时触发）附加字段：`last_assistant_message`（最终回复文本）、`stop_hook_active`。

- 返回 `{"decision":"block","reason":"..."}`：不拒绝收尾，而是**把 reason 作为新的 user prompt 让 agent 继续跑一轮**（`stop_hook_active` 置 true 防止无限循环由 hook 自行判断）。
  实测（`demo/hooks/stop_block_once.sh`，留档 `demo/out/exp3a-stop-hook.jsonl`）：模型先回 `OK` → Stop 触发并 block → agent 被要求"再检查一遍" → 回复 `FINAL-OK` → Stop 二次触发（`stop_hook_active=true`）放行。这正好支撑平台"输出门禁不通过就打回重写"的需求。
- **局限**：`Stop` 能拿到最终结果文本、能迫使 agent 修改后重出，但**不能直接改写最终结果文本**；`--output-last-message` 落盘的是 agent 最终消息，不经过 hook 过滤。

`SessionEnd`：附加字段 `reason`（当前恒为 `other`）。纯通知性质，输出不影响任何行为；始终同步执行，默认超时 1s、上限 3s（实测配置 timeout=10 被 clamp 并告警）。可用于审计落账、资源清理。

### 3.4 其他事件（【文档】，未实测）

`PreCompact`/`PostCompact`（压缩前后，`continue:false` 可阻止/停止）、`SubagentStart`/`SubagentStop`（子代理生命周期）、`Interrupt`（TUI 打断，无头场景基本不涉及）。

### 3.5 执行语义要点

- 同一事件多个匹配 hook **并发执行**，任一 hook 不能阻止其他 hook 启动【文档】。
- 默认**同步阻塞**；`"async": true` 可后台运行，但后台 hook **不能阻断/审批/改写**，结果在下个安全点送达【文档】。
- 默认超时 600s（`SessionEnd`/`Interrupt` 1~3s）；hook 输出进模型上下文默认约 2500 token，超出部分 spill 到临时文件【文档】。

---

## 四、动态配置：平台按业务注入 hook 的可行路径

按业务隔离强度从低到高，四条路径均【实测】验证：

### 路径 A：`-c` 内联 TOML 覆盖（按次注入，推荐用于单业务少量 hook）

```bash
codex exec --skip-git-repo-check -s read-only \
  --dangerously-bypass-hook-trust \
  -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="/opt/platform/hooks/deny.sh",timeout=10}]}]' \
  "业务 prompt"
```

实测留档 `demo/out/exp4a-dash-c-inject.jsonl`：无 hooks.json、无 profile，仅 `-c` 注入即触发。值按 TOML 解析，注意 shell 引号转义。适合 hook 少、命令行可拼的场景。

### 路径 B：`-p/--profile` 业务 profile 文件（按业务注入，**最推荐**）

在 `$CODEX_HOME/` 下为每个业务准备一个 `<业务名>.config.toml`，运行时 `-p <业务名>` 层叠选择：

```bash
# $CODEX_HOME/biz-ticket-review.config.toml:
# [[hooks.PreToolUse]]
# matcher = "Bash"
# [[hooks.PreToolUse.hooks]]
# type = "command"
# command = "/opt/platform/hooks/ticket_policy.sh"
CODEX_HOME=/srv/codex-home codex exec -p biz-ticket-review \
  --dangerously-bypass-hook-trust ...
```

实测：`-p bizA`（deny hook）阻断命令、`-p bizB`（capture hook）放行命令，留档 `demo/out/exp4c-profile-bizA.jsonl` / `exp4c-profile-bizB.jsonl`。profile 还可同时携带 model、sandbox 等业务级配置，天然契合"业务 = 配置包"模型。

### 路径 C：`CODEX_HOME` 环境变量整体隔离（按租户/按任务组）

`CODEX_HOME` 决定 config.toml、hooks.json、auth.json、会话历史的根目录。平台可为每租户/每业务分配独立 `CODEX_HOME`，写入各自的 `hooks.json`，实现完全隔离（本调研全部实验即以此方式与全局环境隔离）。

### 路径 D：项目级 `<repo>/.codex/hooks.json`（按工作区注入）

实测有效，但**前提是该项目路径已在 `$CODEX_HOME/config.toml` 的 `[projects."<路径>"] trust_level = "trusted"` 中登记信任**，否则项目层配置（含 hooks）不加载。注意：用 `-c 'projects."<路径>".trust_level="trusted"'` 临时覆盖**不生效**（实测），必须落在 config.toml 文件里。适合"业务 workspace 自带策略"的场景，不适合高频率动态切换。

### 信任门控：动态注入的必要配套

【实测】非 managed hook 必须先经信任审查（按 hook 定义哈希记录信任），**`codex exec` 无头模式下没有交互式审查入口，未信任 hook 会被静默跳过**（实测：不加信任参数时 6 个 hook 一个都不触发，stdout 无任何提示）。平台注入 hook 必须二选一：

1. 每次调用加 **`--dangerously-bypass-hook-trust`**（本次调用放开信任，hook 由平台自行审核——平台场景语义正好匹配）；加此参数时 `--json` 事件流会多一条 `error` 类型 item 提示，需注意解析兼容。
2. 或先在 TUI 里 `/hooks` 审查信任一次（信任持久化在 CODEX_HOME 中），后续同一定义的 hook 免审查。hook 内容任何变更都需重新信任。

> 回答背景中的疑问："codex 命令本身支持 hook 参数吗？" —— **没有专门的 `--hook` 参数**，但 `-c` / `-p` 通用配置机制完全等价地实现了按次/按业务注入，效果等同。

---

## 五、无头嵌入配套能力（与 hook 组合实测）

| 能力 | 实测结论 |
|---|---|
| `codex exec` 非交互执行 | 正常；prompt 走 argv 或 stdin；`-a never` 免审批（exec 默认即 never） |
| `--json` JSONL 事件流 | 正常：`thread.started`（含 `thread_id`，可用于 resume）、`item.completed`（`agent_message`/`command_execution` 等）、`turn.completed`（含 token usage）。hook 触发本身**不产生独立事件**，hook 阻断只能在 agent 消息文本或 hook 自留日志中感知 |
| `-o/--output-last-message` | 正常，落盘最终回复文本（实测 resume 后正确取出 "4242"） |
| `codex exec resume --last / <id>` | 会话恢复可用、上下文连贯；**但 hook 覆盖不完整，见下** |
| `-s/--sandbox` | `read-only`/`workspace-write`/`danger-full-access` 三档；hook 在沙箱判定**之前**（PreToolUse）/之后（PostToolUse）生效，hook 进程本身**不在沙箱内**、以宿主机权限运行 |
| `--output-schema` | 可约束最终回复为指定 JSON Schema，与平台结构化取结果契合【文档】 |
| `--ephemeral` / `--ignore-user-config` / `--ignore-rules` | 可进一步收敛运行面；注意 `--ignore-user-config` **不忽略** `$CODEX_HOME/hooks.json`（实测 hook 仍触发），但会忽略 config.toml（含 model provider，慎用） |

**resume 的 hook 缺口【实测，可复现】**：`codex exec resume --last` 恢复会话时，仅 `UserPromptSubmit` 触发；**`SessionStart`（即使文档称 source 支持 `resume`）、`Stop`、`SessionEnd` 均不触发**。平台若依赖 Stop 做输出门禁，续跑会话会漏检。

---

## 六、限制与风险清单

1. **阻断不反映在进程退出码**：UserPromptSubmit/PreToolUse 阻断后 `codex exec` 退出码仍为 0；平台判定"被门禁拦截"必须读 hook 自身产出（落盘日志/上报），不能靠 exit code 或事件流。【实测】
2. **信任门控 + headless 静默跳过**：不加 `--dangerously-bypass-hook-trust` 时未信任 hook 无声失效，无任何报错——最容易造成"以为有防护实际没有"的事故。【实测】
3. **resume 场景 hook 不齐全**（SessionStart/Stop/SessionEnd 不触发）。【实测】
4. **最终结果不可被 hook 直接改写**：Stop 只能"打回让 agent 重写"，不能平台侧直接替换输出文本；`--output-last-message` 不做 hook 过滤。【实测】
5. **hook 覆盖面不是完整强制边界**：WebSearch 等 hosted tools 不过 hook；官方自述部分专用工具路径可绕过。【文档】
6. **hook fail-open 语义**：hook 返回不支持的字段/格式错误时，标记失败后**继续放行**工具调用（PreToolUse 场景）。平台 hook 脚本自身健壮性要求高。【文档】
7. **hook 进程以宿主机权限运行**（不在沙箱内），平台需自行保证 hook 脚本安全；hook 的 stdout 会进模型上下文（默认 ~2500 token 上限），不要在 hook 输出中放机密。【文档】
8. 项目级 hooks 需要项目路径预先登记 `trust_level = "trusted"`，且不能用 `-c` 临时授予。【实测】
9. hooks 事件 schema 文档注明以 releases 页面为准，跨版本升级需回归验证 hook 输入字段。

## 七、对平台选型的建议

1. **可以采用 codex-cli 作为 agent 内核**，其 hooks 能力对平台三层需求的映射：
   - 业务生命周期层（前置输入检查 / 后置输出门禁）：**建议平台自建、不依赖 codex**——在调用 `codex exec` 前后由平台进程自行执行检查脚本，配合 `--output-last-message` / `--json` 取结果。这比依赖 `UserPromptSubmit`/`Stop` 更可控（不受 resume 缺口、hook fail-open 影响）。
   - run 内层（工具调用拦截/审计）：**用 codex 原生 `PreToolUse`/`PostToolUse`**，通过 **`-p <业务>` profile（首选）或 `-c` 内联**注入业务策略 hook，每次调用固定携带 `--dangerously-bypass-hook-trust`，hook 脚本由平台统一下发与审计。
2. 阻断/拦截的结果判定走 **hook 自留审计日志**（推荐 hook 脚本向平台回报），辅以 `--json` 事件流解析；不要依赖进程退出码。
3. 若业务强依赖"续跑会话 + 输出门禁"，需注意 resume 下 Stop 不触发的缺口，建议续跑场景改由平台层后置检查兜底。
4. 沙箱选 `-s read-only` 或 `workspace-write`；hook 不受沙箱约束，恰好适合承载平台级审计逻辑。

---

## 附：实验留档索引

| 留档文件（`demo/out/`） | 验证点 |
|---|---|
| `exp1-all-events.jsonl` | exec 下 6 类事件顺序触发、完整输入字段 |
| `exp2a-pretooluse-deny.jsonl` | PreToolUse deny 阻断（`--json` 全程） |
| `exp3a-stop-hook.jsonl` | Stop 拿 `last_assistant_message`、block 续跑、`stop_hook_active` |
| `exp3b-userprompt-block.jsonl` | UserPromptSubmit exit 2 阻断、0 token、退出码 0 |
| `exp4a-dash-c-inject.jsonl` | `-c` 内联注入 |
| `exp4b-project-hooks.jsonl` | 项目级 `.codex/hooks.json`（trust 登记后） |
| `exp4c-profile-bizA.jsonl` / `exp4c-profile-bizB.jsonl` | `-p` profile 按业务注入 deny / capture |
| `exp5-resume.jsonl` | resume 仅触发 UserPromptSubmit |
| `exp6-posttooluse-block.jsonl` | PostToolUse block 替换模型可见结果 |

复现方式见 `demo/README.md`（`bash demo/run-all.sh`）。
