# 决策：工作区目录结构重构——五类生命周期 × 两种归属（平台/业务分根）

- **日期**：2026-10-12
- **状态**：已定（同日 owner 裁决）
- **背景**：旧布局按「五类生命周期」单轴分根（`config.json` / `data/` / `cache/` / `runs/` / `logs/`），business_id 落在路径第三层（如 `runs/{source}/{session_id}/{business_id}/{run_id}`）——业务的数据散落在五个树根下，**删除一个业务无法按业务整体清理**（得遍历五棵树按第三层摘）；且「业务级持久状态」（sdk.dataDir，T21 新增）这一类在旧五类划分中没有明确落点（挂在平台 `data/` 下，语义上是业务数据）。本决策把数据按「五类生命周期 × 两种归属」重组：平台一套、每个业务一套。

## 结论

1. **五类定义不变**（第一轴 =「删了会怎样」，互不重叠）：
   - **配置 config**：人写给平台的输入（env + config.json）——人工维护；
   - **数据 data**：持久状态，删了影响正确性或用户可感知；
   - **缓存 cache**：可随时重建，删了只是变慢/丢上下文，不丢正确性；
   - **临时 runs**：单次 run 的隔离工作区，TTL 清理；
   - **日志 logs**：排查追踪，轮转可删。
2. **第二轴 = 归属**：平台一套、每个业务一套；**空格子允许**（平台没有 runs，业务没有 config——业务配置由平台管理存 platform.db）。新布局：

```
{workspace}/
├── platform/                                  # ══ 平台 ══
│   ├── config.json                            # 配置
│   ├── data/platform.db                       # 数据：账号/业务/资产登记/队列/key-value/身份目录
│   ├── cache/assets/{asset_id}/               # 缓存：资产物化（git clone，可重拉）
│   └── logs/{system,entry-loop,exit-loop}.log # 日志：平台三日志
└── businesses/{business_id}/                  # ══ 每个业务 ══
    ├── data/{source}/{session_id}/            # 数据：业务持久状态（sdk.dataDir()，如去重记录）
    ├── cache/agent-sessions/{source}/{session_id}/   # 缓存：pi 会话上下文
    ├── runs/{source}/{session_id}/{run_id}/   # 临时：run 隔离工作区
    └── logs/{source}/{session_id}/{run_id}.log       # 日志：业务 run 日志
```

3. **收益**：删除一个业务 = db 删行 + `rm -rf businesses/{business_id}`；新增业务 = 多一个目录；五类运维操作（清缓存/日志轮转/runs TTL）按类统一。
4. **串行不变量不受影响**：同通道串行靠 channel_id 键（`{source, session_id, business_id}` 三元组）而非父目录，路径重排不改变「同通道串行 ⇒ 同目录无并发写」。
5. **sdk.dataDir() 语义不变**（业务级持久目录），只是平台注入的绝对路径变了；业务包代码零改动。
6. **数据重置口径**：除 `platform/config.json` 外，工作区其余内容可整体删除重置。

## 路径映射（旧 → 新）

| 旧 | 新 |
|----|----|
| `{workspace}/config.json` | `{workspace}/platform/config.json` |
| `{workspace}/data/platform.db` | `{workspace}/platform/data/platform.db` |
| `{workspace}/cache/assets/{asset_id}` | `{workspace}/platform/cache/assets/{asset_id}` |
| `{workspace}/logs/{system,entry-loop,exit-loop}.log` | `{workspace}/platform/logs/...` |
| `{workspace}/runs/{source}/{session_id}/{business_id}/{run_id}` | `{workspace}/businesses/{business_id}/runs/{source}/{session_id}/{run_id}` |
| `{workspace}/logs/businesses/{source}/{session_id}/{business_id}/{run_id}.log` | `{workspace}/businesses/{business_id}/logs/{source}/{session_id}/{run_id}.log` |
| `{workspace}/data/{source}/{session_id}/{business_id}`（sdk.dataDir） | `{workspace}/businesses/{business_id}/data/{source}/{session_id}` |
| `{workspace}/cache/agent-sessions/{source}/{session_id}/{business_id}` | `{workspace}/businesses/{business_id}/cache/agent-sessions/{source}/{session_id}` |

注意：旧版 `logs/businesses/...` 里的 `businesses` 段消失（业务日志直接在各业务根下）；旧 `cache/repos/`（仓库克隆）不单独保留落点，归并后业务侧如需可变工作仓库克隆再议（当前无消费者）。

## 影响面

- **业务包零改动**：sdk API 语义全同，只有平台注入的绝对路径变化；
- **测试期不做数据迁移**：工作区直接按新布局重建（数据可整体删除，见结论 6）；
- **console-design §6、logging.md、各 spec、README 同步回写**（本次一并完成）；历史 plans 文档不回写（历史记录保持原貌，进度文档末尾加指引备注）。
