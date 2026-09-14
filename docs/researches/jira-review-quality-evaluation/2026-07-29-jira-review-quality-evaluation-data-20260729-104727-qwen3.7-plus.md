# Jira 工单审查质量评测报告

- 日志目录：`logs/data-2026-07-29 10 47 27`
- 审查模型：qwen3.7-plus
- 审查标准：按日志实际加载标准评测（jira-ticket-review v1.1.0，hash 7232e8cd，摘自 `loaded-review-skill-7232e8cd.md`）
- 摘录副本：`/private/tmp/jira-review-quality-extract/2026-07-29-104727/`（评测仅基于副本完成，未回读原始日志）

## 总体结论

- 样本 50 单，全部可解析、可评分，无法评测评测清单为空。
- 原始结论分布：skip 31 / pass 14 / fail 5；来源全部为 jira_polling。
- 平均分约 96.9；good 49 / acceptable_with_issues 1 / bad 0 / needs_human_review 0。
- 总体判断：**当前审查模型值得继续使用**。31 个非 Bug 单 skip 全部正确且理由符合契约；19 个 Bug 单的主结论（pass/fail）经独立复核全部可辩护，无确定误判。

## 关键发现

- 最严重的问题：无明显主结论错误。最接近问题的是 **HIM-22779**（fail）的 reason 把场景 3 的建议项（消息ID、收发双方）当作必须项列出。
- 最常见的小瑕疵：**fail reason 中必须项/建议项边界偶有膨胀**——HIM-22875 把 AppKey、机型/系统版本列为必须项（场景 1 必须项只有崩溃堆栈+触发路径，机型/OS 是建议项，AppKey 不在场景 1 要求中；不过该单 sdkPlatform 公共底座项确实缺失，fail 结论仍成立）；HIM-22663 把「是否必现」「发送接口」列为必须项（场景表未要求），但 AppKey/会话类型/actual 细节等核心缺失项真实，结论正确。
- 一致性疑似问题（建议人工复核口径，不算误判）：QA 薄弱单的处理宽严不一——HIM-22780（只有发送端/下行两行现象，无环境信息）判 pass，而信息量相近的 HIM-22779、HIM-22828 判 fail。三个结论各自都可辩护（22780 现象更具体、双向对照清晰），但 QA 单「无环境信息是否 fail」的口径不统一。
- 最有价值的改进点：在 skill 中明确「QA 测试单缺环境信息」和「建议项不得写入 fail 必须项清单」两条口径。

## 按来源统计

- jira_polling：50 单，平均分约 96.9。无其他来源样本，无法比较。

## 按原始结论统计

- skip：31 单，平均约 99，错误率 0%。
- pass：14 单，平均约 94.6，错误率 0%（独立复核均同意 pass）。
- fail：5 单，平均约 89.6，错误率 0%（结论均同意，2 单 reason 有必须项膨胀）。

## 典型案例

- 高质量案例：
  - HIM-21953（pass/崩溃卡死）：崩溃附件、触发路径、版本齐全，并正确把 AppKey 降级为建议项，口径标准。
  - HIM-22543（pass/附件媒体）：三个现象同根因，正确未误判为问题聚合。
  - HIM-22865（fail/会话同步）：识别出标题「未生效」与描述「重新登陆没有未读消息」之间的实质矛盾，判 fail 要求澄清，判断精准。
- 可改进案例：
  - HIM-22779（fail）：结论可辩护，但 reason 混入建议项。
  - HIM-22875（fail）：结论正确，但必须项清单膨胀。
- 需要人工复核案例：无强制复核单；HIM-22780 vs HIM-22779/22828 的 QA 宽严口径建议人工确认一次后固化进 skill。

## Token 与成本观察

- 50 单合计：input 1,777,245 / cached 1,390,592 / output 44,685。
- 缓存命中率约 78%，平均每单 input 约 35.5k、output 约 894，输出很克制，无冗余长文。
- 未发现重复读取或异常放大；skip 单与 Bug 单共用同一 prompt 骨架，缓存效果好。

## 改进建议

- 审查 skill：1) 明确 fail reason 只列必须项，建议项放 summary；2) 明确 QA 单无环境信息的处理口径；3) 场景 1 崩溃类明确 AppKey 非常规必须项。
- 日志使用方式：无问题，info 级字段齐全（prefetch/review.result/usage 均可提取）。
- 模型选择：qwen3.7-plus 在该任务上质量已达标，output token 克制，成本效率好。
- 后续评测：可对 fail 单做「必须项合法性」专项抽查。

## 无法评测清单

- 无。50 单全部解析成功（文件名/工单/输出 issueKey 一致，无重复 key）。

## 逐工单评分附录（19 个 Bug 单；31 个 skip 单全部为 good/约 99 分，理由均为「非 Bug 工单（<issueType>），不在审查范围」，符合契约，不逐一列出）

```json
[
  {"issueKey":"HIM-16561","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息操作"},"evaluatorJudgement":{"decision":"pass","scenario":"消息操作","reason":"channel ack 属已读类消息操作，回调结构体对比证据充分，AppKey 在 JSON 中（脱敏占位符），预期可推断。建议项：Web SDK 版本未给。","requiredMissingItems":[],"nonBlockingSuggestions":["补充 Web SDK 版本"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":22,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":95},"label":"good","problems":[],"improvementAdvice":"保持。","usage":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0}},
  {"issueKey":"HIM-17470","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息操作"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"本地 DB 查询返回异常数据+数据库崩溃日志，证据附件齐全，版本（脱敏）/平台（Java API 可推断 Android）具备。scenario 标为消息操作不太贴切，fallback 或崩溃/卡死更准，但无后果。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":21,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":94},"label":"good","problems":["scenario 归类不贴切（消息操作 vs fallback/崩溃）"],"improvementAdvice":"本地数据异常类问题归 fallback 更稳。"},
  {"issueKey":"HIM-20780","originalReview":{"decision":"pass","classification":"Bug","scenario":"fallback"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"loadMessages 无回调属 API 异步回调问题，归不进场景表，查公共底座：描述/实际/预期（正常应回调未登录）/iOS 1.3.2-beta1 齐全，日志附件存在。fallback 处理正确。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":22,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":95},"label":"good","problems":[],"improvementAdvice":"fallback 口径运用正确，保持。"},
  {"issueKey":"HIM-21953","originalReview":{"decision":"pass","classification":"Bug","scenario":"崩溃/卡死"},"evaluatorJudgement":{"decision":"pass","scenario":"崩溃/卡死","reason":"ips 崩溃附件+触发路径（avatar nil）+iOS 4.17.1.3 齐全；AppKey 正确作为建议项而非必须项。","requiredMissingItems":[],"nonBlockingSuggestions":["补充 AppKey"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"标杆案例。"},
  {"issueKey":"HIM-22543","originalReview":{"decision":"pass","classification":"Bug","scenario":"附件/媒体"},"evaluatorJudgement":{"decision":"pass","scenario":"附件/媒体","reason":"AppKey/集群/flutter 4.19.1/双端/文件类型大小/三类报错现象齐全，附件证据存在；三现象同根因（displayname 处理），正确未误判聚合拆单。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":22,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":96},"label":"good","problems":[],"improvementAdvice":"聚合口径处理正确。"},
  {"issueKey":"HIM-22663","originalReview":{"decision":"fail","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"fail","scenario":"消息收发","reason":"AppKey、会话类型、actual 细节（无错误码/回调/日志）、附件类型大小均缺，fail 正确。但「是否必现」「发送接口」不是场景表必须项，列入必须项清单属轻微膨胀。","requiredMissingItems":["AppKey","会话类型","actual 错误详情","附件类型/大小"],"nonBlockingSuggestions":["是否必现","发送接口","RN 版本"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":21,"actionability":14,"scopeDiscipline":14,"outputContract":10,"total":94},"label":"good","problems":["必须项清单混入非必须项（是否必现/发送接口）"],"improvementAdvice":"fail reason 只列场景表必须项，其余放建议。"},
  {"issueKey":"HIM-22668","originalReview":{"decision":"pass","classification":"Bug","scenario":"fallback"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"AppKey/4.23.0/日志片段/附件齐全，操作+现象+预期（应缓存）明确。","requiredMissingItems":[],"nonBlockingSuggestions":["补充端平台信息"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":22,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":95},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22762","originalReview":{"decision":"pass","classification":"Bug","scenario":"附件/媒体"},"evaluatorJudgement":{"decision":"pass","scenario":"附件/媒体","reason":"私有化客户单，现象（杀进程后状态卡下载中）+消息 ID+日志截图附件+评论完整根因链，文件类型/大小与该状态机问题无关，不强求正确。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":21,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":94},"label":"good","problems":[],"improvementAdvice":"「不强求无关信息」口径运用正确。"},
  {"issueKey":"HIM-22779","originalReview":{"decision":"fail","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"fail","scenario":"消息收发","reason":"QA 单，himBugContent 空、仅 summary 一句话+错误信息，无环境/无步骤/无证据，fail 可辩护。但 reason 把消息ID、收发双方（场景 3 建议项）列为必须项，且与 HIM-22780 的 pass 宽严不一。","requiredMissingItems":["测试环境/集群","复现步骤","证据"],"nonBlockingSuggestions":["消息ID","收发双方","精确版本"]},"scores":{"decisionCorrectness":30,"reasonAccuracy":18,"actionability":12,"scopeDiscipline":14,"outputContract":10,"total":84},"label":"acceptable_with_issues","problems":["建议项混入必须项清单","与 HIM-22780 的 QA 单宽严口径不一致"],"improvementAdvice":"明确 QA 单薄单的 fail 门槛：以「无环境+无步骤+无证据」为准，不以建议项凑数。"},
  {"issueKey":"HIM-22780","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"pass","scenario":"消息收发","reason":"QA 单，发送端 combine success vs 下行 type:text 双向对照具体，会话类型/消息类型/现象/版本明确，预期可推断；环境缺失但 QA 单可内部确认，pass 可辩护。","requiredMissingItems":[],"nonBlockingSuggestions":["补充测试环境","补充发生时间"]},"scores":{"decisionCorrectness":32,"reasonAccuracy":20,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":90},"label":"good","problems":["与 22779/22828 fail 之间存在宽严不一致（疑似问题，非误判）"],"improvementAdvice":"同 22779，固化 QA 单口径。"},
  {"issueKey":"HIM-22788","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息操作"},"evaluatorJudgement":{"decision":"pass","scenario":"消息操作","reason":"版本/必现/双方操作步骤/量化现象（2 条变 6 条）齐全，教科书级工单，pass 正确。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":24,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":98},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22789","originalReview":{"decision":"pass","classification":"Bug","scenario":"控制台/计费"},"evaluatorJudgement":{"decision":"pass","scenario":"控制台/计费","reason":"私有化部署环境身份明确，问题/预期显式，截图证据，评论有根因。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22811","originalReview":{"decision":"pass","classification":"Bug","scenario":"控制台/计费"},"evaluatorJudgement":{"decision":"pass","scenario":"控制台/计费","reason":"AppKey/imm 地址/操作路径/报错/预期齐全。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22826","originalReview":{"decision":"pass","classification":"Bug","scenario":"fallback"},"evaluatorJudgement":{"decision":"pass","scenario":"fallback","reason":"API 一致性缺陷，现象/版本/复现（javap）/文档依据齐全，预期明确（应移除）。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":22,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":95},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22828","originalReview":{"decision":"fail","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"fail","scenario":"消息收发","reason":"仅 summary 一句话，无环境/无步骤/无证据/无消息体示例，fail 可辩护且与 22779 口径一致；但与 22780 pass 存在轻微不一致。","requiredMissingItems":["测试环境","复现步骤/API","params 字段证据"],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":31,"reasonAccuracy":20,"actionability":12,"scopeDiscipline":14,"outputContract":10,"total":87},"label":"good","problems":["与 22780 宽严不一致（疑似）"],"improvementAdvice":"同 22779。"},
  {"issueKey":"HIM-22859","originalReview":{"decision":"pass","classification":"Bug","scenario":"联系人/群组/聊天室/子区"},"evaluatorJudgement":{"decision":"pass","scenario":"联系人/群组/聊天室/子区","reason":"AppKey/ngi 环境/完整 curl/405 现象齐全。","requiredMissingItems":[],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":35,"reasonAccuracy":23,"actionability":14,"scopeDiscipline":15,"outputContract":10,"total":97},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22865","originalReview":{"decision":"fail","classification":"Bug","scenario":"会话/多端同步"},"evaluatorJudgement":{"decision":"fail","scenario":"会话/多端同步","reason":"标题「未生效」与描述「重新登陆没有未读消息」实质矛盾，无法无歧义判断差异，且无证据；fail 要求澄清完全正确，理由精准命中。","requiredMissingItems":["明确的实际现象（消息丢失还是未读未清）","显式预期","证据"],"nonBlockingSuggestions":[]},"scores":{"decisionCorrectness":34,"reasonAccuracy":22,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":94},"label":"good","problems":[],"improvementAdvice":"矛盾识别是亮点，保持。"},
  {"issueKey":"HIM-22868","originalReview":{"decision":"pass","classification":"Bug","scenario":"消息收发"},"evaluatorJudgement":{"decision":"pass","scenario":"消息收发","reason":"AppKey/聊天室/合并消息/title+summary 空现象齐全，预期可推断，建议项处理正确。","requiredMissingItems":[],"nonBlockingSuggestions":["SDK 版本","消息ID/时间"]},"scores":{"decisionCorrectness":35,"reasonAccuracy":22,"actionability":13,"scopeDiscipline":15,"outputContract":10,"total":95},"label":"good","problems":[],"improvementAdvice":"保持。"},
  {"issueKey":"HIM-22875","originalReview":{"decision":"fail","classification":"Bug","scenario":"崩溃/卡死"},"evaluatorJudgement":{"decision":"fail","scenario":"崩溃/卡死","reason":"触发路径（必须项）与 sdkPlatform（公共底座）确实缺失，fail 正确；但 AppKey 不是场景 1 必须项、机型/OS 是建议项，列为必须项属膨胀；附件日志存在，堆栈证据可算有。","requiredMissingItems":["触发路径/复现条件","sdkPlatform"],"nonBlockingSuggestions":["AppKey","机型/OS 版本","复现率"]},"scores":{"decisionCorrectness":33,"reasonAccuracy":17,"actionability":13,"scopeDiscipline":14,"outputContract":10,"total":87},"label":"good","problems":["AppKey/机型 OS 误列为必须项"],"improvementAdvice":"场景 1 必须项只有堆栈+触发路径；客户身份类信息放建议项。"}
]
```
