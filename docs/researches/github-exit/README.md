# GitHub 出口工具调研

本目录用于沉淀「出口工具」GitHub 目的地（下载代码 clone / 提交 PR / 提交评论 / 提交 issue，经 GitHub 官方 CLI `gh`）的技术调研与验证，为后续 spec 与工具类实现提供依据。

**方向裁决（owner 已定，2026-10-03）**：操作通道为 `gh` CLI 子进程，不直接调 REST API；实现为工具类模式（构造注入、零 process.env、零全局单例，认证态由 gh/宿主机托管）。REST API 事实保留为 `gh api` 底册与备选方案。

当前文件：

- `2026-10-03-github-rest-exit-research.md`：gh 认证模型（keyring 登录态 / GH_TOKEN 注入）、非交互运行注意、gh↔REST 能力对应表、工具类实现建议（GhCli 结构、payload op 判别、bind 校验、幂等建议）、REST API 底册、风险与缺口。
- `gh-exit-verify.mjs`：可反复执行的验证脚本（仅 node 内置依赖），覆盖 gh 可用性、登录态、仓库权限、浅克隆（下载代码），`--write` 追加 issue 与 PR 写链路。

优先阅读：

1. `2026-10-03-github-rest-exit-research.md`
2. `gh-exit-verify.mjs`

## 已验证结论（2026-10-03，真实执行）

本机 gh 2.83.2 + AsteriskZuo 账号（keyring 登录，对 `AsteriskZuo/easemob-sdk-agent_v3` 权限 ADMIN）四条链路全部通过：登录态/权限校验、浅克隆下载、issue 链路（create → comment → close）、PR 链路（推临时分支 → create → comment → close → 删分支，无残留）。

## 复跑验证

只读（无害，可随时执行）：

```bash
node docs/researches/github-exit/gh-exit-verify.mjs
# 指定其他仓库：node docs/researches/github-exit/gh-exit-verify.mjs --repo <owner>/<repo>
```

写链路（会在目标仓库留下标题带「[验证]」前缀、已关闭的 issue/PR）：

```bash
node docs/researches/github-exit/gh-exit-verify.mjs --write
```

输出 `RESULT: PASS` 即全链路正常；前置条件：宿主机已安装 gh 且已登录（`gh auth login`），或设置了 `GH_TOKEN`。
