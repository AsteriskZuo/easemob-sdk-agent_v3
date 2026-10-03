# GitHub 出口工具技术调研

调研日期：2026-10-03（gh CLI 方案已完成真实端到端验证）
调研目的：为「出口工具」GitHub 目的地（下载代码 clone / 提交 PR / 提交评论 / 提交 issue）确认技术可行性，为 spec 与工具类实现提供依据。

**方向裁决（owner 已定，2026-10-03）**：出口工具通过 GitHub 官方 CLI（`gh`）操作，**不直接调 REST API**。这些能力写成**工具类模式**：无业务知识、构造注入、零 `process.env`、零全局单例、调用方控生命周期，可在其他程序和平台直接复用；GitHub 侧无进程内状态，不需要实例（工具类退化为纯函数/薄封装也合理），认证态由 gh/宿主机托管。

## 结论（先说结果）

**gh CLI 方案已真实验证，全链路可用。** 2026-10-03 使用本机 gh 2.83.2（/opt/homebrew/bin/gh）+ 已登录账号 AsteriskZuo（对 `AsteriskZuo/easemob-sdk-agent_v3` 权限 ADMIN），实测通过四条链路：

1. **下载代码**：`gh repo clone <repo> <dir> -- --depth 1` 成功；
2. **issue 链路**：`gh issue create` → issue #1 → `gh issue comment` → `gh issue close` 全部成功（issue 不可删除，以关闭收尾）；
3. **PR 链路**：推临时分支（空提交）→ `gh pr create -B v3` → PR #2 → `gh pr comment` → `gh pr close` → 远端分支删除，无残留；
4. **登录态/权限校验**：`gh auth status`、`gh repo view --json viewerPermission,defaultBranch` 成功。

`gh` 本身就是 REST API 的官方客户端，能力一一对应且可经 `gh api` 兜底任意端点；直接 REST API 方案保留为备选（见「REST API 底册」一节）。可随时用 `gh-exit-verify.mjs` 复跑验证。

## gh CLI 方案（选定通道）

### 1. 认证模型

gh 的认证态由宿主机托管，token 存于系统 keyring，与出口工具进程完全解耦——这正是工具类模式「零 process.env、认证态托管」的落点。三种形态：

- **宿主机已登录态**（当前形态）：`gh auth login` 一次性完成授权，token 入 keyring；之后本机所有 gh 命令自动携带认证。本项目 2026-10-03 实测即此形态（token scopes: gist, read:org, repo, workflow，protocol: https）。
- **环境变量注入**（服务化/容器化形态）：`GH_TOKEN`（或 `GITHUB_TOKEN`）作用于 github.com，`GH_ENTERPRISE_TOKEN` 作用于 GHES；**优先级高于已存储的凭据**，设置后不会再触发交互授权。对应出口工具的 secret 配置：注入为子进程环境变量，构造参数传入，实现内零 `process.env` 读取。GHES 场景另有 `GH_HOST` 指定主机名。来源：[gh 手册 - Environment variables](https://cli.github.com/manual/gh_help_environment)
- **`gh auth login`**：交互式授权，仅人工初始化时用；工具类的 bind 校验用 `gh auth status` 而非触发登录。

### 2. 非交互运行注意事项

- 已登录态（keyring 或 GH_TOKEN）下，本调研涉及的全部命令（repo view / repo clone / issue create/comment/close / pr create/comment/close）**均非交互可用**，实测确认。
- 未登录且未设 GH_TOKEN 时，gh 会走交互授权流程——服务化部署必须注入 `GH_TOKEN`，否则子进程会挂起等待输入；可同时设 `GH_PROMPT_DISABLED=1` 让 gh 在无法交互时直接报错而非挂起。来源：[gh 手册 - Environment variables](https://cli.github.com/manual/gh_help_environment)
- 其余对子进程友好的环境变量：`NO_COLOR=1`（输出无 ANSI 色码，便于日志）、`GH_NO_UPDATE_NOTIFIER=1`（禁更新检查提示）。

### 3. gh ↔ REST 能力对应表

| 业务操作 | gh 命令（非交互关键参数） | 对应 REST 端点 |
| --- | --- | --- |
| 校验登录态/权限 | `gh auth status`、`gh repo view <repo> --json viewerPermission,defaultBranchRef` | `GET /repos/{owner}/{repo}` |
| 下载代码 | `gh repo clone <repo> <dir> -- --depth 1` | （git 传输，非 REST） |
| 创建 issue | `gh issue create -R <repo> --title <t> --body <b> --label <l>` | `POST /repos/{owner}/{repo}/issues` |
| 评论 issue/PR | `gh issue comment <n> -R <repo> --body <b>` / `gh pr comment <n> -R <repo> --body <b>` | `POST /repos/{owner}/{repo}/issues/{n}/comments` |
| 关闭 issue/PR | `gh issue close <n> -R <repo>` / `gh pr close <n> -R <repo>` | `PATCH ...（state=closed）` |
| 创建 PR | `gh pr create -R <repo> -B <base> -H <branch> --title <t> --body <b>` | `POST /repos/{owner}/{repo}/pulls` |
| 合并 PR | `gh pr merge <n> -R <repo>` | `PUT /repos/{owner}/{repo}/pulls/{n}/merge` |
| 任意 REST 兜底 | `gh api <path> -X <method> -f k=v` | 任意端点 |

来源：[gh issue create](https://cli.github.com/manual/gh_issue_create)、[gh pr create](https://cli.github.com/manual/gh_pr_create)、[gh repo clone](https://cli.github.com/manual/gh_repo_clone)、[gh api](https://cli.github.com/manual/gh_api)

两点 gh 侧特性：`-R <owner>/<repo>` 使所有命令不依赖本地 git 上下文（除 pr create 需要分支已推送）；`gh api` 自动携带认证头与 API 版本头，可替代任何手写 REST 客户端。

### 4. 真实验证记录（2026-10-03）

环境：gh 2.83.2（/opt/homebrew/bin/gh，homebrew 安装）；已登录 github.com 账号 AsteriskZuo（keyring 存储 token，scopes: gist, read:org, repo, workflow）；Git operations protocol: https；目标仓库 `AsteriskZuo/easemob-sdk-agent_v3`（viewerPermission: ADMIN，default branch: v3）。

| 链路 | 命令序列 | 结果 |
| --- | --- | --- |
| 登录态/权限 | `gh auth status` → `gh repo view --json viewerPermission,defaultBranchRef` | ✅ viewerPermission=ADMIN，defaultBranch=v3 |
| 下载代码 | `gh repo clone ... -- --depth 1` | ✅ 浅克隆成功 |
| issue | `gh issue create`（#1）→ `gh issue comment` → `gh issue close` | ✅ 全通；issue 不可删除，#1 已关闭留档 |
| PR | 空提交推临时分支 → `gh pr create -B v3`（#2）→ `gh pr comment` → `gh pr close` → 删远端分支 | ✅ 全通，无残留；#2 已关闭留档 |

复跑方式：`node docs/researches/github-exit/gh-exit-verify.mjs`（只读）/ `--write`（写链路，标题带「[验证]」前缀）。

## 对出口工具实现的建议（工具类模式）

### 结构

实现为无状态工具类 `GhCli`（或等价纯函数组），构造注入、无业务知识、零 `process.env`、零全局单例，调用方控生命周期：

- **构造注入参数**：`repo`（归一化后的 `owner/repo`）、`ghPath`（默认 `'gh'`）、`workDir`（clone/分支操作落盘根目录，调用方管理）、`token`（可选 secret；提供时以子进程环境变量 `GH_TOKEN` 注入，不提供则依赖宿主机已登录态）、`env`（可选附加环境，如 `GH_HOST`/`NO_COLOR`）。
- **方法**（每个方法 = 拼装参数 + spawn 一次 gh + 解析输出 + 失败抛错）：
  - `assertUsable()`：bind 时调用；执行 `gh --version` 与 `gh auth status`（有 token 时带上 `GH_TOKEN`），把「gh 缺失 / 未登录 / token 无效 / 仓库无权限」这类配置错误全部前置，避免首单业务投递才暴露。
  - `createIssue({ title, body, labels? })` → `gh issue create -R repo --title --body [--label ...]`；返回 `{ number, url }`。
  - `addComment({ subject: 'issue' \| 'pr', number, body })` → `gh issue comment` / `gh pr comment`。
  - `createPullRequest({ title, body, base, branch, workDir? })` → 在 workDir 内准备分支后 `gh pr create -R repo -B base -H branch`；返回 `{ number, url }`。分支准备（clone/checkout/commit/push）属 git 操作，可作为独立方法 `prepareBranch()` 暴露，调用方决定提交什么内容。
  - `cloneRepo({ dir, depth? })` → `gh repo clone repo dir -- --depth N`。
- **错误语义**：任何一步 gh 退出码非 0 → 抛错（带 gh 的 stderr 摘要），交给调度循环定级重试；不做进程内重试去重（与出口工具契约一致）。

### payload 结构建议（deliver 需 op 判别字段）

```jsonc
// op: issue — 提交 issue
{ "op": "issue", "title": "...", "body": "...", "labels": ["bug"] }
// op: comment — 提交评论（issue 与 PR 共用端点）
{ "op": "comment", "subject": "issue", "number": 1, "body": "..." }
// op: pr — 提交 PR（分支需已就绪，或 payload 指定在 workDir 内准备）
{ "op": "pr", "title": "...", "body": "...", "base": "v3", "branch": "feat/x" }
// op: clone — 下载代码
{ "op": "clone", "dir": "<相对 workDir 的子目录>", "depth": 1 }
```

`op` 缺失或未知 → 确定性失败（422 语义），立即抛错。

### 幂等建议（保留）

gh 与 REST 同一后端，**无幂等键，重试可能重复创建**（见「REST API 底册」第 5 节）。沿用原建议：payload 由业务层携带稳定 dedupe key（如 `<!-- agent-dedupe: <id> -->` 嵌入 body），投递成功后记录返回的 issue/PR `number` 与 `url`，重复时靠 key 可检索、可人工清理。

### 工作目录/clone 落盘策略

- `workDir` 由调用方注入并负责清理（工具类不隐式创建全局临时目录）；`cloneRepo({dir})` 的 `dir` 为 workDir 下的相对子目录，防止路径逃逸（拒绝绝对路径与 `..`）。
- PR 链路需要的本地 clone 与临时分支同属 workDir 管辖；验证脚本展示了一种「临时目录 + finally 清理」的完整范式。

## REST API 底册（备选方案）

> **本项目选定 gh CLI 为操作通道**，以下 REST 事实保留两处用途：① `gh api <path>` 兜底任意端点时的底册；② gh 不可用环境（如无法安装二进制的容器）的回退方案。事实均摘自官方文档。

### 1. 认证（底册）

- 官方推荐 fine-grained PAT（可限定单一组织/仓库、按端点授 Issues: write）；classic `repo` scope 权限面大，不推荐。创建 issue/评论最小权限 **Issues: write**。来源：[Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[Create an issue](https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#create-an-issue)
- token 经 `Authorization: Bearer <TOKEN>` 头携带（JWT 必须 Bearer）；建议固定 `Accept: application/vnd.github+json` 与 `X-GitHub-Api-Version: 2022-11-28`。来源：[Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28)
- GitHub App installation token（JWT 换 token，1 小时有效）适合组织级长期集成，实现成本高，本期不采用。来源：[About authentication with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)

### 2. 最小端点集（底册）

- 创建 issue：`POST /repos/{owner}/{repo}/issues`，`title` 必填，`body`/`labels`（字符串数组，label 必须已存在否则 422）/`assignees` 可选；返回 201，取 `number`/`html_url`。来源：[Create an issue](https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#create-an-issue)
- 添加评论：`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`，`body` 必填；PR 号同样适用。来源：[Create an issue comment](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#create-an-issue-comment)
- 合并 PR：`PUT /repos/{owner}/{repo}/pulls/{n}/merge`。

### 3. base URL（底册）

GitHub.com 为 `https://api.github.com`；GHES 为 `http(s)://{HOSTNAME}/api/v3`。来源：[GHES - Getting started with the REST API](https://docs.github.com/en/enterprise-server@3.19/rest/using-the-rest-api/getting-started-with-the-rest-api)。gh 侧对应 `GH_HOST`/`GH_ENTERPRISE_TOKEN` 环境变量。

### 4. 速率限制与错误结构（底册）

- 主限额：认证用户 5,000 次/小时（Enterprise Cloud 组织 15,000）；secondary 限额含内容生成 ≤80/分钟、≤500/小时，写请求 5 points/≤900 points/分钟。超限返回 403/429，按 `retry-after`/`x-ratelimit-reset` 退避。来源：[Rate limits for the REST API](https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api)
- 错误体统一 `{message, documentation_url}`；422 带 `errors[{code}]`（`missing_field`/`invalid`/`already_exists` 等）；私有资源无权限可能返回 404 而非 403。来源：[Troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)

### 5. 幂等缺口（底册，对 gh 同样成立）

GitHub 不支持幂等键，非安全方法不支持条件请求；「请求已发出但响应丢失」（典型 502）后重试会重复创建 issue。社区缓解：body 内嵌稳定 token、先查后建、事后清理。来源：[Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)、[Discussion #192764](https://github.com/orgs/community/discussions/192764)

### 6. 仓库地址归一化

与 gh 方案共用（destination_id 契约不变）。建议算法：先用 `new URL()` 解析显式协议 URL（http/https/ssh/git）；失败则按 scp 语法处理 `git@host:owner/repo`（去 `git@` 前缀、`:` → `/`）；再去末尾 `.git` 与 trailing slash、统一小写；两段式 `owner/repo` 补默认 `github.com`；输出 `host/owner/repo`，`destination_id` 按契约将 `:`/`/` 替换为 `_`。

| 输入 | 归一化结果 |
| --- | --- |
| `https://github.com/Owner/Repo.git` | `github.com/owner/repo` |
| `git@github.com:owner/repo.git` | `github.com/owner/repo` |
| `ssh://git@github.com/owner/repo.git` | `github.com/owner/repo` |
| `https://github.com/owner/repo/` | `github.com/owner/repo` |
| `owner/repo` | `github.com/owner/repo` |

## 风险与缺口

1. **宿主机 gh 登录态依赖（新增）**：工具类依赖宿主机已登录的 gh；容器化/换机部署必须注入 `GH_TOKEN`（secret 配置项），否则子进程挂起或失败。bind 校验（`gh --version` + `gh auth status`）可将此错误前置为明确的配置错误。
2. **幂等缺口（主要业务风险）**：调度循环重试 + GitHub 无幂等键 = 小概率重复创建 issue/PR；靠 payload dedupe key（嵌入 body）保证可发现性，需 spec 阶段明确取舍。
3. **label 不存在导致 422**：创建 issue 传入未创建的 label 会失败；约定 payload 只用已存在 label，或接受失败快速抛错。
4. **token 生命周期**：宿主机登录态的 keyring token 可能过期/被吊销（表现为 `gh auth status` 失败或 401）；GH_TOKEN 形态由运维负责续期。
5. **gh 二进制依赖**：版本漂移（本机 2.83.2）；CI/生产环境需在镜像中预装 gh。REST 直连方案是此风险的回退。
6. **404 歧义**：私有仓库无权限时 GitHub 返回 404，错误提示需涵盖「权限不足或仓库不存在」。
7. **GHES 未实测**：gh 支持 GHES（`GH_HOST`/`GH_ENTERPRISE_TOKEN`），但未对具体 GHES 版本验证；fine-grained PAT 需 GHES 3.9+。
8. **issue/PR 不可删除**：验证产生的 #1/#2 只能关闭留档；生产投递同样「只增不改（除 close）」，误投递靠 close + 评论补救。
