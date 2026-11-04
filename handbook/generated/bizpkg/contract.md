<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 业务包契约


## 契约的作用

> `bizpkg.contract.overview`

业务包通过 `contract.json` 向平台声明自己的输入输出契约。
平台在入口（check-input）与出口（check-output）各设一道机械校验闸门：
入口拦截缺少必填字段的非法事件，出口拦截不合约的处理结果，
使主程序 main 可以信任经闸门过滤后的数据形状。


_参见：`bizpkg.contract.input.issue-key`_


## 工单号

> `bizpkg.contract.input.issue-key`

**字段** `issue_key` · 类型 `string` · 必填


Jira 工单唯一标识，例如 `HIM-24058`。
check-input 会机械校验其存在性与类型，缺失或类型不符的事件在入口即被拒绝。


## 进程契约：一段 JSON 进，一段 JSON 出

> `bizpkg.contract.transport`

平台通过子进程运行程序，四条边界必须同时遵守：
1. stdin 接收一个完整 JSON 信封，EOF 表示输入结束；
2. stdout 只写唯一结果对象，Node/TypeScript 使用 `sdk.return(output)` 或 `sdk.fail(reason)`；
3. 任一步失败即本 run 失败，平台不自动重跑、不断点续跑；
4. 日志走 `sdk.log`，由 stderr 采集，不能污染 stdout。

`sdk.return` 与 `sdk.fail` 都会结束进程且只能生效一次。其他语言可以自行实现相同协议，但 Node/TypeScript 应优先使用 SDK。


_参见：`bizpkg.development.logging`、`bizpkg.operations.run-failure`_


## 事件信封：业务看到的统一输入

> `bizpkg.contract.envelope`

`sdk.input().event` 是统一事件信封，关键字段如下：
| 字段 | 含义 |
| --- | --- |
| `contract_version` | 当前恒为 `v1` |
| `source` / `event_type` | 来源与类别，用于入口匹配 |
| `event_id` | 执行实例标识，也是入口幂等键 |
| `session_id` | 源生会话标识，参与通道串行键 |
| `correlation_id` / `hop_count` | 派生链追溯与跳数控制 |
| `payload` | 入口数据；internal 事件中是上游 output 原样 |

`sdk.input()` 还提供本 run 的 `workspace`；check-output 额外获得主程序的 `output`。配置、安全变量、程序映射与持久目录分别在信封的 `config`、`secrets`、`programs`、`dataDir` 中，由对应 SDK API 读取。


_参见：`bizpkg.development.mock`、`bizpkg.development.state`_


## 三段编排：check-input → main → check-output

> `bizpkg.contract.pipeline`

一次 run 包含三个独立子进程，共用本次 `workspace`：
1. **check-input** 按 `contract.input` 检查原始事件；失败则主程序不执行。
2. **main** 完成取数、业务判断、模型调用和结果组装，产出 output。
3. **check-output** 按 `contract.output` 检查产出；失败则本 run 失败，结果不派生、不投递。

平台对 check 阶段做最小注入：没有 secrets、agent endpoint、programs 和 dataDir，固定 60 秒超时。主程序拥有完整业务上下文，默认可用控制台配置的运行策略。


_参见：`bizpkg.contract.check-discipline`、`bizpkg.operations.run-failure`_


## check 程序纪律：只校验，不处理业务

> `bizpkg.contract.check-discipline`

模板 check 薄壳调用 `loadContract` 与 `checkFields`，只检查 required 字段的**存在与类型**。check 不做数据转换、不拉取详情、不调用大模型、不写业务状态；原始信封如何解析仍由主程序负责。

v1 字段 `path` 使用点分路径，`type` 支持 `string`、`number`、`boolean`、`object`、`array` 与 `T[]`；`required` 缺省为 false，可选项只用于文档展示，不参与通用校验。
跨字段一致性、条件必填、值域或 `null` 的复杂语义，可以自写 check 逃生门，但仍须保持纯校验、无副作用。schema 表达能力升级走顶层 `version`，不要私扩 v1 词表。


_参见：`bizpkg.contract.null-semantics`_


## null 的两种位置，两种语义

> `bizpkg.contract.null-semantics`

**契约中的 `input: null`**：明确声明无输入约束，平台跳过 check-input；**契约中的 `output: null`**：明确声明业务无产出，check-output 仍执行，实际产出非空值会失败。两个键都不能省略，省略无法区分“忘了写”与“明确没有”。

**运行时的 `sdk.return(null)`**：本次没有通知内容，出口不投递；下游仍会收到派生事件且 `payload = null`，由下游自行验收。若业务同时存在“对象产出”和“null 跳过”两条合法路径，应在自写 check-output 中显式放行 null，再对非空对象检查字段。
不要用空字符串或空对象假装无产出。


_参见：`bizpkg.integration.entry-exit`_


## output 形状由下游与出口共同消费

> `bizpkg.contract.output-consumer`

主程序 output 有三个去向：check-output 校验、派生为 internal 事件的 payload、交给绑定的出口工具。它既是下游业务契约，也是出口工具输入，不是只给当前页面看的临时 JSON。

修改 output 前先核对 `contract.json`、下游 match 行的关注关系和所选出口的 resultDoc。控制台出口抽屉与 `GET /api/exit-tools` 提供当前工具的结果形状；通用 webhook 可接收任意 JSON，但企微、Jira 等出口有各自要求。


_参见：`bizpkg.integration.entry-exit`、`bizpkg.operations.run-failure`_
