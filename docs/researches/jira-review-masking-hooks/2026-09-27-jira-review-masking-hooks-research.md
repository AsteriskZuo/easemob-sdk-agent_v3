# 工单审查场景：pi 前/后置 hook 脱敏与还原完整链路验证

- **调研日期**：2026-09-27
- **场景**：单轮审查工单——jira 拉取真实工单（HIM-23706）→ pi 前置 hook 脱敏 → LLM 审查 → 后置 hook 还原输出
- **基础**：pi hooks 调研（`docs/researches/pi-hooks/2026-09-26-pi-hooks-research.md`）已实证 `input` transform、`message_end` 替换等 hook 语义
- **实际使用模型**：**deepseek/deepseek-v4-pro**（`.easemob-agent/config.json` 的 `MODEL__*`，OpenAI 兼容端点 `https://api.deepseek.com`）——即真实外部 LLM，正是脱敏要保护的场景
- **隔离**：`PI_CODING_AGENT_DIR` 指向本目录 `tmp-agentdir/`；models.json 中 apiKey 用 `$DEEPSEEK_API_KEY` 环境变量插值；已校验本目录无任何凭据落盘；未触碰 `~/.pi/`
- **全部结论为真实跑通**，产物在 `results/`

## 一、结论先行

**链路完整跑通**：真实工单 → `input` hook 脱敏（transform）→ deepseek 只看到脱敏内容（8 个敏感原值 0 泄漏进 LLM 请求体，有请求体落盘证据）→ `message_end` hook 还原 → 最终输出 8/8 原值正确回填、0 残留 token。pi 的 hook 机制可以承担「信任边界处的强制变换」。

**最重要的发现不是 hook 不行，而是脱敏模块的字段契约不完整**：masking.ts 只脱敏白名单字段（summary/description/评论正文等），**附件的下载 URL（`attachments[].content`）不在契约内，内网域名 `j1.private.easemob.com` 原样进入了 deepseek 的请求体**（实测，`llm-payload.jsonl` 中 1 处）。hook 强制执行了变换，但变换本身的覆盖面需要单独审计。

## 二、链路各环节实测证据

### 2.1 环节总览（实测事件序列，`results/hooks.jsonl`）

```
extension_loaded
input_masked        issueKey=HIM-23706, originalBytes=7439, maskedBytes=7283,
                    kv={accounts:2, urls:5, ips:0, hosts:0, phones:0, appkeys:1}
message_end_restored  restoredBytes=2140, missingTokens=[]
```

### 2.2 前置 hook：`input` 事件脱敏 + transform

约定 `<<<ISSUE_JSON` 与 `>>>` 独占一行包裹工单 JSON。hook 提取 → `masking-with-kv.ts` 的 `createIssueMaskerWithKv()` 脱敏 → kv 落盘 `results/kv.json`、脱敏结果落盘 `results/masked.json` → 返回 `{action:"transform", text}`。

kv 实测内容（`results/kv.json`，8 个映射）：

```json
"accounts": {"[ACCOUNT_1]": "kongjialin@easemob.com", "[ACCOUNT_2]": "zuoyu@easemob.com"},
"urls": {"[URL_1]": "/common/ChatGroup.ts", "[URL_2]": "/src/emgroupmanager.cpp",
         "[URL_3]": "/src/emmucmanager.cpp", "[URL_4]": "/4.24/4.25",
         "[URL_5]": "/android/com_hyphenate_chat_adapter_EMAGroupSetting.cpp"},
"appkeys": {"[APPKEY_1]": "Cluster："}
```

### 2.3 证据①：LLM 上下文中无原始敏感值

两个独立证据（均为实测）：

1. **请求体落盘**：extension 的 `before_provider_request` hook 把每次发给 deepseek 的请求体落盘 `results/llm-payload.jsonl`。校验脚本对 kv 中全部 8 个原值逐一检查：**0 泄漏**（`[OK] LLM 请求体中 0 泄漏（共检查 8 个原值）`）；请求体中 `[ACCOUNT_1]` token 出现 8 次。
2. **事件流**：`results/stream.jsonl`（`--mode json`）中，role=user 的消息含 `[ACCOUNT_1]`/`[ACCOUNT_2]` 各 16 处、**0 处原始邮箱**；原始邮箱只出现在 `message_end`/`turn_end`/`agent_end`——即还原发生之后的下游事件。

唯一例外是附件 URL 的内网域名泄漏（见 2.5 与第四节），它不在 kv 里因为 masking 根本没处理该字段。

### 2.4 后置 hook：`message_end` 还原

hook 读 `results/kv.json`，对 assistant 消息的每个 text part 调 `restoreText()`（单次正则精确匹配完整 token 查表替换，天然规避 `[IP_1]` 吃掉 `[IP_10]` 的前缀误替换），返回 `{message}` 替换整条消息。

校验结果（实测）：

- `results/final.txt` 残留编号 token：**0**（grep `[(ACCOUNT|URL|IP|HOST|PHONE|APPKEY)_n]` 无命中）
- 回填命中：**8/8** 个原值出现在最终输出中
- `missingTokens: []`（无模型改写 token 导致无法还原的情况）

### 2.5 original → masked → LLM 输出 → restored 对照（实际片段）

工单为「【RN SDK 5.0.0 Android】【群配置】inviteNeedConfirm 设为 true 后返回字段缺失」。

**original**（`results/original.json`，结构化账号字段）：
```json
"reporter": {"name": "kongjialin", "displayName": "孔佳林", "emailAddress": "kongjialin@easemob.com"}
```

**masked**（`results/masked.json`，同一字段）：
```json
"reporter": {"name": "[ACCOUNT_1]", "displayName": "孔佳林", "emailAddress": "[ACCOUNT_1]"}
```

**LLM 输出（还原前，模型视角只有 token）**：模型在审查结论中明确把 token 当占位符引用——最终输出里有一节「占位 URL 标识：/common/ChatGroup.ts、/src/emgroupmanager.cpp……」（这些路径是还原回填的），说明模型原文写的是 `[URL_1]`、`[URL_2]` 等 token。

**restored**（`results/final.txt` 片段，即平台最终拿到的输出）：
```
## 2. 涉及的相关方
- 负责人/经办人：佐玉（zuoyu@easemob.com）
- 创建人/报告人：孔佳林（kongjialin@easemob.com）
……
- 初步定位代码点：src/common/ChatGroup.ts:317 对缺失值使用 ?? false
```

displayName（人名）按 masking 设计不脱敏；账号 token 回填为邮箱（见 3.2 的粒度说明）。

## 三、发现的问题与边界

按影响排序：

1. **【重要】masking 字段契约覆盖不全，hook 无法补救**：`attachments[].content`（附件下载 URL）不在 masking 的 `TEXT_FIELD_NAMES` 白名单内，内网域名 `j1.private.easemob.com` 经 masked.json 原样进入 deepseek 请求体（各 1 处，实测）。结论：**hook 解决了「强制执行」，没解决「变换规则对不对」**——脱敏模块的字段覆盖需要独立审计清单。
2. **账号别名归并导致还原粒度损失**：同一账号的 name/email/key 归并到同一 `[ACCOUNT_n]`，kv 只能给 token 一个回填值（dumpKv 取首个注册标识，通常是 email）。结构化字段里 `reporter.name=kongjialin` 还原后是邮箱而非用户名——语义等价但非原位还原。对「还原 LLM 结论文本」场景可接受；若要做「整单还原」则不够。
3. **分隔标记约定脆弱（首跑踩坑）**：指令文本中字面提到 `<<<ISSUE_JSON ... >>>`，导致 hook 提取到指令里的标记而非数据块（`input_parse_error`，action=continue 放行，**原始未脱敏内容直接发给了 LLM**）。修复为标记独占一行后通过。启示：① 解析失败必须 fail-closed（阻断或告警），不能静默放行——本 demo 的 `continue` 是错误示范，生产应 `handled` 阻断；② 更稳的方案是平台侧不经 prompt 文本传工单，而用 SDK 结构化注入，hook 只做变换。
4. **masking 误伤**：`[APPKEY_1]` 的原值是 `Cluster：`——中文描述文本被 appkey 赋值正则误捕。无害（还原回填原文），但说明正则类规则有固有噪音。
5. **LLM 改写 token 的风险本次未发生**（deepseek-v4-pro 原样引用），但不能依赖：若模型输出全角括号、改大小写、加空格，token 无法还原。缓解：指令要求「原样照抄」+ 校验步骤把残留 token 作为质量门禁（本链路已实现 grep 校验）。
6. **kv 作用域生命周期**：scope 是 masker 闭包内状态，进程重启即丢；且按 issueKey 隔离（FIFO 100 个）。本链路用「input hook 落盘 kv.json、message_end 读文件」传递，同进程其实可共享闭包，落盘的价值是可审计+跨 hook 解耦。多 issue 同 run 时 `flattenKv` 合并会丢 issue 维度，生产应按 issueKey 分别还原。
7. **message_end 每条 assistant 消息都触发**：多 turn 场景会反复还原并覆盖 `restored.txt`；本次单轮（`--no-tools`）无此问题。平台批量场景建议以 `agent_end`/`agent_settled` 取最终态。

## 四、对平台 hooks 设计的启示

1. **「hook 强制变换」路线可行且语义干净**：`input` 的 transform 与 `message_end` 的整条消息替换在真实外部 LLM 链路上实测可靠，变换对模型与平台两侧都透明。
2. **审计取证的最佳挂点是 `before_provider_request`**：直接落盘发给外部模型的请求体字节流，比从事件流推断更有证明力，建议纳入平台审计标配。
3. **fail-closed 必须显式设计**：hook 解析失败/异常时的默认行为要阻断而非放行（本任务首跑就是放行导致原始数据外发，虽然只是发给 LLM 但已违边界）。
4. **脱敏规则的字段覆盖需要独立于 hook 机制的审计**：建议平台维护「字段 × 是否脱敏」清单，附件 URL、自定义字段都要覆盖。
5. **kv 映射是平台资产**：需要持久化、按业务/issue 命名空间隔离、有 TTL；还原侧要处理「无映射 token 保留原样 + 告警」。
6. **校验闭环应成为输出门禁的一部分**：残留 token grep（还原完整性）+ 原值回扫请求体（泄漏检查）两个校验成本极低，建议固化到流水线。

## 五、复现

```bash
cd docs/researches/jira-review-masking-hooks
bash run-all.sh HIM-23706
```

脚本步骤：拉工单（`jira-tool.ts`）→ 构造 prompt → `pi -p --mode json --no-extensions -e extension/masking-hooks.ts`（deepseek）→ 提取最终输出 → 三项校验（残留 token / 请求体泄漏 / 回填命中）。产物与中间态全部在 `results/`。
