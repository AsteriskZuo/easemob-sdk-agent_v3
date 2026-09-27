# codex-cli 工单审查 + 脱敏/还原链路调研（中止）

- **日期**：2026-09-27
- **状态**：**中止**（用户决策）。链路框架已搭好并部分跑通，卡在泄漏审计无法闭环。
- **对照组**：pi 版同场景链路，一次跑通（约 10 分钟），见 `../2026-09-27-jira-review-masking-hooks-research.md`。
- **选型结论**：**agent 内核选 pi**。codex-cli 在本场景的落地成本显著高于 pi（本实验约 41 分钟未完成 vs pi 约 10 分钟跑通），且存在架构性短板（见下）。

## 链路设计（按 codex hook 语义调整，与 pi 版架构不同）

codex 没有「改写用户输入」的 hook（`UserPromptSubmit` 只能阻断），脱敏只能挂在工具结果上：

```
平台拉工单 → prompt 只携带文件路径（不含原文）
→ LLM 用 shell cat 读取 original.json
→ PostToolUse hook 拦截工具结果：脱敏 + kv 落盘 + 替换模型可见内容
→ 模型只见脱敏内容，输出含 [ACCOUNT_n] 等 token 的审查结论
→ codex exec 结束后平台侧用 restore.ts + kv.json 还原
（codex 的 Stop hook 不能改写最终文本，还原必须在平台侧做）
```

## 已完成（现场保留，可复跑）

- `codex-run-all.sh`：可重复执行（覆盖式产物 + 跑前清理 + ISSUE_KEY 参数化）；deepseek 经 codeproxy 桥接为 Responses API（codex 0.154 已移除 `wire_api="chat"`，同 `docs/researches/codex-cli/2026-07-15-codex-cli-deepseek-provider-research.md` 结论）。
- `hooks/mask_tool_output.mjs`：PreToolUse 路径白名单（只允许 `cat <绝对路径>` 整文件读取，grep/head/python 切片等一律 deny）+ PostToolUse 脱敏替换 + first-mask-wins（hook 每次新进程，token 编号靠落盘复用保持一致）+ 全程 fail-closed。
- hook 实测生效（`results/hooks.jsonl`）：`posttool_masked` → 后续读取 `posttool_reuse_masked` 复用脱敏结果；异常来源 `posttool_unexpected_source_blocked` 正确拦截。
- 配置坑已解决并写入脚本注释：`tool_output_token_limit` 默认会截断超长工具输出破坏 JSON 完整性，需放宽。

## 卡点：泄漏审计无法闭环（中止的直接原因）

校验发现 8 个脱敏前原值出现在审计语料（rollout + `--json` stream）中，反复调试未解决。遗留的开放问题：**codex 的 transcript 和 `--json` 事件流会记录工具的真实输出，即使 PostToolUse 已替换模型可见内容**——因此审计语料里出现原值，无法区分是「模型真的看到了原文」还是「仅仅是 transcript 留档」。pi 有 `before_provider_request` 能直接落盘真实 LLM 请求体做边界审计（pi 版实测 0 泄漏）；codex 没有等价挂点，「0 泄漏」的证明在 codex 上无法闭环。对一个以「敏感内容不出边界」为核心保证的平台，这是架构性短板。

## 结论

- pi 在本场景一刀到位：`input` transform 脱敏（内容进 LLM 前）、`message_end` 改写还原（输出离开前）、`before_provider_request` 审计（请求体级别）。三个挂点恰好对应链路三段。
- codex 三个挂点都要绕路：脱敏挂工具结果（且需 PreToolUse 白名单防切片绕过）、还原只能平台侧做、审计无请求体挂点。
- 叠加 codex 调研已知的坑（无头未信任 hook 静默跳过、resume 场景 hook 不齐全、fail-open 语义），选型确定为 **pi**。codex-cli 不再作为候选内核跟进。

## 现场索引

| 路径 | 内容 |
|---|---|
| `codex/codex-run-all.sh` | 可复跑的链路脚本（含全部配置坑的注释） |
| `codex/hooks/mask_tool_output.mjs` | 脱敏 hook（头部注释记录了迭代踩坑） |
| `codex/results/` | 最后一轮的实测产物（hooks.jsonl/stream/kv/masked 等） |
| `codex/tmp-codex-home/` | 隔离的 CODEX_HOME（含 rollout transcript，审计语料） |
