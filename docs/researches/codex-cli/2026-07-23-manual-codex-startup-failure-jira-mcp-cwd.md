# 手动启动 codex 失败：jira MCP 相对路径 cwd 解析问题

## 现象

在项目根目录直接执行 `codex`，启动失败：

```text
Error: Failed to start a fresh session through the app server: thread/start failed during TUI bootstrap: thread/start failed: error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: jira: No such file or directory (os error 2) (code -32603)
```

## 根因

项目级配置 `.codex/config.toml` 中的 jira MCP server：

```toml
[mcp_servers.jira]
command = "node"
cwd = "../../.agents/mcps/jira"
args = ["--import", "tsx", "src/server.ts"]
required = true
```

- `cwd` 是**相对 codex 进程工作目录**解析的，不是相对配置文件位置。
- 这套配置是给 easemob-sdk-agent 运行时设计的：运行时通过 `getCodexProjectDir()`（`src/config.ts:68-72`）把 codex 的 cwd 设为 `.easemob-agent/codex-workdir`，此时 `../../.agents/mcps/jira` 正好解析到仓库内的 `.agents/mcps/jira`。Docker 镜像内布局一致，两种模式共用同一份配置。
- 手动在项目根目录启动 codex 时，进程 cwd 是仓库根，`../../.agents/mcps/jira` 指到仓库外面，目录不存在 → spawn 失败（os error 2，ENOENT）。
- 因为 `required = true`，MCP 初始化失败会导致整个 session 初始化失败，codex 无法启动。

## 解决方式

手动调试时，用命令行覆盖 `cwd`（相对项目根目录解析）：

```bash
CODEX_HOME=.codex codex -c 'mcp_servers.jira.cwd = ".agents/mcps/jira"'
```

或者模拟运行时行为，从 workdir 启动（但工作目录是空的 workdir，不适合交互开发）：

```bash
cd .easemob-agent/codex-workdir && codex
```

## 结论与约束

- 不建议把 `.codex/config.toml` 里的 `cwd` 改成绝对路径或改成相对项目根的路径——那会破坏运行时 / Docker 两种模式共用同一份相对路径的设计。
- 手动启动 codex 属于调试场景，统一用 `-c` 覆盖即可。
