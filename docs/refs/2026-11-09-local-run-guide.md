# 业务包本地运行操作指南

> 配套 spec：`docs/specs/2026-11-09-local-run-spec.md`（决策与契约的权威定义，本文档是操作手册）。
> 实现包：`packages/local-runner`（`@asteriskzuo/agent-local-runner`，CLI 名 `agent-local`）。

## 1. 这是什么

本地复现平台运行：用「本地配置文件 + 平台回放事件」装配出与平台**内容等值**的 RunContext，业务包**零改动**在本地跑完整流程（含真实 LLM 调用）。

三个用途：

1. **开发调试**：改业务代码后本地回放真实事件，不用部署平台；
2. **对齐验证**：`diff` 对比本地装配上下文与平台快照，确认本地准备工作的正确性；
3. **出口安全演练**：`stub_tools` 把发企微、回写 Jira 等出口工具替换为固定输出的替身，回放时不真实外发。

统一性约束（spec 决策 4）：本地运行的输入只许来自平台层统一产出——platform.db 导出的事件、平台上下文快照、本地配置文件。**严禁**解析业务日志或业务数据目录作为装载输入；需要新输入时先回平台层补统一产出。

## 2. 前置条件

- Node ≥ 24（`export-event` 用 `node:sqlite`，会打一条 ExperimentalWarning 到 stderr，无害）；
- 仓库已构建：`yarn build`（产物 `packages/local-runner/dist/src/cli.js`）；
- 被跑的业务包已构建：`assets.package` 目录内 `agent-package.json` 的 `programs[entry_program]` 指向的 `.js` 产物存在。**构建方式影响 diff**：要与平台 digest 对齐，必须用资产根下的 `node agent.materialize.mjs`（esbuild，与平台物化同款；需先 `npm ci` 装资产自己的 devDependencies），不要用 `npm run build`（tsc）——产物布局相同但字节不同；
- `pi_agent_dir` 指向的目录内含生效的 `models.json`（模型 apiKey 在此，不在本地配置里）。

## 3. 推荐目录布局

`.local-run/` 已加入 `.gitignore`（含 secrets 与工作区产物，永不提交）：

```text
.local-run/
├── config.json        # 本地运行配置（从 packages/local-runner/config.example.json 复制修改）
├── events/            # export-event 导出的回放事件
└── workspace/         # 本地运行产物（runs/ logs/ cache/ data/）
```

## 4. 三个子命令

monorepo 内直接调用（二选一，等价）：

```bash
agent-local <子命令> ...                              # node_modules/.bin 软链
node packages/local-runner/dist/src/cli.js <子命令> ... # 不依赖 bin 软链的兜底写法
```

| 子命令 | 用途 | 退出码 |
| --- | --- | --- |
| `run --config <配置> --event <事件.json>` | 装配上下文（含 stub 护栏）→ 执行 → 终端输出 RunOutcome 与日志路径 | 0=success；1=failed/timeout；2=输入非法或装配/执行抛错 |
| `diff --config <配置> --snapshot <快照.json> [--all]` | 本地装配上下文（stub 应用前）与平台快照做内容等值比较 | 0=全等；1=有差异；2=输入非法 |
| `export-event --db <platform.db> --event-id <id> --out <文件>` | 从平台数据库只读导出事件信封 | 0=成功；2=db/事件不存在等 |

`run` 成功后的终端输出含：`run_id`、完整 `RunOutcome`（status/reason/output）、业务日志路径、审计日志（llm-requests.jsonl）路径。

## 5. 快速上手：模板业务闭环（约 5 分钟，验证环境可用）

不碰真实业务，用 `templates/agent-package` 跑通全链路：

```bash
# ① 构建模板业务包（产出 dist/ 下的 main.js）
cd templates/agent-package && npm run build && cd ../..

# ② 准备配置：复制示例并按需修改（模板业务只需改少量字段）
mkdir -p .local-run/events
cp packages/local-runner/config.example.json .local-run/config.json
```

`.local-run/config.json` 最小可用内容（模板业务）：

```json
{
  "business_id": "e2e-template",
  "channel_id": "manual__e2e-session__e2e-template",
  "entry_program": "main",
  "model": "qwen/qwen3.8-max",
  "assets": {
    "package": { "path": "../templates/agent-package" },
    "skills": [{ "name": "tpl-skills", "path": "../templates/agent-package/skills" }]
  },
  "pi_agent_dir": "../.easemob-agent-workspace/platform/cache/pi/agent",
  "quota": { "timeout_minutes": 5, "max_agent_calls": 3 }
}
```

> `pi_agent_dir` 直接引用平台已派生的 pi 配置目录即可（内含 models.json）；路径相对配置文件所在目录解析。

```bash
# ③ 手写一个回放事件（兜底获取方式，契约与平台信封相同）
cat > .local-run/events/hello.json <<'EOF'
{
  "contract_version": "v1",
  "source": "manual",
  "event_id": "manual:hello:001",
  "event_type": "manual.test",
  "timestamp": "2026-11-09T15:30:00.000+08:00",
  "session_id": "e2e-session",
  "correlation_id": "manual:hello:001",
  "hop_count": 0,
  "payload": { "text": "用一句话介绍你自己" }
}
EOF

# ④ 跑
agent-local run --config .local-run/config.json --event .local-run/events/hello.json
# 期待：exit 0，终端打印 RunOutcome（status: "success"）与日志路径
```

产物落在 `.local-run/workspace/businesses/e2e-template/` 下（runs/ 工作区、cache/agent-sessions/ 会话、logs/ 业务日志、data/ 业务持久数据）。

## 6. 真实业务回放：jira-ticket-review 完整流程

### 6.1 导出真实事件

事件信封存在平台数据库 `entry_tasks.event` 列。先挑一个事件 id：

```bash
# 列出最近事件（只读；status=enqueued 说明还在队列，done 可能被定期清理，导出要及时）
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('.easemob-agent-workspace/platform/data/platform.db',{readOnly:true});
for (const r of db.prepare('SELECT event_id,status,enqueued_at FROM entry_tasks ORDER BY enqueued_at DESC LIMIT 10').all())
  console.log(r.status, r.enqueued_at, r.event_id);
"
```

导出：

```bash
agent-local export-event \
  --db .easemob-agent-workspace/platform/data/platform.db \
  --event-id evt_01M6ZMWVVFTMK9KAA4W57YPVA6 \
  --out .local-run/events/HIM-xxxxx.json
```

### 6.2 编写业务配置

以 `packages/local-runner/config.example.json` 为模板。原则：**每个字段都对应平台侧的一份真实数据，照抄，不要凭记忆填**。vars / secrets 用这条 SQL 从 platform.db 查（只读）：

```bash
# scope='' 的行是全局兜底，同键被业务 scope 行覆盖；bucket 只有 vars / secrets 两种
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('.easemob-agent-workspace/platform/data/platform.db',{readOnly:true});
for (const r of db.prepare(\"SELECT scope,bucket,key,value FROM env_entries WHERE scope IN ('', ?) ORDER BY bucket,key\").all('<business_id>'))
  console.log(r.bucket, r.key, '=', r.value);
"
```

> secrets 在 platform.db 里是明文（v1 设计），查询结果不要贴进 git、日志、群聊。

字段详解（逐条对应 config.example.json）：

| 字段 | 规则与取值来源 |
| --- | --- |
| `business_id` | 平台分配的业务 id（工作区 `businesses/{id}/` 目录名就是它），**不是**业务英文名 |
| `channel_id` | 三段式 `source__session_id__business_id`（`packages/contracts/src/channel-id.ts`）：前两段从导出的事件 json 照抄（`source`、`session_id`），第三段就是本配置的 `business_id`。jira webhook 业务即 `webhook__<工单号>__<business_id>`。填错 run 不报错，但 diff 会 different，会话目录也与平台对不上 |
| `entry_program` | 不是保留字、不必叫 `main`：必须命中 `assets.package` 内 `agent-package.json` 的 `programs` 映射，且指向的 `.js` 产物存在。照平台业务资料的 entry_program 填 |
| `prompt` / `model` | 与平台业务资料（BusinessProfile）一致；prompt 较长，建议从平台快照 JSON 或控制台复制 |
| `assets.package.path` | 指向**含 agent-package.json 的资产目录**——jira-ticket-review 是业务仓的 `package/` 子目录，不是业务仓根目录 |
| `assets.tools` / `assets.skills` | 业务依赖的工具 / skill 资产目录；`name` 即程序 / 技能解析名。数组顺序即名解析优先级（包→工具→skill，与平台一致） |
| 路径通用规则 | 所有路径字段（`assets.*.path` / `pi_agent_dir` / `workspace_root`）都可写**绝对路径**；相对路径基于**配置文件所在目录**解析，与执行命令时所在目录无关 |
| `vars` / `secrets` | 用上面的 SQL 照抄。**secrets 必须填真值**：run 时 `jira_*` 要真实调 Jira；diff 对 secrets 逐键比较真实值（展示才脱敏为 `***`）。像 `wecom_key` 这种只有平台出口适配用、业务程序不读的键，run 随便填能跑通，但 diff 会 different——要 diff 全绿就全抄真值 |
| `quota` | 填**最终生效值**，本地不做推导。当前平台只有全局值：默认 `60 / 20`（`app/server/src/config.ts`，可被 `AGENT_TASK_TIMEOUT_MINUTES` / `AGENT_MAX_AGENT_CALLS` 覆盖）。最省事：开快照后从快照 JSON 的 `quota` 字段照抄 |
| `pi_agent_dir` | 含生效 models.json 的目录（模型 apiKey 在这里，不在本地配置里）。可直接引用平台派生产物：业务级 `.easemob-agent-workspace/businesses/{id}/cache/pi/agent`，或全局 `platform/cache/pi/agent` |
| `pi_cli_path` | `null` 或不写 = 用**内置** npm 依赖 `@earendil-works/pi-coding-agent` 的 bin（版本由 yarn.lock 锁定，与平台缺省一致），**不是**系统 PATH 里的 pi；只有要强制换 pi 时才填字符串 |
| `pi_env` | 传给 pi 子进程的环境变量覆盖，**一般不需要**——模型与密钥走 models.json，不经环境变量 |
| `stub_tools` / `stub_outputs` | 出口护栏，机制见 §6.4 |

> **构建方式影响 digest 对齐**：业务包要用资产根下的 `node agent.materialize.mjs` 构建（esbuild，与平台物化同款；先 `npm ci` 装资产自己的 devDependencies）。`npm run build`（tsc）产物布局相同但字节不同，diff 会报 `programs.*` different。

### 6.3 用 diff 验证准备工作（强烈建议先 diff 再 run）

diff 需要平台侧的真实上下文快照作基准。快照由调试钩子产生（默认关闭）：

```bash
# ① 平台服务开启快照开关后重启（环境变量方式；用 config.json 启动的改对应字段为 true）
AGENT_CONTEXT_SNAPSHOT=true ...

# ② 触发一次平台 run（同一个事件重放即可，重置方法见 .agents/skills/platform-ops/SKILL.md）：
#    - 轮询类入口：删 platform.db 中该事件已 done 的 entry_tasks 行，等平台重新轮询到；
#    - 或按入口业务语义重新触发（如更新 Jira 工单）。
#    快照落盘：.easemob-agent-workspace/businesses/{business_id}/logs/context-snapshots/{run_id}.json
#    注意：历史 run 没有快照（钩子是后加的），必须开开关后重放一次才有基准。

# ③ 对比（exit 0 = 本地准备工作正确）
agent-local diff --config .local-run/config.json \
  --snapshot .easemob-agent-workspace/businesses/<business_id>/logs/context-snapshots/<run_id>.json
```

diff 是**内容等值**比较：程序/技能路径两侧必然不同（平台物化缓存 vs 本地源码目录），比较的是文件内容 digest；secrets 只报「一致/不一致/缺失」，输出中一律脱敏为 `***`。有差异时逐字段打印 `platform=` / `local=`，按提示修配置即可；`--all` 可看含相等字段的完整报告。

### 6.4 配置出口护栏并回放

本地回放会真实执行业务流程，main 里对出口工具的调用会**真实再发一遍**（重复外发）。把出口工具列入 `stub_tools`，并可用 `stub_outputs` 指定替身固定输出（让业务能消费返回继续走完流程）：

```json
"stub_tools": ["wecom-notify", "jira-comment"],
"stub_outputs": { "wecom-notify": { "delivered": true } }
```

- `stub_tools` 中的名字必须命中解析后的 programs，否则装载报错（防止拼错导致护栏静默失效）；
- 未配置 `stub_outputs` 的替身默认输出 `{}`；
- 替身的 `[stub]` 标记和入参摘要进业务日志（stderr 通道），不污染结果。

> jira-ticket-review 的对外写（企微通知）是平台 exit_binding 出口适配发的，不经业务程序，业务内没有需要护栏的出口工具，所以它的 `stub_tools` 是 `[]`；上面的示例针对「业务程序自己调外部写接口」的情况。

```bash
agent-local run --config .local-run/config.json --event .local-run/events/HIM-xxxxx.json
```

### 6.5 重复回放注意

本地目录派生规则与平台一致，业务级 `data/` 持久目录会真实累积状态（如去重记录）。需要干净重放时删除对应目录：

```bash
rm -rf .local-run/workspace/businesses/<business_id>/data/<source>/<session_id>
```

## 7. 常见问题

- **`programs["main"]` 指向的产物不存在** → 先在资产目录构建业务包（`node agent.materialize.mjs`，需先 `npm ci`）。
- **diff 报 `program` / `programs.*` different** → 构建方式不一致：本地须用资产根的 `node agent.materialize.mjs`（与平台物化同款 esbuild）重建；`npm run build`（tsc）产物 digest 与平台不等。
- **`目录内缺少 agent-package.json`** → `assets.package.path` 指错了层级：要指向含清单的资产目录（jira-ticket-review 是业务仓的 `package/` 子目录），不是业务仓根目录。
- **`配置字段 config.secrets 非法：必须为对象`** → `secrets` / `vars` / `pi_env` 都是「键值均为字符串」的扁平对象，不能写成数组或嵌套对象。
- **`pi 可执行文件不可用`** → 先 `yarn install`（缺省从 npm 依赖解析 pi bin），或在配置里显式指定 `pi_cli_path`。
- **diff 报 `vars`/`quota` 不等** → 本地配置要求填平台最终生效值；去平台侧确认该业务的实际生效配置（控制台或 platform.db）。
- **diff 报 secrets 不一致** → 本地 `secrets` 与平台 env 不一致；diff 不会打印真实值，用 §6.2 的 SQL 自行核对。
- **run 卡住或 timeout** → 检查 `quota.timeout_minutes`、模型可用性（models.json 的 apiKey）、网络；业务日志与 `llm-requests.jsonl` 审计日志有完整调用记录。
- **stderr 的 `ExperimentalWarning: SQLite`** → Node 24 对 `node:sqlite` 的实验性提示，无害。
- **事件导出后平台侧 purge 了** → 导出文件是独立快照，不受影响；但**快照基准**需要开开关后重新跑出的 run，老 run 没有快照。

## 8. 边界（不要指望它做的）

- 不做凭据解析、上下架检查、注册表查询（path 资产无需凭据）；
- 不管下游服务与出口适配的真实行为——出口副作用用 `stub_tools` 护栏；
- 不验证业务输出质量，只保证上下文等值与流程可跑通；
- npm 发布形态、控制台一键导出回放包属后续衔接（spec §13）。

## 9. 附：本地执行定时任务程序（无事件 run 对等）

定时任务（spec `docs/specs/2026-11-13-scheduled-task-spec.md` 决策 D7）是平台按节奏自动触发的无事件 run。local-runner **零改动**：定时任务上下文无事件、形状极简，手工构造信封用管道喂给程序即可——本地与平台执行的是同一份产物、同一套凭据、同一个 bare 缓存布局。

以 sdk-log-analysis 的仓预热（warmup）为例（前置：业务包已构建，产物 `business/sdk-log-analysis/package/dist/apps/warmup/index.js` 存在，构建方式见 §2）：

```bash
echo '{
  "contract_version": "v1",
  "input": {
    "contract_version": "v1",
    "source": "manual",
    "event_id": "manual:warmup:001",
    "event_type": "scheduled.warmup",
    "timestamp": "2026-11-13T16:00:00.000+08:00",
    "session_id": "warmup",
    "correlation_id": "manual:warmup:001",
    "hop_count": 0,
    "payload": { "task_name": "warmup", "trigger": "manual" }
  },
  "config": {
    "sdk_repo_url": "https://github.com/easemob/emclient-linux",
    "sdk_repo_account": "<git 账号名，公开仓可省>"
  },
  "secrets": {
    "git_account_<账号名>_username": "<用户名>",
    "git_account_<账号名>_token": "<令牌>"
  },
  "cacheDir": "<repo>/.local-run/workspace/businesses/sdk-log-analysis/cache"
}' | node business/sdk-log-analysis/package/dist/apps/warmup/index.js
```

要点：

- **程序实际消费的字段**只有 `config` / `secrets` / `cacheDir` 三个：`config.sdk_repo_url` 必填（http(s) URL，控制台登记值，照抄方法同 §6.2 的 SQL）；`config.sdk_repo_account` + `secrets` 里 `git_account_{账号}_username/token` 一对是私有仓凭据（宽容读，缺一按无凭据继续——公开仓两组都可全省）。`input` 是合成事件（形状见 spec §5），warmup 不读它，但信封契约要求 `input` 字段必须存在。
- **cacheDir 布局与平台一致**：bare 缓存落在 `{cacheDir}/repos/{slug}`，锁是 `{cacheDir}/repos/.lock`（mkdir 原子获取）——与平台预热、事件 run 的 prepareWorktree 共用**同一把锁、同一套协议**，指向同一目录时本地与平台互斥等锁、不会写坏缓存。
- **cacheDir 目录先自建**：平台 run 启动时会代建，手工执行不会——首次跑前 `mkdir -p` 该目录。
- **结果判定**：exit 0 + stdout 结果行 `{"contract_version":"v1","ok":true,"output":{...}}`（`output.action` 为 `cloned`（冷仓首克隆）或 `fetched`（热仓增量 fetch），另含耗时与 repo_dir）；exit 1 + `ok:false`，`reason` 即失败原因（凭据已脱敏），stderr 有完整业务日志。
- **不喂 TTY**：直接 `node ...` 不带管道会因 stdin 无注入输入报错——必须经管道或重定向喂入信封。
