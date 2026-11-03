# tools/ —— 可选：共享工具资产（占位说明）

**本目录是可选的。** 工具（tool）是独立资产：可被多个业务包复用的子程序
（如 jira-fetch、web-search），业务代码通过 `sdk.run("<名字>", {...})` 按名调用——
跨资产调用永远不写物理路径，运行时由平台在 stdin 信封里注入程序路径映射。

## 什么时候需要它

- 某个取数/动作能力会被**多个包**复用 → 抽成工具资产；
- 单仓多资产开发时：本目录下每个工具一个子目录（如 `tools/jira-fetch/`），
  各自登记为独立**工具资产**（登记时 subpath = `tools/<名字>`）；
- 只被一个包用的程序不要放这里——直接作为包内程序登记在 `apps/` + `programs` 里，
  进程内 import 调用（零进程开销）。

## 规则

每个工具子目录是一个完整的小工程，至少包含：

- `agent-package.json`：`programs` 声明入口（工具名 = 资产登记名，程序名自取）；
- `agent.materialize.mjs`：初始化脚本（可直接拷贝包根的版本）；
- `package.json` + 业务源码（结构同包：`apps/` + 可选 `packages/`）。

工具与包同契约：stdin 一段 JSON 进、stdout 一段 JSON 出（`sdk.return` / `sdk.fail`）。
