# Jira 工单审查质量评测报告

- 日志目录：`logs/data-2026-07-29 11 47 17`
- 审查模型：qwen3.7-max
- 审查标准：按日志实际加载标准评测（jira-ticket-review v1.1.0，hash 7232e8cd）
- 摘录副本：`/private/tmp/jira-review-quality-extract/2026-07-29-114717/`（评测仅基于副本完成，未回读原始日志）
- 说明：本批次 50 单与 10:47:27 批次（qwen3.7-plus）工单完全相同，独立判断口径与上一份报告一致，便于模型对比。

## 总体结论

- 样本 50 单，全部可解析、可评分，无法评测清单为空。
- 原始结论分布：skip 31 / pass 15 / fail 4；来源全部为 jira_polling。
- 平均分约 97.4；good 49 / acceptable_with_issues 0 / bad 1 / needs_human_review 0。
- 总体判断：**值得继续使用，但出现一次主结论错误**：HIM-22875（ANR）把场景必须项「触发路径」降级为建议项判 pass，按标准应判 fail。

## 关键发现

- 最严重的问题（确定问题）：**HIM-22875 漏判 fail**。工单仅有「SDK 4.24.0，客户升级后出现 ANR」，无触发路径（场景 1 必须项）；模型自己也在 reason 里列出「ANR 发生时的具体操作场景」缺失，却把它当建议项放行。标准明确「必须项缺失时必须判 fail，不能降级为建议项」。这是两批次 100 条评审中唯一的主结论错误。
- 优点：**reason 的必须项/建议项边界明显比 plus 干净**。HIM-22663、HIM-22779、HIM-22828 三个 fail 的缺失项清单全部命中真实必须项，无膨胀；多个 pass 单正确使用「预期可推断 → pass + 建议显式补充」的契约口径（HIM-22543、22859）。
- QA 单薄单的内部一致性比 plus 好：bug 内容为空（22779、22828）→ fail；有具体现象（22780、22868）→ pass；描述自相矛盾（22865）→ fail。界限可解释、可复用。
- 轻微问题：HIM-16561 建议「补充客户 AppKey 明文」——工单里 AppKey 以脱敏占位符存在，按标准应视为已提供，要求提交人补明文是错误引导。
- scenario 小瑕疵：HIM-22826（API 与文档不一致）归「文档/demo」不如 plus 的 fallback 贴切；HIM-17470 归「崩溃/卡死」则比 plus 的「消息操作」更准。

## 按来源统计

- jira_polling：50 单，平均约 97.4。无其他来源样本。

## 按原始结论统计

- skip：31 单，平均约 99，错误率 0%。
- pass：15 单，平均约 94.1，错误率 6.7%（1/15，HIM-22875 应 fail）。
- fail：4 单，平均约 96.8，错误率 0%，且 reason 质量高。

## 典型案例

- 高质量案例：
  - HIM-22663（fail）：缺失项清单精准（actual 细节、AppKey、会话类型、现象+时间、附件类型/大小），正确标注附件/媒体为辅助场景，预期结果降级为建议——比 plus 同单的理由更规范。
  - HIM-22865（fail）：与 plus 一样识别出标题与描述矛盾，论证更完整。
  - HIM-22788（pass）：建议项写法标准（建议明确预期并给出示例写法）。
- 误判案例：
  - HIM-22875（pass，应为 fail）：必须项「触发路径」缺失被降级为建议项。
- 需要人工复核案例：无新增；HIM-16561「补 AppKey 明文」建议复核引导话术。

## Token 与成本观察

- 50 单合计：input 1,916,554 / cached 1,379,712 / output 77,853。
- 缓存命中率约 72%；平均每单 input 约 38.3k、output 约 1.6k。
- 与 plus 对比：input +7.8%，output +74%——max 的 reason/建议写得更长更细，这也是它建议项用得更好的代价；无重复读取等浪费。

## 与 qwen3.7-plus（10:47:27 批次）对比

| 维度 | qwen3.7-plus | qwen3.7-max |
|---|---|---|
| 平均分 | 96.9 | 97.4 |
| fail 数 | 5（含 22875，正确） | 4（漏 22875） |
| 主结论错误 | 0 | 1（22875） |
| reason 必须项膨胀 | 3 单（22663/22779/22875） | 0 |
| 建议项契约运用 | 一般 | 好 |
| QA 单内部一致性 | 有宽严不一 | 一致 |
| output token | 44,685 | 77,853（+74%） |

结论：两者都可用。**max 的理由规范性和一致性更好，plus 的 fail 把关更严**（抓住了 max 漏掉的 22875）。如果审查流程的底线是「不能放过信息不足的工单」，plus 本次表现更可靠；如果更看重反馈质量和可执行性，max 更好。可通过 skill 强化「场景 1 触发路径为必须项」来补齐 max 的短板。

## 改进建议

- 审查 skill：1) 在场景 1 强调「触发路径缺失 = fail，不得降级」；2) 明确脱敏占位符即已提供，不得要求提交人补明文 AppKey；3) 固化 QA 单「bug 内容为空 → fail」口径。
- 日志使用方式：无问题。
- 模型选择：见上方对比结论；成本敏感时 plus 的 output 更省。
- 后续评测：对两模型结论不一致的单（本批仅 22875）做重点人工复核。

## 无法评测清单

- 无。50 单全部解析成功，issueKey 一致，无重复。

## 逐工单评分附录（19 个 Bug 单；31 个 skip 单全部 good/约 99 分，理由符合契约，不逐一列出）

```json
[
  {"issueKey":"HIM-16561","originalReview":{"decision":"pass","classification":"Bug","scenario":"回调"},"evaluatorJudgement":{"decision":"pass","scenario":"回调","reason":"缺陷表现在服务端发送后回调缺字段，归回调场景成立；证据充分，pass 正确。但建议「补 AppKey 明文」错误——脱敏占位符按标准视为已提供。","requiredMissingItems":[],"nonBlockingSuggestions":["确认回调 JSON 中 version 4.4.1 是否为当前版本"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":19,"actionability":11,"scopeDiscipline":14,"outputContract":10,"total":89},"label":"good","problems":["要求补 AppKey 明文，违反脱敏占位符口径"],"improvementAdvice":"AppKey 脱敏占位符视为已提供，不要引导提交人补明文。"},
  {"issueKey":"HIM-17470","originalReview":{"decision":"pass","classification":"Bug","scenario":"崩溃/卡死"},"evaluatorJudgement":{"decision":"pass","scenario":"崩溃/卡死","reason":"数据库崩溃+附件证据齐全，scenario 归类比 plus 更准，机型/OS 作为建议项使用正确。","requiredMissingItems":[],"nonBlockingSuggestions":["机型/OS 版本"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-20780","originalReview":{"decision":"pass","classification":"Bug","scenario":"fallback"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"fallback 正确，AppKey 正确降级为建议项。","requiredMissingItems":[],"nonBlockingSuggestions":["AppKey"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-21953","originalReview":{"decision":"pass","classification":"Bug","scenario":"崩溃/卡死"},"evaluatorJudgement":{"decision":"pass","scenario":"崩溃/卡死","reason":"堆栈附件+触发路径+版本齐全，理由充分。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22543","originalReview":{"decision":"pass","classification":"Bug","scenario":"附件/媒体"},"evaluatorJudgement":{"decision":"pass","scenario":"附件/媒体","reason":"必须项齐全，预期可推断→pass+建议显式写出的契约用法标准。","requiredMissingItems":[],"nonBlockingSuggestions":["显式预期结果"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22663","originalReview":{"decision":"fail","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"fail","scenario":"消息收发","reason":"缺失项全部真实且全部为必须项（actual 细节、AppKey、会话类型、现象+时间、附件类型/大小），附件/媒体正确标注为辅助场景，预期降级为建议——本次评测中 fail reason 的标杆。","requiredMissingItems":["actual 错误详情","AppKey","会话类型","发生时间","附件类型/大小"],"nonBlockingSuggestions":["显式预期结果"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"fail reason 标杆，保持。"},
  {"issueKey":"HIM-22668","originalReview":{"decision":"pass","classification":"Bug","scenario":"fallback"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"同意 pass，建议项（终端、APP 名称）恰当。","requiredMissingItems":[],"nonBlockingSuggestions":["终端平台"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22762","originalReview":{"decision":"pass","classification":"Bug","scenario":"附件/媒体"},"evaluatorJudgement":{"decision":"pass","scenario":"附件/媒体","reason":"同意 pass；评论证据链完整，文件类型从评论推断（缩略图下载状态）有依据。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22779","originalReview":{"decision":"fail","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"fail","scenario":"消息收发","reason":"bug 内容为空+无步骤+无证据+QA 单无环境，fail 正确且理由干净（无建议项混入），与 22828 口径一致。","requiredMissingItems":["问题描述","复现步骤","证据","测试环境"],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"QA 单薄单口径正确，保持。"},
  {"issueKey":"HIM-22780","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"pass","scenario":"消息收发","reason":"bug 内容有具体双向现象（combine success vs type:text），与 22779/22828 的 fail 界限清晰，内部一致；建议项恰当。","requiredMissingItems":[],"nonBlockingSuggestions":["测试环境","消息ID/时间"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22788","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息操作"},"evaluatorJudgement":{"decision":"pass","scenario":"消息操作","reason":"同意 pass，建议给出预期示例写法，actionability 好。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":24,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":98},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22789","originalReview":{"decision":"pass","classification":"Bug","scenario":"控制台/计费"},"evaluatorJudgement":{"decision":"pass","scenario":"控制台/计费","reason":"同意 pass，建议（域名列表、失败接口名）具体可执行。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22811","originalReview":{"decision":"pass","classification":"Bug","scenario":"控制台/计费"},"evaluatorJudgement":{"decision":"pass","scenario":"控制台/计费","reason":"同意 pass，理由完整。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22826","originalReview":{"decision":"pass","classification":"Bug","scenario":"文档/demo"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"API 与文档不一致属 API 一致性缺陷，fallback 比文档/demo 贴切；pass 结论正确。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":21,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":94},"label":"good","problems":["scenario 归类（文档/demo）不够贴切"],"improvementAdvice":"文档/demo 场景用于文档本身的问题，API 实现与文档不一致归 fallback。"},
  {"issueKey":"HIM-22828","originalReview":{"decision":"fail","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"fail","scenario":"消息收发","reason":"bug 内容为空+无步骤+无证据+无环境，fail 正确，理由干净且与 22779 一致。","requiredMissingItems":["复现步骤","证据","测试环境"],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":96},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22859","originalReview":{"decision":"pass","classification":"Bug","scenario":"联系人/群组/聊天室/子区"},"evaluatorJudgement":{"decision":"pass","scenario":"联系人/群组/聊天室/子区","reason":"同意 pass，预期可推断→建议显式补充的契约用法正确。","requiredMissingItems":[],"nonBlockingSuggestions":["显式预期"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22865","originalReview":{"decision":"fail","classification":"Bug","scenario":"会话/多端同步"},"evaluatorJudgement":{"decision":"fail","scenario":"会话/多端同步","reason":"标题与描述矛盾+无预期+无证据，fail 正确，论证完整。","requiredMissingItems":["明确实际现象","显式预期","证据"],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22868","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"pass","scenario":"消息收发","reason":"同意 pass，建议项恰当。","requiredMissingItems":[],"nonBlockingSuggestions":["时间","消息ID"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22875","originalReview":{"decision":"pass","classification":"Bug","scenario":"崩溃/卡死"},"evaluatorJudgement":{"decision":"fail","scenario":"崩溃/卡死","reason":"工单仅「升级 4.24.0 后出现 ANR」，触发路径（场景 1 必须项）缺失；模型自己也列出该缺失却降级为建议项，违反「必须项缺失必须 fail」；AppKey 列建议项是对的。ANR 一词可推断 Android 平台，platform 不算硬缺。","requiredMissingItems":["触发路径/复现场景"],"nonBlockingSuggestions":["AppKey","Android 版本","APP 名称"]},"scores":{"decisionCorrectness":15,"reasonAccuracy":15,"actionability":12,"scopeDiscipline":13,"outputContract":10,"total":65},"label":"bad","problems":["主结论错误：必须项「触发路径」缺失被降级为建议项，应判 fail"],"improvementAdvice":"skill 中强调场景 1 触发路径为必须项；模型自检「reason 里列出的缺失项是否有必须项」。"}
]
```
