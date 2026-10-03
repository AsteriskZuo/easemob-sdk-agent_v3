# GitHub 出口工具调研

本目录用于沉淀「出口工具」GitHub 目的地（下载代码 clone / 提交 PR / 提交评论 / 提交 issue）的技术调研与验证，为 spec 与工具类实现提供依据。

**替换决策（owner 已定，2026-10-03）**：操作通道为 **`@actions/github`（Octokit REST 客户端）**进程内直连 REST API。早期「gh CLI 子进程」方案已完成历史使命——四链路真实验证通过且实现落地，但按 dependency-rules §5「子进程非必要不使用」标准替换；gh 方案的全部记录保留在本目录，作为 REST 事实底册。

当前文件：

- `2026-10-03-github-rest-exit-research.md`：gh 认证模型、gh↔REST 能力对应表、REST API 底册（认证/端点/base URL/速率限制/幂等缺口/地址归一化）、风险与缺口；末尾附「2026-10-03 替换决策」章节（Octokit 方案四链路真实验证结果）。
- `octokit-exit-verify.mjs`：可反复执行的验证脚本，覆盖 token 解析（GH_TOKEN 或 `gh auth token`）、仓库权限探测（rest.repos.get）、tarball 下载（写入 os.tmpdir 后删除），`--write` 追加 issue 与 PR 写链路。依赖 `@actions/github`（workspace 根依赖，非 node 内置）。

优先阅读：

1. `2026-10-03-github-rest-exit-research.md`（含替换决策章节）
2. `octokit-exit-verify.mjs`

## Octokit 方案已验证结论（2026-10-03，真实执行）

对 `AsteriskZuo/easemob-sdk-agent_v3` 四条链路全部通过：`rest.repos.get` 凭证/权限探测、tarball 下载（follow 302 到 codeload，gzip 内容校验）、issue 链路（create → comment → close，issue #3）、PR 链路（推临时分支 → create → comment → close → 删分支，PR #4，无残留）。

## 复跑验证

只读（无害，可随时执行）：

```bash
node docs/researches/github-exit/octokit-exit-verify.mjs
# 指定其他仓库：node docs/researches/github-exit/octokit-exit-verify.mjs --repo <owner>/<repo>
```

写链路（会在目标仓库留下标题带「[验证]」前缀、已关闭的 issue/PR）：

```bash
node docs/researches/github-exit/octokit-exit-verify.mjs --write
```

输出 `RESULT: PASS` 即全链路正常；前置条件：设置 `GH_TOKEN` 环境变量，或宿主机已安装 gh 且已登录（token 经 `gh auth token` 复用，不打印）。
