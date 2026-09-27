# 工单审查 × 脱敏/还原 hooks 链路验证

验证「信任边界处的变换必须由 hook 强制执行」：jira 拉取真实工单 → pi 前置 hook（`input`）脱敏并落盘 kv → LLM 只见脱敏内容做审查 → 后置 hook（`message_end`）用 kv 还原最终输出。

报告：[`2026-09-27-jira-review-masking-hooks-research.md`](./2026-09-27-jira-review-masking-hooks-research.md)

## 文件

- `jira-tool.ts` — 独立 jira 拉取工具：`node jira-tool.ts <ISSUE-KEY>`，凭据运行时读 `.easemob-agent/config.json`（可用 `EASEMOB_CONFIG` 覆盖路径），输出 mapIssue 形态 JSON。
- `masking-with-kv.ts` — `docs/refs/jira/masking.ts` 的最小改动副本（改动处均有 `【调研改动】` 注释）：新增 `createIssueMaskerWithKv()`，额外返回 `dumpKv()` 导出 token→原值映射。
- `restore.ts` — 还原工具：库函数 `restoreText()` / `flattenKv()`，也可命令行 `node restore.ts <kv.json> < in.txt > out.txt`。单次正则精确匹配完整 token，无 `[IP_1]` 吃掉 `[IP_10]` 的前缀问题。
- `extension/masking-hooks.ts` — pi extension：`input`（脱敏+transform）、`before_provider_request`（LLM 请求体落盘取证）、`message_end`（还原 assistant 输出）。
- `run-all.sh` — 一键跑完整链路 + 校验（残留 token / LLM 请求体泄漏 / 回填命中）。
- `results/` — 实测产物（original/masked/kv/llm-payload/stream/final 等）。
- `tmp-agentdir/` — 隔离的 `PI_CODING_AGENT_DIR`，models.json 里 apiKey 用 `$DEEPSEEK_API_KEY` 环境插值，**无任何凭据落盘**。

## 运行

```bash
bash run-all.sh HIM-23706
```

前提：本机可达内网 jira；deepseek 凭据在 `.easemob-agent/config.json`；pi 路径见脚本顶部 `PI` 变量。模型走 config.json 的 deepseek（外部 LLM——正是脱敏要保护的场景），失败可改脚本退回本机 ollama。
