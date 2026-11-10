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
- 被跑的业务包已构建：`assets.package` 目录内 `agent-package.json` 的 `programs[entry_program]` 指向的 `.js` 产物存在；
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
  "channel_id": "manual:e2e-session",
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

以 `packages/local-runner/config.example.json` 为模板，关键字段对齐方式：

| 字段 | 取值来源 |
| --- | --- |
| `business_id` | 平台该业务的 business_id（注意：是平台分配的 id，工作区下 `businesses/{id}/` 目录名就是它） |
| `channel_id` | **与平台该次 run 一致**（影响会话映射键，可从导出事件的 source/session_id 推） |
| `entry_program` / `prompt` / `model` | 与平台业务资料（BusinessProfile）一致 |
| `assets.package.path` | 业务仓根目录（含 agent-package.json 与构建产物），如 `../business/jira-ticket-review` |
| `assets.tools` / `assets.skills` | 业务依赖的工具/skill 资产本地目录，**顺序即名解析优先级**（包→工具→skill，与平台一致） |
| `vars` / `secrets` | 与平台 env 中该业务的两桶配置一致（secrets 只在本地，严禁提交） |
| `quota` | 填**最终生效值**（业务覆盖 ?? 平台全局默认 的推导结果；本地不做推导） |
| `pi_agent_dir` | 可直接引用平台派生产物目录（含 models.json） |
| `stub_tools` | **务必**把有外部副作用的出口工具（发企微、回写 Jira 等）列进来，见 §6.4 |

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

```bash
agent-local run --config .local-run/config.json --event .local-run/events/HIM-xxxxx.json
```

### 6.5 重复回放注意

本地目录派生规则与平台一致，业务级 `data/` 持久目录会真实累积状态（如去重记录）。需要干净重放时删除对应目录：

```bash
rm -rf .local-run/workspace/businesses/<business_id>/data/<source>/<session_id>
```

## 7. 常见问题

- **`programs["main"]` 指向的产物不存在** → 先构建业务包（业务仓内 `npm run build`）。
- **`pi 可执行文件不可用`** → 先 `yarn install`（缺省从 npm 依赖解析 pi bin），或在配置里显式指定 `pi_cli_path`。
- **diff 报 `vars`/`quota` 不等** → 本地配置要求填平台最终生效值；去平台侧确认该业务的实际生效配置（控制台或 platform.db）。
- **diff 报 secrets 不一致** → 本地 `secrets` 与平台 env 不一致；diff 不会打印真实值，自行核对。
- **run 卡住或 timeout** → 检查 `quota.timeout_minutes`、模型可用性（models.json 的 apiKey）、网络；业务日志与 `llm-requests.jsonl` 审计日志有完整调用记录。
- **stderr 的 `ExperimentalWarning: SQLite`** → Node 24 对 `node:sqlite` 的实验性提示，无害。
- **事件导出后平台侧 purge 了** → 导出文件是独立快照，不受影响；但**快照基准**需要开开关后重新跑出的 run，老 run 没有快照。

## 8. 边界（不要指望它做的）

- 不做凭据解析、上下架检查、注册表查询（path 资产无需凭据）；
- 不管下游服务与出口适配的真实行为——出口副作用用 `stub_tools` 护栏；
- 不验证业务输出质量，只保证上下文等值与流程可跑通；
- npm 发布形态、控制台一键导出回放包属后续衔接（spec §13）。
