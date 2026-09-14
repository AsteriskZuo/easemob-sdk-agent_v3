# Codex CLI Runtime 调研

日期：2026-07-11

## 背景

`docs/drafts/2026-07-10-multi-scenario-task-runner-design.md` 把 Codex CLI 放在整体架构的 `Runtime Adapter` 位置：

```text
Task Runner
-> Context Builder
-> Runtime Adapter
-> Codex CLI
-> Skill / Tool Resolver
-> Result Handler
```

本次调研只回答三个会影响后续架构设计的技术问题：

1. Docker 服务如何通过命令行调用 Codex 与大模型交互。
2. Codex CLI 如何加载 skill。
3. Codex CLI 如何加载 MCP。

不在本次调研中设计完整 Task Runner，也不决定业务场景的最终配置格式。

## 调研结论

Codex CLI 支持作为服务化 Runtime 的第一版执行引擎，推荐通过 `codex exec` 非交互模式调用。

后续 `Runtime Adapter` 不应该只拼接一个 prompt 后执行 `codex` 交互式 TUI，而应该明确管理：

- `codex exec` 命令参数。
- 工作目录 `-C`。
- sandbox 和 approval 策略。
- `CODEX_HOME` / `config.toml` / profile。
- 可用 skills。
- 可用 MCP servers。
- JSONL 事件流或最终消息文件。
- 超时、退出码、日志和任务状态映射。

最小推荐调用形态：

```bash
codex --ask-for-approval never exec \
  --ephemeral \
  --sandbox read-only \
  -C /path/to/repo \
  --json \
  --output-last-message /tmp/codex-last-message.txt \
  "你的任务 prompt"
```

如果任务需要修改代码，把 `--sandbox read-only` 调整为 `--sandbox workspace-write`，并把执行环境放进受控工作区或容器。

## 版本和当前环境

本机验证版本：

```text
codex-cli 0.142.5
```

当前项目没有项目级 `.codex/config.toml`。

当前全局 `~/.codex/config.toml` 中可见的关键事实：

- 默认模型配置来自本机用户配置，不是项目配置。
- 当前 provider 是本机代理地址。
- 已启用 `superpowers@superpowers-dev` 插件。
- 当前没有已配置的 MCP server。

这意味着：Docker 服务中运行 Codex 时，不能假设目标容器天然拥有开发机上的 Codex 状态。`CODEX_HOME`、认证、config、插件、skills、MCP 配置都需要作为部署输入显式准备。

## 资料来源

本次使用了三类证据：

1. 本机 Codex CLI 帮助输出：
   - `codex --help`
   - `codex exec --help`
   - `codex mcp --help`
   - `codex mcp add --help`
   - `codex plugin --help`
   - `codex plugin marketplace --help`
2. 官方 Codex manual 本地缓存：
   - `/var/folders/_x/3sg_ghyj03q5_xhxffbhy2k00000gp/T/openai-docs-cache/codex-manual.md`
   - 相关章节：Non-interactive mode、Agent Skills、Model Context Protocol、Plugins、Config basics、Environment variables。
3. 本机 smoke test：
   - `codex exec` 普通输出验证。
   - `codex exec --json` JSONL 输出验证。
   - `--output-last-message` 最终消息文件验证。
   - `codex mcp list` 和 `codex plugin list --json` 当前可见配置验证。
   - 项目级 `.codex/config.toml` MCP 加载和工具调用验证。

注意：联网直接访问 `https://developers.openai.com/codex/codex-manual.md` 曾出现 DNS 失败和超时，但后续 helper 产生了完整 manual 缓存。本调研以本机 CLI 实测和该缓存文档为主要依据。

## `codex exec` 如何完成大模型交互

`codex exec` 是 Codex CLI 的非交互模式，适合脚本、CI、定时任务、服务进程调用。它会启动一个 Codex agent turn，读取 prompt、项目上下文、配置、可用 tools/skills/MCP，然后把最终回答输出给调用方。

关键行为：

- prompt 可以作为命令行参数传入。
- 如果不提供 prompt，或 prompt 为 `-`，可以从 stdin 读取。
- 如果同时提供 prompt 和管道 stdin，prompt 是任务指令，stdin 会作为额外上下文。
- 默认在只读 sandbox 中运行。
- 可以通过 `--sandbox workspace-write` 允许写工作区。
- 可以通过 `--ephemeral` 避免持久化 session 文件。
- 可以通过 `--json` 输出 JSONL 事件流。
- 可以通过 `--output-last-message <file>` 把最终 agent message 写入文件。
- 可以通过 `--output-schema <file>` 要求最终消息符合 JSON Schema。
- `codex exec resume` 可以恢复上一次或指定 session，但第一版 Task Runner 不建议依赖跨任务 session，除非明确需要连续会话。

### 参数位置的坑

`--ask-for-approval` 是顶层 `codex` 参数，不是 `codex exec` 子命令参数。

错误：

```bash
codex exec --ask-for-approval never "prompt"
```

正确：

```bash
codex --ask-for-approval never exec "prompt"
```

本机实测中，错误形式会报：

```text
error: unexpected argument '--ask-for-approval' found
```

### JSONL 输出形态

`codex exec --json` 会把 stdout 变成 JSON Lines 事件流。实测出现过这些事件：

```jsonl
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.started","item":{"type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"type":"command_execution","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"type":"agent_message","text":"codex-json-ok"}}
{"type":"turn.completed","usage":{"input_tokens":26961,"cached_input_tokens":14592,"output_tokens":159,"reasoning_output_tokens":71}}
```

Runtime Adapter 的第一版可以采用简单策略：

- 以进程退出码判断任务是否失败。
- 解析 JSONL，记录 `thread_id`、`turn.completed.usage`、`item.completed`。
- 从 `item.type === "agent_message"` 取最后一条作为最终文本。
- 同时使用 `--output-last-message` 保存最终结果，作为兜底。

如果业务需要稳定字段，不要让 Result Handler 解析自然语言，应该加 `--output-schema`。

## Codex CLI session / thread 生命周期

结论先行：

- `codex exec "prompt"` 默认会启动一个新的 Codex thread/session。
- `codex exec --json` 的事件流里会输出 `thread.started.thread_id`，这是后续恢复该 session 的关键 ID。
- `codex exec resume <SESSION_ID> "prompt"` 可以非交互式恢复指定 session。
- `codex exec resume --last "prompt"` 可以恢复最近 session，但服务化 Task Runner 不建议依赖 `--last`，因为并发任务下“最近”不是稳定业务语义。
- 交互式 CLI 也支持 `codex resume <SESSION_ID>`、`codex resume --last`、`codex resume --all`。
- session ID 由 Codex 创建，当前没有查到 CLI 参数可以让调用方自定义 session ID。
- 调用方应该把 Codex 生成的 `thread_id` / `SESSION_ID` 存到自己的 Task Store，而不是试图用业务 task id 替代 Codex session id。

官方 manual 对 resume 的描述：

- Codex 会把 transcript 存在本地，方便恢复上下文。
- `codex resume <SESSION_ID>` 可以定位指定 run。
- session ID 可以从 picker、`/status` 或 `~/.codex/sessions/` 下的文件获得。
- 非交互自动化也可以用 `codex exec resume --last` 或 `codex exec resume <SESSION_ID>` 恢复。
- 恢复后的 run 会保留原 transcript、plan history 和 approvals。

本机 CLI help 进一步确认：

```text
codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
SESSION_ID: Conversation/session id (UUID) or thread name.
```

以及：

```text
codex resume [OPTIONS] [SESSION_ID] [PROMPT]
SESSION_ID: Session id (UUID) or session name.
```

### 对 Task Runner 的建议

第一版建议把一次业务任务视为一次独立 Codex session：

1. 新任务用 `codex exec --json ...` 启动。
2. 从第一条 `thread.started` 事件中读取 `thread_id`。
3. 把 `thread_id` 存入 Task Store，例如：

```text
task_id: 内部任务 ID
source: jira / wecom / manual / cron
source_event_id: Jira issue event id / WeCom msgid / manual id
codex_thread_id: Codex 生成的 thread_id
codex_resume_policy: none / explicit
```

4. 如果同一个业务任务需要二阶段执行，使用 `codex exec resume <codex_thread_id> "下一阶段 prompt"`。
5. 不使用 `codex exec resume --last` 作为服务逻辑，只允许人工排查时使用。
6. 默认自动化任务优先使用 `--ephemeral`，除非明确需要 resume。

原因：

- `--last` 在并发、重试、多项目共用 `CODEX_HOME` 时不可控。
- Codex session ID 是运行时事实，不是业务主键。
- Task Store 才是业务幂等、重试、审计、状态流转的来源。
- 对 Jira 工单评审这类任务，通常每次事件都有完整上下文，长期复用 Codex thread 反而可能引入过期上下文。

推荐策略：

- `jira_ticket_review`：默认 `--ephemeral`，每次 Jira webhook / polling 事件重新构建上下文；只有人工要求“继续上次分析”时才显式 resume。
- `bug_fix`：可以保存 `codex_thread_id`，用于“先分析、再修改、再 review”的连续任务；但必须按内部 `task_id` 显式绑定，不用 `--last`。

### session 删除和归档

Codex CLI 0.142.5 支持删除和归档单个 saved session：

```bash
codex archive <SESSION_ID>
codex unarchive <SESSION_ID>
codex delete <SESSION_ID>
codex delete <SESSION_UUID> --force
```

官方 manual 和本机 help 对删除的边界一致：

- `codex archive` / `codex unarchive`：按 session ID 或 session name 归档 / 恢复；归档用于从 active session 列表隐藏，不删除 transcript。
- `codex delete`：按 session ID 或 session name 永久删除 transcript。
- `codex delete --force`：只支持 UUID；name 仍需要交互确认，避免重名误删。

当前没有查到内建命令支持：

- 删除最早的 N 个 session。
- 删除早于某个时间的 session。
- 按 cwd / 项目 / profile / tag 条件批量删除。
- 按 Task Store 状态批量删除。

本机实际 session 文件位于：

```text
~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<uuid>.jsonl
```

但不建议第一版直接依赖这个文件结构做业务逻辑。它适合作为排查和兜底清理依据，不适合作为稳定 API。

对服务化运行的建议：

- 常规自动任务默认加 `--ephemeral`，减少 session 文件堆积。
- 需要 resume 的任务才持久化 session，并把 `codex_thread_id` 写入 Task Store。
- 清理策略放在我们的服务侧，不依赖 Codex 内建“条件删除”能力。
- 第一版只实现保守清理：根据 Task Store 中已完成任务的 `codex_thread_id`，逐个执行 `codex delete <uuid> --force`。
- 如果需要按时间兜底清理，只扫描服务专用 `CODEX_HOME/sessions`，并先 dry-run 输出候选 session；不要扫描开发机个人 `~/.codex/sessions`。

## Codex CLI 如何加载 skill

官方 manual 中的关键事实：

- skill 是一个目录，包含 `SKILL.md`，可附带 scripts 和 references。
- `SKILL.md` 必须包含 `name` 和 `description`。
- Codex 启动时会把可用 skill 的名称、描述和路径放入初始上下文，用于选择是否启用。
- 当 Codex 决定使用某个 skill 时，才读取完整 `SKILL.md`，这叫 progressive disclosure。
- skill 可以显式调用，也可以根据描述隐式触发。
- CLI/IDE 中可以用 `$skill-name` 形式显式提及 skill。
- skill 可直接放在仓库、用户、admin、system 位置。
- 多个同名 skill 不会合并，可能同时出现在选择器中。
- 可以用 `[[skills.config]]` 在 `config.toml` 中禁用指定 skill。
- 当前没有查到 `codex exec --skills-dir <path>` 这类显式追加 skill 搜索目录的 CLI 参数。
- 当前没有查到 `config.toml` 中用于追加任意 skill 搜索目录的配置项。

skill 搜索位置：

```text
$CWD/.agents/skills
$CWD/../.agents/skills
$REPO_ROOT/.agents/skills
$HOME/.agents/skills
$CODEX_HOME/skills
/etc/codex/skills
Codex system bundled skills
已安装插件内的 skills
```

本机补充实测，2026-07-13，codex-cli 0.142.5：

- `codex exec -C <repo>` 可以加载 `<repo>/.agents/skills/<skill>/SKILL.md`。
- 显式设置 `CODEX_HOME=/Users/asterisk/.codex` 后，仍可以加载 `<repo>/.agents/skills/<skill>/SKILL.md`。
- 放在 `$CODEX_HOME/skills/<skill>/SKILL.md` 的 skill 也可以被加载。
- 验证方式：prompt 只显式提及 skill 名，不包含验证码；Codex CLI 读取对应 `SKILL.md` 后返回其中的验证码。

项目相关结论：

- 如果 `jira-ticket-review` 和 `bug-fix` 是跨项目业务能力，第一版推荐放在 Docker 容器用户级 skill 目录：`$HOME/.agents/skills`。
- Docker 服务应显式固定 `HOME`，例如 `HOME=/home/codex`，并把跨项目 skill 放在 `/home/codex/.agents/skills`。
- `CODEX_HOME` 和 `$HOME/.agents/skills` 不是同一个概念。`CODEX_HOME` 管 Codex 状态、config、auth、session、plugins 等；其中 `$CODEX_HOME/skills` 也是可加载 skill 来源。
- 如果某个 skill 只服务单个代码仓库，可以放在该 repo 的 `.agents/skills`。
- 如果要跨团队分发、同时打包 MCP 配置或展示元数据，再包装成 Codex plugin。
- 如果 skill 实际存放在其他目录，可以用 symlink 暴露到 `$HOME/.agents/skills` 或 repo `.agents/skills`；Codex 文档说明支持 symlinked skill folders。
- Runtime Adapter 不需要“手动加载 SKILL.md 内容再拼进 prompt”，更合理的是让 Codex 自己发现 skill，然后在 prompt 里显式写 `$skill-name` 或使用清晰任务描述触发。
- 为了可控，业务场景 prompt 推荐显式提及目标 skill，例如：`Use $jira-ticket-review ...`。不要完全依赖隐式触发。

本机实测中，即使 prompt 只是“只输出这一行”，已启用的 `superpowers:using-superpowers` skill 仍会进入可用 skill 列表，并被模型读取。这说明服务化运行时必须控制 skill 可见性，否则业务任务可能被无关 skill 影响。

推荐 Docker skill 布局：

```text
/home/codex/.agents/skills/
├── jira-ticket-review/
│   └── SKILL.md
└── bug-fix/
    └── SKILL.md
```

## Codex CLI 如何加载 MCP

Codex CLI 支持 MCP，并通过 `config.toml` 管理 MCP servers。CLI 和 IDE 共享同一套配置。

可用配置方式：

1. 使用命令行：

```bash
codex mcp add context7 -- npx -y @upstash/context7-mcp
codex mcp add docs --url https://example.com/mcp
codex mcp list
codex mcp get <name> --json
codex mcp remove <name>
codex mcp login <name>
```

2. 编辑 `config.toml`：

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
```

支持的 MCP transport：

- STDIO server：本地进程，由 `command` 和 `args` 启动。
- Streamable HTTP server：远程 HTTP 地址，由 `url` 配置。

常用配置项：

- `env`：给 STDIO server 设置固定环境变量。
- `env_vars`：从 Codex 环境转发变量给 STDIO server。
- `cwd`：MCP server 启动目录。
- `startup_timeout_sec`：启动超时。
- `tool_timeout_sec`：工具调用超时。
- `enabled`：启停 server。
- `required`：如果初始化失败，Codex 直接失败。
- `enabled_tools` / `disabled_tools`：工具白名单/黑名单。
- `default_tools_approval_mode`：工具默认审批行为。
- `tools.<tool>.approval_mode`：单工具审批策略。

项目相关结论：

- Jira MCP、GitHub MCP、测试工具 MCP 不应该依赖开发机全局配置。
- MCP 支持项目级 `.codex/config.toml`，但只有 trusted project 会加载项目级 `.codex/` 配置。
- MCP 没有“搜索目录”概念，也没有查到类似 `--mcp-dir <path>` 的 CLI 参数。MCP server 通过 `config.toml` 的 `[mcp_servers.<name>]` 显式声明 command/url。
- 第一版 Docker 服务应为每类 task 准备明确的 Codex profile 或独立 `CODEX_HOME`。
- 对关键 MCP server 设置 `required = true`，避免 Codex 在缺少工具时继续输出看似成功的自然语言结果。
- 对高风险工具设置 allow list 和 approval policy，尤其是 GitHub 写操作、Jira 写评论、PR 创建等。
- 如果只是 Jira 读写，当前项目已有 Jira client，第一版也可以先不用 Jira MCP，把 Jira 内容作为 context 输入 Codex，把写回动作留给 Result Handler。是否引入 Jira MCP 是后续设计决策，不是本调研直接决定。

### 项目级 MCP 验证补充

2026-07-13 已验证项目级 `.codex/config.toml` 可以被 Codex CLI 加载，并且 MCP 工具可以被实际调用。

验证方式：

- 使用官方示例包 `@modelcontextprotocol/server-everything`，以 stdio transport 配置到 `<repo>/.codex/config.toml`。
- `codex mcp list` / `codex mcp get everything --json` 可以看到项目级 MCP server。
- `codex --ask-for-approval never exec -C . --sandbox read-only ...` 实际调用了 `everything/echo` 工具，最终返回 `mcp-project-ok`。

结论：项目级 `.codex/config.toml` 适合开发阶段验证项目自带、无敏感信息的 MCP 配置。临时验证配置已删除。

项目级 MCP 示例：

```toml
# <repo>/.codex/config.toml

[mcp_servers.jira]
command = "node"
args = ["/opt/mcp/jira-mcp-server/index.js"]
env_vars = ["JIRA_BASE_URL", "JIRA_USERNAME", "JIRA_PASSWORD"]
required = true
startup_timeout_sec = 20
tool_timeout_sec = 60
```

服务级 profile 示例：

```toml
# /home/codex/.codex/jira-review.config.toml

[mcp_servers.jira]
url = "http://jira-mcp:3000/mcp"
required = true
tool_timeout_sec = 60
enabled_tools = ["get_issue", "search_issues"]
```

推荐优先级：

1. 第一版把 Jira/GitHub 等运行环境相关 MCP 放在服务级 `CODEX_HOME` profile。
2. 项目级 `.codex/config.toml` 只放项目自带、无敏感信息、可随 repo 分发的 MCP 配置。
3. 密钥、内部地址、tool allowlist、required、timeout、approval policy 优先放服务级 profile 或部署配置。

### 2026-07-22 补充：配置分层、相对路径解析与 `-c` 覆盖

来源：官方文档（[config-advanced](https://developers.openai.com/codex/config-advanced)）+ codex-cli 0.142.5 本地实验。背景：Docker 修复中把 spawn cwd 统一为 workdir 后，本地 jira MCP 启动报 `No such file or directory (os error 2)`，由此查证以下事实。

**配置分层（后者覆盖前者同名 key）：**

1. 用户层：`$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。
2. profile 层：`$CODEX_HOME/<name>.config.toml`，用 `--profile <name>` 选择。
3. 项目层：从项目根（含 `.git`）向 cwd 逐级查找每个 `.codex/config.toml`，全部加载，离 cwd 越近优先级越高；**仅当项目 trusted 时加载**，信任状态记录在 `$CODEX_HOME` 的 config 里。
4. CLI `-c key=value` 一次性覆盖（支持点路径，如 `mcp_servers.jira.cwd`）。

不同名的 MCP server 跨层叠加，同名 key 近层覆盖远层。项目层 config 中的相对路径（官方明确举例 `model_instructions_file`）相对所在 `.codex/` 目录解析。

**关键坑：CODEX_HOME 指向 `<repo>/.codex` 时，该 config 以"用户层"身份加载，不适用项目层的相对路径规则。** 此时 MCP server 的相对 `cwd` 按 codex 进程 cwd（即 spawn cwd）解析——实测：spawn cwd 为项目根时 `cwd = ".agents/mcps/jira"` 正常；spawn cwd 改为 workdir（`.easemob-agent/codex-workdir`）后同样配置直接 ENOENT。

**实验记录（0.142.5）：**

- `codex mcp list -c 'mcp_servers.jira.cwd="/tmp/abs-test"'` 显示 Cwd 已被覆盖为 `/tmp/abs-test`，验证 `-c` 可在运行时覆盖 MCP cwd，无需改写 config 文件。
- 在 `/tmp` 建带 `.codex/config.toml` 的 git 项目并在 `$CODEX_HOME` config 中配置 `[projects."/tmp/..."] trust_level = "trusted"` 后，`codex mcp list` 仍未列出项目级 MCP（原因未查明：可能是 `mcp list` 不反映项目层，或信任条目格式有变）。本项目未走项目层机制，不影响结论，留作开放问题。

**对本项目的结论：**

- 服务通过 spawn cwd + `CODEX_HOME` 环境变量调用 codex，MCP 相对路径稳定性不能依赖 spawn cwd 不变；MCP `cwd` 应使用绝对路径，或在 spawn 时用 `-c mcp_servers.<name>.cwd="<绝对路径>"` 覆盖（推荐，零文件写入，路径可由服务进程按安装位置推导）。
- 将来新增 MCP server：在用户层 config.toml 声明，路径规则同上。

## Plugin 和 skill / MCP 的关系

官方 manual 的关系是：

- skill 是 reusable workflow 的作者格式。
- plugin 是 Codex 中可安装、可分发的打包单位。
- plugin 可以包含 skills、apps、MCP servers、展示元数据和生命周期配置。

最小 plugin 结构：

```text
my-plugin/
├── .codex-plugin/
│   └── plugin.json
└── skills/
    └── hello/
        └── SKILL.md
```

`plugin.json` 示例：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Reusable workflow",
  "skills": "./skills/"
}
```

安装和发现 plugin 的方式：

- `codex plugin marketplace add <source>`
- `codex plugin list --json`
- `codex plugin add <plugin@marketplace>`
- 也可以通过 repo 或个人 marketplace 暴露本地 plugin。

项目相关结论：

- 第一版不需要先做 plugin 市场。
- 业务 skill 可以先 repo-local 化。
- 等 `jira-ticket-review` / `bug-fix` 工作流稳定后，再考虑包装成 plugin。
- 如果一个 plugin 同时要带 skill 和 MCP server 配置，plugin 比散落的 `.agents/skills` + 手工 MCP 配置更适合分发。

## 配置和状态管理

Codex 配置优先级从高到低：

1. CLI flags 和 `--config` 覆盖。
2. 项目 `.codex/config.toml`，仅 trusted project 生效。
3. `--profile <name>` 对应的 `$CODEX_HOME/<name>.config.toml`。
4. 用户级 `$CODEX_HOME/config.toml`。
5. 系统级 `/etc/codex/config.toml`。
6. 内置默认值。

关键环境变量：

- `CODEX_HOME`：Codex 状态根目录，包含 config、auth、logs、sessions、skills、插件状态等。
- `CODEX_API_KEY`：只支持 `codex exec` 的单次非交互 API key。
- `CODEX_ACCESS_TOKEN`：用于可信自动化的 ChatGPT/Codex access token。
- `RUST_LOG`：诊断日志等级。

服务化建议：

- Docker 内不要直接复用开发者 `~/.codex`，除非只是本地验证。
- 为服务准备独立 `CODEX_HOME`，并把 config/profile/skills/plugin 安装过程写入部署流程。
- 为服务固定 `HOME`，并把跨项目 skill 放到 `$HOME/.agents/skills`。
- 每个业务场景可以对应一个 profile，例如：
  - `jira-review.config.toml`
  - `bug-fix.config.toml`
- Runtime Adapter 调用时使用 `--profile jira-review` 或显式 `--config` 覆盖。
- 对任务级动态内容使用 prompt/context，不要动态改全局 config。

推荐 Docker 布局：

```text
Docker container
├── HOME=/home/codex
│   └── .agents/skills/              # 跨项目 skill
│       ├── jira-ticket-review/
│       └── bug-fix/
└── CODEX_HOME=/home/codex/.codex
    ├── config.toml                  # 基础 Codex 配置
    ├── jira-review.config.toml      # Jira review 场景 MCP/profile
    └── bug-fix.config.toml          # Bug fix 场景 MCP/profile
```

推荐调用：

```bash
HOME=/home/codex \
CODEX_HOME=/home/codex/.codex \
codex --ask-for-approval never exec \
  --profile jira-review \
  --sandbox read-only \
  -C /workspace/repo \
  --json \
  "Use $jira-ticket-review ..."
```

## 与多业务场景执行框架的关系

建议 Runtime Adapter 的输入输出边界保持简单：

输入：

```text
task id
task type
workdir
prompt
context text/files
codex profile
sandbox mode
output schema
timeout
```

输出：

```text
exit code
thread id
final message
structured result
usage tokens
jsonl event log path
stderr log path
generated diff summary
```

第一版不要让 Codex 直接负责完整业务写回。更稳的边界是：

```text
Context Builder 把 Jira / repo / rules 组装给 Codex
Codex 输出审查结论或修复结果
Result Handler 根据结构化结果写回 Jira / 企业微信 / GitHub
```

这样可以避免模型直接调用外部写操作带来的权限和审计复杂度。

## 验证方法

### 1. 只检查当前 Codex 环境

```bash
node docs/research/codex-cli/codex-exec-smoke-test.mjs --skip-exec
```

会检查：

- `codex --version`
- `codex mcp list`
- `codex plugin list --json`

### 2. 验证 `codex exec`、JSONL 和最终消息文件

```bash
node docs/research/codex-cli/codex-exec-smoke-test.mjs \
  --cwd /Users/asterisk/Codes/ai/easemob-sdk-agent_v2
```

预期：

- `codex exec` 退出码为 `0`。
- JSONL 事件包含 `thread.started`、`turn.started`、`item.completed`、`turn.completed`。
- 最后一条 agent message 和 `--output-last-message` 文件包含：

```json
{"status":"ok","source":"codex-exec-smoke-test"}
```

### 3. 验证某个业务 profile

```bash
node docs/research/codex-cli/codex-exec-smoke-test.mjs \
  --cwd /path/to/repo \
  --profile jira-review
```

如果 profile 配置了必需 MCP 且 MCP 启动失败，`codex exec` 应失败。这是期望行为。

## 本机验证结果

已验证：

- `codex --version` 返回 `codex-cli 0.142.5`。
- `codex mcp list` 返回当前没有配置 MCP server。
- `codex plugin list --json` 返回已安装并启用 `superpowers@superpowers-dev`。
- `codex exec` 在宿主环境跑通，最终输出 `codex-exec-ok`。
- `codex exec --json` 跑通，stdout 为 JSONL 事件流，最终 agent message 为 `codex-json-ok`。
- `--output-last-message` 文件内容正确写入。

受限沙箱内直接运行 `codex exec` 曾失败：

```text
Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
```

提权到宿主环境后同样命令成功。这说明 Docker 或 CI 环境中需要单独验证 Codex CLI 的运行权限，不能只验证命令是否安装。

## 风险和未决问题

1. Codex CLI 版本会变化，`--json` 事件细节可能扩展。Adapter 应兼容未知 event type。
2. 当前本机使用用户级 provider 和插件配置；容器部署必须复制或重建这些配置。
3. skill 隐式触发可能带来不确定性。业务场景 prompt 应显式指定 skill。
4. MCP 写操作有权限和审计风险。第一版建议 Result Handler 负责 Jira/GitHub 写回。
5. `codex exec` 可能产生代码修改。Task Runner 必须隔离 workdir，并记录 diff。
6. 长任务需要超时和取消策略，本调研未验证进程取消后的状态清理。

## 建议进入架构设计前确认

建议确认三个决策后再写 Codex Runtime Adapter 设计：

1. 第一版业务 skill 放在 Docker `$HOME/.agents/skills`，还是立即封装成 plugin。
2. Jira/GitHub 写操作由 Codex MCP 直接执行，还是由 Result Handler 根据结构化结果执行。
3. Docker 服务使用单一 `CODEX_HOME` + 多 profile，还是每个业务场景独立 `CODEX_HOME`。
4. 项目级 `.codex/config.toml` 是否只允许无敏感、项目自带 MCP 配置。

我的建议：

- 第一版跨项目业务 skill 使用 Docker `$HOME/.agents/skills`；项目专属 skill 才放 repo `.agents/skills`。
- 第一版由 Result Handler 负责 Jira/GitHub 写回。
- 第一版使用独立服务 `CODEX_HOME` + 多 profile；如果后续场景隔离要求变强，再拆成多 `CODEX_HOME`。
- 第一版 MCP 主要放服务级 `CODEX_HOME` profile；项目级 MCP 只作为无敏感、项目自带工具的补充。
