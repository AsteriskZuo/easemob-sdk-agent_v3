# 环境配置说明

> 平台行为验证日期：2026-11-14
> 用法：不知道某个配置项填什么值时查本文。**每个字段都对应平台侧的一份真实数据——照抄，不要凭记忆填**（这条原则来自 `docs/refs/2026-11-09-local-run-guide.md`，机制细节也以它为准，本文只做取值索引与坑位提示）。
> 安全红线：`.local-run/config.json` 与控制台安全桶含明文 secret。`.local-run/` 已被 gitignore；任何查询 secret 的 SQL 结果不要贴进 git、日志、群聊。

## 1. local-run config.json（本地独立运行）

完整字段 schema 以 `packages/local-runner/config.example.json` 为模板；逐字段机制规则表见 local-run-guide §6.2（不复制）。本文给**取值来源速查**与高频坑：

### 1.1 值从哪来：一条 SQL 查全 vars / secrets

```bash
# 在平台仓根目录执行（只读；scope='' 是全局兜底行，同键被业务 scope 行覆盖）
node --experimental-sqlite -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('.easemob-agent-workspace/platform/data/platform.db',{readOnly:true});
for (const r of db.prepare(\"SELECT scope,bucket,key,value FROM env_entries WHERE scope IN ('', ?) ORDER BY bucket,key\").all('<business_id>'))
  console.log(r.bucket, r.key, '=', r.value);
"
```

查到的 vars / secrets 按 bucket 分别抄进 config.json 的 `vars` / `secrets`。**secrets 必须填真值**（本地 run 会真实调 jira/git；diff 也逐键比较真值）。`wecom_key` 这类只有平台出口适配才读、业务程序不读的键，run 可随便填，但要 diff 全绿就照抄真值。

### 1.2 逐字段取值速查

| 字段 | 必填 | 值去哪找 | 坑 |
|---|---|---|---|
| `business_id` | ✅ | 工作区目录名：`.easemob-agent-workspace/businesses/{id}/`（**不是**业务英文名，是 `b01...` 形态） | 控制台业务列表也能看到 |
| `channel_id` | ✅ | 三段式 `source__session_id__business_id`：前两段从导出的事件 json 照抄 `source`、`session_id`，第三段 = 本配置 `business_id` | 填错 run 不报错但 diff 会 different，会话目录也对不上 |
| `prompt` / `model` | ✅ | 与控制台业务资料一致；prompt 长，从平台快照 JSON 或控制台复制 | 凭记忆缩写会导致本地与平台行为不一致 |
| `entry_program` | ✅ | 照控制台业务的入口程序值；必须命中包清单 `programs` 且产物已构建 | 不叫 `main` 也行（名字来自 programs 映射），但样例业务都是 `main` |
| `assets.package.path` | ✅ | 指向**含 agent-package.json 的目录**：业务仓是 `package/` 子目录，**不是业务仓根** | 指到仓根报「缺少 agent-package.json」 |
| `assets.tools` / `assets.skills` | 可选 | 各资产目录；`name` = 程序/技能解析名；顺序即名解析优先级 | 与控制台绑定的资产清单保持一致 |
| `vars` / `secrets` | 可选 | §1.1 的 SQL | secrets 顶层必须是**对象**（键值皆字符串），写成字符串直接报「配置字段 config.secrets 非法」 |
| `quota` | ✅ | 最终生效值，本地不推导。平台当前默认 `{"timeout_minutes":60,"max_agent_calls":20}`；最省事：开快照后从快照 JSON 的 `quota` 照抄 | 两个字段都必须 > 0 |
| `pi_agent_dir` | 可选 | 含生效 models.json 的目录。可直接引用平台派生产物：业务级 `.easemob-agent-workspace/businesses/{id}/cache/pi/agent`，或全局 `platform/cache/pi/agent` | 模型 apiKey 在这里，不写进 config.json |
| `pi_cli_path` | 可选 | `null` = 用**内置** pi（平台 npm 依赖锁定的版本），不是系统 PATH 里的 pi | 只有要强制换 pi 版本时才填 |
| `pi_env` | 可选 | 一般**不需要**：模型与密钥走 models.json，不经环境变量 | — |
| `pi_tools` | 可选 | pi 内置工具白名单，只允许 `read`/`grep`/`glob` | 缺省 = 不开放任何内置工具（即 `--no-tools`） |
| `workspace_root` | 可选 | 缺省 = 配置文件所在目录的 `workspace/` | 相对路径基于**配置文件所在目录**解析 |
| `stub_tools` / `stub_outputs` | 可选 | 出口护栏：本地没有平台出口适配，stub 让业务里"对外投递/出口类"工具调用返回固定值 | 机制与配置示例见 local-run-guide §6.4 |

路径通用规则：所有路径字段可写**绝对路径**；相对路径基于配置文件所在目录解析，与执行命令时所在目录无关。

### 1.3 构建方式坑（diff 场景）

本地要 diff 全绿，业务包须用资产根下的 `node agent.materialize.mjs` 构建（esbuild，与平台物化同款；先 `npm ci`）。`npm run build`（tsc）产物布局相同但**字节不同**，diff 会报 `programs.*` different。只 run 不 diff 则两种方式都行。

## 2. 控制台 env（业务环境变量）

- 配置位置：控制台业务编辑页的环境变量区；存储即 §1.1 SQL 查的 `env_entries` 表（`bucket=vars`，`scope=<business_id>`）。
- 取值纪律：通用 key（如 `jira_url`、出口 `wecom_key_out`）与业务自定义 key 都在业务仓的 `平台配置指南.md` 里列明——**以它为准**。
- 覆盖规则：`scope=''` 的全局行是兜底，同键业务行覆盖全局行；改完即用，无需重启。
- 坑：env 值必须是字符串；JSON 形态的值（如多仓登记表）不要塞 env——属于业务内部的数据放业务包内置文件（样例：`sdk-log-analysis` 的 `package/repos.json`）。

## 3. secrets 与安全桶

| 层 | 位置 | 用途 |
|---|---|---|
| 业务级安全桶 | 控制台业务编辑页的机密配置区（`bucket=secrets`，`scope=<business_id>`） | 本业务的 token/密码，如 `jira_username`/`jira_password`、出口 key |
| 通用层安全桶 | 控制台「通用配置」页（`scope=''`） | 跨业务复用的凭据；**私有资产凭据**（credential_key）从这里解析 |

- 安全桶**只写不读明文**：控制台不回显已保存的值；要核对真值用 §1.1 SQL（结果不得外泄）。
- 私有 git 资产登记时填的 `credential_key`，值必须在通用层安全桶已登记，否则绑定报：`凭据 key 未在通用配置安全桶登记: <key>`。

## 4. git 账号（操作私有代码仓）

业务约定（非平台强制，样例见 `business/sdk-log-analysis/package/packages/repos.ts`）：

```
secrets 键：git_account_<账号名>_username   git_account_<账号名>_token
```

- **一个账号对多个仓库**：登记表/配置里引用账号名，凭据按账号解析；不用一个仓库一对凭据。
- 宽容读：username/token 两个都拿到才注入凭据；缺 key 按无凭据继续——**公开仓保持缺省（不写这两个 key）即可匿名访问**。
- token 用 GitHub PAT（Personal Access Token）：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained 或 classic，按需勾选 repo 读权限。PAT 长期有效（除非主动撤销或设过期时间），适合放进安全桶。
- 平台拉私有仓走资产登记的 credential_key（§3），业务包内 git 操作走上面的 secrets 账号对，两套各管各的。

## 5. 入口适配器配置（webhook / jira polling 二选一）

- 开关在平台配置文件 `.easemob-agent-workspace/platform/config.json`：`AGENT_ENTRY_WEBHOOK_ENABLED` / `AGENT_ENTRY_JIRA_POLLING_ENABLED`，改后**重启平台进程**生效。
- 业务侧匹配行在控制台入口配置：webhook 配 path/token/session_id_key；jira polling 配项目、负责人、source 匹配。逐步操作以业务 `平台配置指南.md` 为准。
- 排错见 `troubleshooting.md` 症状 1；200/400/401/404 含义与 curl 验证法见 handbook `bizpkg.operations.no-event`。

## 6. pi 与大模型配置

- 模型凭据**平台持有**（models.json 里的 apiKey），业务代码不接触 key；本地运行引用平台派生的 `pi_agent_dir`（§1.2）。
- 平台级模型提供方配置在 `.easemob-agent-workspace/platform/config.json` 的 `AGENT_PI_MODELS`；业务级模型/模型链在控制台业务配置（pi 相关配置区），多模型规则见 spec `docs/specs/2026-11-01-business-multi-model-spec.md`。
- `pi_env` 几乎不需要设置：模型与密钥走 models.json，不经环境变量。
