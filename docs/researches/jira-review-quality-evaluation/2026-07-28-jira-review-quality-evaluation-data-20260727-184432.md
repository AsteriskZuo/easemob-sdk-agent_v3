# Jira 工单审查质量评测报告

## 背景与评测条件

- 评测对象：`logs/data-2026-07-27 18 44 32`（2026-07-27 一个 jira_polling 运行批次，53 份逐工单日志，全部来自 jira_polling 来源）。
- 被评模型（工单审查）：**qwen3.7-plus**（53 份日志中均有记录），审查时加载项目内 `jira-ticket-review` skill，输出 pass/fail/skip 结构化审查结论。
- 评测模型（本报告作者）：**Kimi-k3**，通过项目内 `jira-review-quality-evaluation` skill 执行评测，评测日期 2026-07-28。
- 评测方法：先由脚本将逐工单日志脱敏摘录为副本，评测模型**先基于工单数据和审查标准独立形成判断（pass/fail/skip、classification、scenario、缺失项），再读取被评模型的原输出做对比评分**，避免围绕原文案挑问题。评分维度：decisionCorrectness 35 / reasonAccuracy 25 / actionability 15 / scopeDiscipline 15 / outputContract 10，总分 100。
- 审查标准：日志中未包含当时加载的完整 skill 文本（info 级日志），评测使用当前项目 `.agents/skills/jira-ticket-review/SKILL.md`；若审查 prompt 后续有变更，结论以该版本标准为准。
- 数据边界：评测只判断"工单信息是否足以让处理人开始工作"，不判断真实 bug 根因，不分析附件内容；工单数据均已脱敏。
- 评测过程摘录副本在 `/private/tmp/jira-review-quality-extract/`（临时目录，含 `summary.json` / `records.json` / `records.md`）；评测基于摘录副本完成，仅对 HIM-16561、HIM-22780、HIM-22786、HIM-22828 做过定向原始日志回读补充。
- 逐工单评分数据：同目录 `2026-07-28-evaluation-data-20260727-184432.json`。

## 总体结论

- 样本 53，可评分 53，无法评分 0。
- 平均分 92.9；good 49 / acceptable_with_issues 2 / bad 2 / needs_human_review 0。
- 35 个 skip 全部正确（issueType≠Bug，输出契约合规）；18 个 Bug 中 16 个主结论正确。
- 总体判断：审查模型整体可靠，可继续使用；主要风险集中在 QA 测试单的场景必须项口径不一致。

## 关键发现

- 最严重问题：**同类 QA 单口径不一致**。HIM-22779 因缺测试环境/集群和对象ID判 fail，但 HIM-22780（缺环境+发生时间）、HIM-22786（缺环境+对象ID）却判 pass，并把必须项写成"建议补充"——违反审查标准"不能把必须项降级为建议项"的明文原则。
- 次严重问题：HIM-22773 未提及群组对象ID缺失（场景6必须项），与 22779 口径同样不一致；该单对象ID不阻塞复现，pass 可接受，但 reason 未做说明。
- scenario 归类瑕疵：HIM-20780 把 SDK API 回调不触发归入"回调"场景（该场景面向服务端发送前/后回调，且会引入 AppKey 必须项），归消息操作/fallback 更稳；HIM-22668 归"性能/资源"不贴切，fallback 更合适。均未影响主结论。
- 高质量面：3 个 fail 全部正确且 reason 逐项可执行；多场景工单（HIM-22543）正确识别为同一问题上下文而非问题聚合。

## 按来源统计

- 仅 jira_polling：53 单，平均 92.9。无 jira_forwarded / jira_webhook 样本可对比。

## 按原始结论统计

| 结论 | 数量 | 平均分 | 误判 |
|---|---:|---:|---|
| skip | 35 | 95.0 | 0 |
| pass | 15 | 90.7 | 2（HIM-22780、HIM-22786 应 fail 而 pass） |
| fail | 3 | 93.0 | 0 |

## 典型案例

- 高质量：HIM-22663（fail 逐项列缺失并指出两轮评论未补有效信息）、HIM-22543（多现象正确归为同一 displayname 问题上下文）、HIM-16561（利用回调结构体中的 version/os 确认环境身份）。
- 误判：HIM-22780（64 分）、HIM-22786（66 分）——QA 单必须项被降级为建议项，pass 口径过宽，且与 HIM-22779 自相矛盾。属"确定的标准依据 + 口径边界"，建议人工复核确认 QA 单环境身份口径。
- acceptable_with_issues：HIM-20780（scenario 存疑，84）、HIM-22773（对象ID口径，84）。
- needs_human_review：无。

## Token 与成本观察

- 汇总：input 1,812,697 / cached 1,417,856 / output 38,109；缓存命中率约 78%。
- 平均每单 input ≈ 3.4 万 token、output ≈ 719 token，input 中约 2.2 万为缓存外新增，未见明显异常单。
- 53 单 reasoningOutputTokens 均为 0（该运行未开启或未记录 reasoning token）。
- 未见重复读取工单的现象；成本主要在大附件工单（如 HIM-17470 含 30MB+ 附件元数据与长评论）的工单数据预取体积，而非审查输出。

## 改进建议

- 审查 skill 提示词：
  - 针对 QA 测试单增加一条强约束：AppKey 的等价物（测试环境/集群）与场景必须项不可降级为建议项；给出 websdk5.0 类标题前缀是否算环境身份的明确口径，消除 22779 vs 22780/22786 式自相矛盾。
  - 明确"回调"场景是否涵盖 SDK API 回调不触发；若不涵盖，指引归消息操作/fallback。
- 日志使用方式：info 级日志不含加载的 skill 全文，评测只能回退到项目当前标准；如审查 prompt 会迭代，建议在日志中记录 skill 版本/hash，便于按当时口径评测。
- 模型选择：当前输出质量与 token 消耗匹配，无更换必要。
- 后续评测：重点抽样 QA 测试单（component=QA）验证口径一致性修复效果；对 skip 单可低频抽检。

## 无法评测清单

无。53 份日志均成功提取工单数据与原审查输出，issue key 一致性校验通过。
