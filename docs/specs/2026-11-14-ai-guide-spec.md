# AI 开发者指南 spec（业务包开发者的 AI 工作手册）

- 日期：2026-11-14
- 状态：已定稿（需求方已确认，含 Q1–Q4 确认项）
- 背景出处（非必读）：`handbook/README.md`（三消费面规划，AI 面"已预留未落地"）；`docs/refs/2026-11-09-local-run-guide.md`（本地运行指南）；两个样例业务的 `平台配置指南.md`

## 1. 问题与目标

平台的开发者、业务包的开发者都会带着自己的 AI（Kimi Code / Claude Code / Cursor 等）来干活。AI 进仓库第一个读到的通常是 `AI.md` / `AGENTS.md` / `llms.txt` 这类入口文件，但本项目 `AI.md` 只有 3 行空话，业务包开发者（主受众）的 AI 没有任何可执行的工作手册：不知道业务包怎么开发、环境字段的值去哪里找、出问题去哪个日志排查。

现有材料的缺口：

1. **入口缺**：`AI.md` 无角色路由、无纪律、无文档地图；
2. **流程型文档缺**：`handbook/content/bizpkg/*` 是参考字典式条目（每个字段一条），不是"从零开发一个业务包"的端到端流程；各业务 `平台配置指南.md` 只管控制台操作，不管开发；
3. **症状型文档缺**：排查问题靠口述经验（平台层有 platform-ops skill，但业务包层面没有给外部开发者的排查手册）。

目标：

1. `AI.md` 成为唯一必读根入口：角色路由 + AI 纪律 + 文档地图 + 命令速查，≤120 行；
2. 新写三篇流程/症状型文档（`docs/ai/`）：开发手册、问题排查手册、环境配置说明；
3. 参考类内容**复用不重写**：三篇新文档对 handbook 条目、业务配置指南、local-run 指南只做指针引用，不复制内容（引用不复制，防两处漂移）；
4. 平台知识只写业务包开发者**必要了解**的部分（事件流转、契约闸门、日志位置），平台内部实现不展开；
5. 业务包模板和各业务仓内放 3~5 行的 `AI.md` 指针，把业务仓里干活的 AI 导回总入口。

## 2. 非目标

- **不落地 handbook 的 AI 消费面**（llms.txt 生成器）：那是 handbook 体系的独立迭代项，本 spec 不实现、不阻塞；将来迁移路径见 §7；
- 不改 handbook 任何现有条目、不改 codegen；
- 不重写 `handbook/content/bizpkg/*`、不合并各业务 `平台配置指南.md`（它们继续按原节奏维护，新文档只引用）；
- 不写平台维护者文档（那是 `AGENTS.md` + `docs/README.md` 的职责，AI.md 只给指针）；
- 不替换 `platform-ops` skill（平台层内部排查工具，业务包开发者不需要）。

## 3. 决策记录（已与需求方确认）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 新三篇放哪 | `docs/ai/` 自由 markdown。理由：handbook 的 AI 面生成器未落地，现在写 YAML 背 META 条目化成本却无生成收益；内容稳定后迁移进 handbook（路径见 §7） |
| D2 | AI.md 形态 | 薄入口（≤120 行）：只做路由、纪律、地图、速查，不承载正文 |
| D3 | 与 handbook 的关系 | 引用不复制：新文档按条目 id / 文件路径指针引用 handbook 与既有指南；handbook 条目仍是字段语义唯一权威来源 |
| D4 | 主受众 | 业务包开发者；平台知识按"必要了解"裁剪（事件流转一张图、契约两道闸门、日志位置模板、常见平台报错） |
| D5 | 业务仓入口 | `templates/agent-package/` 模板内置 `AI.md` 指针文件；存量两个业务仓各补一个同款指针。指针按**仓库名**引用平台仓（`AsteriskZuo/easemob-sdk-agent_v3`），禁止写绝对路径——其他开发者机器上平台仓位置不同 |
| D6 | 文档语言 | 简体中文（项目惯例） |
| D7 | 执行方式 | 主代理直接撰写，不用子代理。理由：三篇文档大量内容来自近期实践积累的踩坑记录（需求方操作卡点、真实故障案例），子代理冷启动无法获得这些事实，转述成本高且易失真；文档写作无代码风险 |
| D8 | 端到端验收收窄（Q1） | 验收演练 = **只读任务**：子代理只凭 AI.md + 三篇文档 + 业务仓路径，完成"对已导出事件跑本地独立运行并判定 success"，不允许改代码、不允许问人。代码修改类任务不在演练范围 |
| D9 | 文档保鲜机制（Q2） | 双保险：①每篇文档开头标注"平台行为验证日期"；②根仓 `AGENTS.md` 加一条纪律——平台行为变更的 spec 落地时，同步检查 `AI.md` 与 `docs/ai/` 是否受影响 |
| D10 | 提交顺序（Q3） | v3 根仓先行一次提交（AI.md + docs/ai/ 三篇 + spec + 模板 AI.md）；两个业务仓的 5 行指针在根仓内容落地且需求方过目后，各自单独提交 |
| D11 | 安全纪律 | `.local-run/config.json` 含 secrets（已被 `.gitignore` 排除），AI.md 纪律必须含：真实 token/secret 永不写入任何会提交进 git 的文件 |

## 4. 设计

### 4.0 交付物清单

| 文件 | 性质 | 规模预期 | 所在 git 仓 |
|---|---|---|---|
| `AI.md`（仓库根，覆盖现有 3 行） | 新写 | ≤120 行 | v3 根仓 |
| `docs/ai/development.md` | 新写 | 400~600 行 | v3 根仓 |
| `docs/ai/troubleshooting.md` | 新写 | 300~450 行 | v3 根仓 |
| `docs/ai/environment.md` | 新写 | 250~350 行 | v3 根仓 |
| `templates/agent-package/AI.md` | 新写 | 3~5 行指针 | v3 根仓 |
| `business/jira-ticket-review/AI.md` | 新写 | 3~5 行指针（内容同模板） | jira-ticket-review 仓 |
| `business/sdk-log-analysis/AI.md` | 新写 | 3~5 行指针（内容同模板） | sdk-log-analysis 仓 |

### 4.1 写给 AI 的文档风格规约（四篇正文统一遵守）

这是本项目第一次给"AI 读者"写长文档，风格上与人读文档有本质区别，必须立规约：

1. **命令必须可直接执行**：给出完整命令（含仓库相对路径），不允许"运行测试"这类模糊指令；每条命令旁边注明预期输出/成功判据；
2. **路径全部相对仓库根**：AI 读者以仓库根为 cwd，绝对路径只出现在"值从哪里找"的示例里（如 `file:///Users/...`）；
3. **每节末尾有"验证"动作**：流程型文档每步给出怎么确认这一步成了；没有验证动作的步骤视为没写完；
4. **症状驱动、不散文**：排查手册按"现象 → 看哪个日志（确切路径模板）→ 常见原因列表 → 修复动作"组织，不写背景抒情；
5. **事实可核验**：文档写到的每个命令、路径、env key、日志格式，落笔前必须与当前代码/实际日志核对一遍（实现任务的 T1 就是核对），禁止凭记忆写；
6. **铁律条目化**：纪律/禁令用编号列表，每条一行，AI 可逐条执行；
7. **不确定就说不确定**：每篇文档开头标注"平台行为验证日期：2026-11-14"；平台行为可能演进处加注。

### 4.2 `AI.md` 全文框架（逐节内容要求）

```
# easemob-sdk-agent_v3 — AI 工作入口

## 你是谁（角色路由）
- 路由表：业务包开发 → 读本文件 + docs/ai/ 三篇；平台维护 → AGENTS.md + docs/README.md；
  部署运维 → docs/refs/ 部署文档。判定方法一句话（看你要改动的代码在哪个目录）。

## 必读纪律（≤10 条）
候选条目（实现时逐条核实措辞）：
1. 你只开发业务包，不修改 packages/ 平台代码；发现平台疑似 bug，停下来向平台维护者报告
2. 不绕过 check-input / check-output 契约闸门，不为跑通而改宽契约
3. 改动后必须运行包内验证命令（npm test / typecheck），并贴出结果
4. 引用文件一律仓库相对路径
5. 修改配置类文件前先备份原值
6. 真实 token/secret 永不写入任何会提交进 git 的文件（.local-run/ 含 secrets，已被 gitignore）
7. 日志路径模板见 troubleshooting.md，排查先看日志再猜
8. 操作控制台类步骤优先读本业务 平台配置指南.md
9. 遇到契约疑问（输入输出字段语义）查 handbook/content/bizpkg/contract.yaml，查不到再上人

## 项目一分钟
- 一句话：平台 + 业务包 双层结构；业务包 = 独立 git 仓 + agent-package.json + main + contract
- 平台必要知识三件套：事件流转（入口→队列→run→出口通知）、契约两道闸门、日志位置
  （全部只给一句话 + 指向 docs/ai/ 对应章节，不展开）

## 文档地图（按角色给阅读顺序）
- 业务包开发：development.md →（开发中查）handbook bizpkg → environment.md → troubleshooting.md
- 每篇一行说清"什么时候读"

## 命令速查（≤8 条）
- 业务包：npm test / npm run typecheck（dist-test 模式）
- 本地独立运行：export-event + run 两条（指向 local-run-guide.md 细节）
- 平台：查 run 状态 SQL、tail 平台 system.log（指向 troubleshooting.md）
```

### 4.3 `docs/ai/development.md` 详细目录（流程型）

```
# 业务包开发手册

## 0. 本手册怎么用（写给 AI：按序执行，每步有验证）

## 1. 业务包是什么（边界 10 行版）
- 与平台的关系、两个样例业务（审查工单=有入口适配器；日志分析=internal 派生，无入口）
- 指针：handbook/content/bizpkg/overview + layout（不复制）

## 2. 从零创建：模板向导
- 复制 templates/agent-package/ → 改哪些文件（逐文件清单：agent-package.json 字段、
  contract.json 怎么定、main.ts 骨架、requires 声明）
- 验证：npm test 绿、typecheck 过

## 3. 实现业务逻辑
- main 编程模型（上下文怎么拿、sdk 怎么用、日志怎么打）
- check-input / check-output 的职责划分（闸门在平台，业务内只做业务校验）
- 指针：handbook/content/bizpkg/development.yaml、contract.yaml 逐字段
- skill / tool 的挂载方式（叶子级目录约定）
- 验证：本地单测

## 4. 本地独立运行调试（开发主循环）
- export-event 从平台库导出真实事件 → 写 config.json → run
- 指针：docs/refs/2026-11-09-local-run-guide.md（细节不复制）；
  environment.md（config.json 每个字段的值去哪找）
- 强调：本地跑通 = 平台上跑通的必要条件，平台差异点只有入口/出口适配
- 验证：本地 run success + 输出符合 contract

## 5. 上架：资产登记与业务绑定
- 资产三条（package/tool/skill）、subpath 叶子级约定、ref 版本钉语义
- 创建业务、绑资产、填提示词总纲、env/secret 配置
- 指针：本业务 平台配置指南.md（控制台逐步操作不复制）
- 验证：控制台手动触发或等真实事件，run success

## 6. 上下游编排
- 契约即联系：上游输出字段 = 下游输入字段；internal 派生机制一句话
- 下游过滤职责（平台公平原则：谁消费谁过滤）
- 验证：真实链路两个 run 都 success

## 7. 发布前检查清单（checklist，10 条以内，可勾选）
```

### 4.4 `docs/ai/troubleshooting.md` 症状目录（症状型）

组织方式：先给"日志位置总表"（平台 system.log、业务 run 日志、local-run 日志的确切路径模板和 times 时区坑：DB 里是 UTC，本地 +8），然后按症状分节。每个症状四段式：现象 / 去哪看（路径模板）/ 常见原因（编号列表）/ 修复动作。

症状清单（实现时逐一核实，可增删）：

| 症状 | 已有真实案例 |
|---|---|
| 事件根本没产生（入口没触发） | jira polling 开关、webhook 开关、source 匹配行 |
| 事件入队了但没有 run | 平台层，指针指 platform-ops 思路，给判定 SQL |
| run 一直 running 不结束 | HIM-24161 真实案例：查 run 日志尾部、pi 进程 |
| 入口拦截（check-input validation_failed） | 契约缺字段；事件导出后字段被改动 |
| 出口拦截（check-output 失败） | 业务输出缺字段 |
| 通知没发出 / 企微内容被截断 | 截断是平台 4096 字节硬限制，必要行为；全文看 run 日志 |
| internal 派生没触发下游 | 上游输出状态/字段不满足派生条件 |
| 日志分析选仓失败（platform_unknown） | 关键词未命中，登记表 match 补充 |
| warmup 单仓失败 | SSL/网络瞬断，warn 不阻断；cron 日志逐仓进度 |
| 资产物化慢 / 入口程序下拉为空 | subpath 漏填坑（平台配置指南已记录，指针引用） |
| local-run 报 config 非法 | secrets 必须对象、assets.package.path 需含 agent-package.json |
| 改完代码平台行为没变 | 资产 ref 没更新 / 控制台缓存 / dev server 没重启 |

平台层深度排查（队列、调度、出口投递内部）不做展开，只给一句"到这层找平台维护者 + platform-ops skill 位置"。

### 4.5 `docs/ai/environment.md` 字段目录（值去哪找）

组织方式：按"配置面"分节，每节一张表：字段 / 类型 / 值去哪找 / 示例 / 坑。

```
## 1. local-run config.json（本地独立运行）
逐字段：channel_id / entry_program / assets.package.path（相对/绝对路径规则）/
vars / secrets / pi_agent_dir / pi_cli_path（null=内置）/ pi_env /
stub_tools / stub_outputs（桩的意义：不依赖上下游）
→ 本节是重点，需求方亲自踩过"不知道填什么"的坑

## 2. 控制台 env（业务环境变量）
通用 key + 业务自定义 key 的约定；值去哪找

## 3. secrets 与安全桶（控制台通用配置）
secrets 结构约束（对象、键值皆字符串）；credential_key 引用机制

## 4. git 账号（私有仓凭据）
git_account_<名>_username / git_account_<名>_token 命名约定；
一个账号对多仓；PAT 获取方法（github 设置路径）与"长期有效"说明；
公开仓可缺省（匿名）

## 5. 入口适配器配置（webhook / jira polling 二选一）
开关位置、source 匹配行含义

## 6. pi 配置
pi_env 什么时候需要；模型配置入口指针（控制台/多模型 spec）
```

### 4.6 业务仓 `AI.md` 指针（模板 + 两个存量业务仓）

内容 3~5 行，示意（注意 D5：按仓库名引用，禁止绝对路径）：

```markdown
# 本业务包由平台 easemob-sdk-agent_v3 驱动

你是本业务包的开发助手。平台契约、开发流程、环境配置、排查手册：
先获取平台仓 AsteriskZuo/easemob-sdk-agent_v3（本地没有则克隆），
从其根目录 AI.md 开始按角色路由阅读。
本业务的控制台配置步骤：平台配置指南.md（同目录）。
```

### 4.7 handbook 迁移预留（非本 spec 实现）

将来 handbook AI 面（llms.txt 生成器）立项时：`docs/ai/` 三篇的流程/症状内容**不搬**（它们不是条目化参考，是叙事文档，适合留在 docs/），但要把三篇注册进 llms.txt 的导航；handbook/content/bizpkg 的字段语义条目维持单一权威，docs/ai/ 保持指针。迁移时检查一次指针有效性即可。

## 5. 写作事实核对清单（实现任务 T1，必须先做）

落笔前逐项核对（核对结果直接写进文档，不凭记忆）：

- local-runner CLI 实际命令与参数（`packages/local-runner` 的 cli 入口、export-event/run 子命令）
- config.json 全字段 schema（local-runner 的校验代码）
- 业务 run 日志、平台 system.log 实际路径与格式（用 HIM-24170 真实日志核对）
- env/secrets/credential/git 账号的 key 命名与控制台位置（asset-registry / console-api 代码 + 平台配置指南交叉核对）
- handbook bizpkg 各条目 id（引用指针用）
- npm test / typecheck 在业务包里的实际命令（package.json scripts）
- 事件流转各环节的真实模块名（channel / queue / scheduler / runtime / exit-tools），一分钟版不说不存在的名字

## 6. 验收标准

1. AI.md ≤120 行，含角色路由、≥6 条纪律、文档地图、命令速查；
2. 三篇文档每个「验证」小节都有可执行判据；排查手册每个症状都有确切日志路径模板；
3. 文档中每条命令、路径、key 经过 §5 核对（抽查 10 处，全部与代码/真实日志一致）；
4. 新文档对 handbook/指南/ local-run-guide 只引用不复制（grep 检查无大段重复）；
5. 端到端验收（D8）：子代理扮演干净 AI 读者，只凭 AI.md + 三篇文档 + 业务仓路径，完成"对已导出事件跑本地独立运行并判定 success"，中途不问人、不改代码；一次通过即合格，不通过则按缺口修文档后重跑一次为限；
6. `yarn docs:check` 不红（没碰 handbook，应天然通过）；
7. 三处业务仓/模板 AI.md 指针就位，路径指向正确；
8. 根仓 `AGENTS.md` 已加入 D9 ②的同步检查纪律。

## 7. 任务拆分

| 任务 | 内容 | 验收 | 执行者 |
|---|---|---|---|
| T1 事实核对 | §5 清单逐项核对，产出核对笔记（命令输出摘录，写作素材，不交付不进 git） | 核对笔记覆盖全部条目 | 主代理 |
| T2 AI.md + 指针 | AI.md 全文 + 模板/两业务仓指针文件 | 验收 1、7 | 主代理 |
| T3 development.md | §4.3 全文 | 验收 2、4 | 主代理 |
| T4 troubleshooting.md | §4.4 全文 | 验收 2、4 | 主代理 |
| T5 environment.md | §4.5 全文 | 验收 2、4 | 主代理 |
| T6 AGENTS.md 纪律 + 自审 + 演练 | D9② AGENTS.md 加纪律；交付前自审（引用事实抽查、错链、前后矛盾）；验收 5 干净读者演练（子代理扮演，唯一子代理用法，见 D7/D8） | 验收 3、5、6、8 | 主代理 + 1 子代理（演练） |

依赖：T1 → T2~T5（T2~T5 可分批做）→ T6。提交顺序按 D10：根仓一次提交，业务仓指针在需求方过目后各自提交。
