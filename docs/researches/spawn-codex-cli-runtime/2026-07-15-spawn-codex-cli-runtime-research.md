# spawn + Codex CLI 最小调研

日期：2026-07-15

## 调研目标

验证 Node.js 宿主程序能否通过 `spawn` 启动当前环境中的 `codex` CLI，并通过子进程监听器拿到大模型回复。

本次调研只验证最小链路：

```text
Node.js spawn
-> codex exec
-> Codex CLI 调用模型
-> stdout JSONL 事件流
-> 宿主进程监听 agent_message
-> output-last-message 读取最终回复
```

本次不评估现有项目代码实现，也不依赖现有 Runtime Adapter。

## 最小示例

示例文件：

```text
docs/researches/spawn-codex-cli-runtime/spawn-codex-exec-minimal.mjs
```

运行：

```bash
node docs/researches/spawn-codex-cli-runtime/spawn-codex-exec-minimal.mjs
```

也可以传入自定义 prompt：

```bash
node docs/researches/spawn-codex-cli-runtime/spawn-codex-exec-minimal.mjs "你在忙吗？请一句话回答"
```

示例脚本的关键点：

- 使用 `spawn("codex", args, { env: process.env })`，继承当前进程环境变量。
- 不显式设置 `CODEX_HOME`，避免改变当前可用 Codex CLI 环境。
- 使用 `codex exec` 非交互模式。
- 使用 `--json` 从 stdout 获取 JSONL 事件流。
- 使用 `stdout.on("data")` 监听事件。
- 从 `event.item.type === "agent_message"` 获取模型回复。
- 使用 `--output-last-message <file>` 读取最终回复，作为监听结果的兜底校验。

## 已验证命令形态

本次跑通的命令形态：

```bash
codex --ask-for-approval never exec \
  --ephemeral \
  --sandbox read-only \
  --skip-git-repo-check \
  -C <临时目录> \
  --json \
  --output-last-message <临时目录>/last-message.txt \
  "请只回复一句中文：spawn codex ok"
```

说明：

- `--ask-for-approval never` 是 `codex` 顶层参数，放在 `exec` 前面。
- `--ephemeral` 避免产生持久 session 文件，适合最小验证。
- `--sandbox read-only` 适合纯问答验证。
- `--skip-git-repo-check` 允许在临时目录中运行。
- `-C <临时目录>` 让示例不依赖当前仓库状态。

## 实测结果

在当前 Codex CLI 真实运行环境中，最小示例已跑通。

关键输出：

```text
[event] thread.started
[event] turn.started
[event] item.completed
[agent_message] spawn codex ok
[event] turn.completed
[close] 0
[last-message] spawn codex ok
```

结论：

- `spawn + codex exec` 可以完成大模型调用。
- 子进程 `stdout` 监听器可以拿到 JSONL 事件。
- 模型最终回复可以从 `agent_message` 中取得。
- `--output-last-message` 文件中的最终回复与监听到的 `agent_message` 一致。

## 当前环境中的注意事项

在受限命令沙箱内直接运行同一验证时，`codex` 启动失败：

```text
Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
```

在沙箱外、继承当前 Codex CLI 环境后，同一验证成功。

这说明该最小链路依赖真实 Codex CLI 运行权限。后续如果在服务、容器或测试环境中复现失败，应优先检查：

- 子进程是否继承了正确的 `PATH` 和 Codex 相关环境。
- `codex` 是否能在该环境中正常启动。
- 运行环境是否限制了 Codex 初始化所需的本地进程、socket 或文件访问。
- `CODEX_HOME` 是否被显式覆盖到不可用目录。

## 后续对照现有代码时的检查点

跑通最小链路后，再看项目实现时，应重点对照这些点：

- 是否使用 `codex exec`，而不是交互式 `codex` TUI。
- `--ask-for-approval never` 是否放在 `exec` 前面。
- 是否监听 `stdout.on("data")`，并按 JSONL 行解析。
- 是否正确处理 chunk 边界，不能假设一次 `data` 就是一行完整 JSON。
- 是否处理 `stderr`，但不把普通 warning 直接当作失败。
- 是否以 `close` 事件和 exit code 判断子进程完成状态。
- 是否使用 `--output-last-message` 保存最终回复，避免只依赖事件解析。
- 是否在不需要连续会话时使用 `--ephemeral`。
- 是否避免在最小问答场景中覆盖当前可用的 `CODEX_HOME`。

## 与当前 Runtime Adapter 的初步对照

最小示例跑通后，再看当前 `src/runtime/codex-cli-adapter.ts`，可以先记录这些差异点。这里不直接判断全部都是 bug，因为业务运行模式可能有额外约束；但它们都是后续排查真实失败时应优先确认的点。

当前 adapter 已具备：

- 使用 `spawn("codex", ...)` 启动子进程。
- 使用 `codex exec` 非交互模式。
- 使用 `--json`。
- 使用 `--output-last-message`。
- 监听 `stdout.on("data")` 和 `stderr.on("data")`。
- 在 `close` 后按 exit code 判断成功失败。
- 读取 last message 文件作为最终输出。
- 新建 session 时解析 `thread.started.thread_id`。

与最小跑通示例不同的点：

- 当前 adapter 参数从 `"exec"` 开始，没有传顶层 `--ask-for-approval never`。如果运行环境触发 approval，非交互服务可能卡住或失败。
- 当前新会话没有传 `--ephemeral`，会产生可恢复 session。若业务不需要连续会话，会增加 session 状态和清理成本。
- 当前新会话没有传 `--skip-git-repo-check`。如果 `input.workdir` 不是 Git 仓库，可能失败；如果业务要求必须在真实仓库执行，则不应加这个参数。
- 当前 adapter 可能设置 `CODEX_HOME`。如果配置值指向不可用目录，会覆盖当前可用 Codex CLI 环境。
- 当前 adapter 把 stdout 全量累计到进程结束后再 `split("\n")` 解析。基础可用，但它不是“监听器实时返回模型回复”；如果上层要流式返回，需要在 `stdout.on("data")` 中按 JSONL 行解析并转发。
- 当前 adapter 对 stdout JSON 解析没有跳过异常行。只要 stdout 混入非 JSON 文本，成功退出后仍会失败。最小示例也假设 `--json` stdout 纯 JSONL，但调试版可以在这里加诊断。
- 当前 adapter 在每次 run 结束时删除 runtimeDir。读取 last message 的顺序是正确的，但失败排查时无法保留临时文件。

## 结论

`spawn + codex-cli` 作为最小大模型调用链路是可行的。最小可靠形态是：

```text
spawn codex exec --json
+ stdout JSONL listener
+ agent_message 提取
+ output-last-message 兜底
+ close/exit code 判断完成
```

后续项目实现如果失败，应先用本目录的最小示例确认环境是否可用，再排查项目 Runtime Adapter 的参数、环境变量、stdout 解析和完成态处理。
