<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->


# 业务包 · 开发循环


## 开发循环：从模板到六条检查

> `bizpkg.development.overview`

推荐顺序是：**先写契约，再写主流程，最后补入口/出口绑定**。开发环境使用 Node.js ≥ 24，包是标准 ESM npm 工程，`@asteriskzuo/agent-sdk` 是普通依赖，不由平台隐式注入。
拷贝模板后修改包名、清单与契约，执行 `npm install` 生成本业务自己的 lockfile。不要提交模板示例中的 `your-skill` 等占位依赖，按真实引用调整。


_参见：`bizpkg.layout.overview`、`bizpkg.development.checks`_


## 快速开始

> `bizpkg.development.quickstart`

```bash
cp -R <平台仓>/templates/agent-package my-package
cd my-package
# 修改 package.json、agent-package.json 的 name
npm install
# 编辑 contract.json、apps/、packages/ 与 tests/
npm run build
npm test
npm run typecheck
npm run lint
npm run format:check
npm run circular
```
首次 `npm install` 后必须提交 `package-lock.json`，平台物化使用 `npm ci`。npm 包不可用时，可在本地临时将 SDK 改为 `file:<平台仓>/packages/sdk`，正式发布前再恢复并锁定已发布版本。


_参见：`bizpkg.development.checks`、`bizpkg.integration.materialization`_


## 六条本地检查

> `bizpkg.development.checks`

| 命令 | 保障 |
| --- | --- |
| `npm run build` | 生成与物化一致的 `dist/` |
| `npm test` | 业务规则和 SDK 边界行为 |
| `npm run typecheck` | TypeScript 类型正确 |
| `npm run lint` | 代码规范及 apps 隔离规则 |
| `npm run format:check` | 格式稳定 |
| `npm run circular` | apps/packages 无循环依赖 |

六条全绿是提交业务仓库前的最低线。测试若自行写 `dist`/`dist-test`，应以模板脚本为准，不要把构建产物当成源码提交。


_参见：`bizpkg.development.testing`_


## mock 信封：本地直接运行程序

> `bizpkg.development.mock`

程序输入只是 stdin JSON，因此无需启动整个平台即可验证：
```bash
mkdir -p /tmp/agent-demo/run /tmp/agent-demo/data
node dist/apps/main/index.js <<'JSON'
{
  "contract_version": "v1",
  "input": {
    "source": "webhook",
    "event_id": "evt_test",
    "event_type": "demo",
    "timestamp": "2026-11-04T10:00:00+08:00",
    "session_id": "PRJ-123",
    "correlation_id": "evt_test",
    "hop_count": 0,
    "payload": { "issue_key": "PRJ-123" }
  },
  "workspace": "/tmp/agent-demo/run",
  "config": {},
  "secrets": {},
  "programs": {},
  "dataDir": "/tmp/agent-demo/data"
}
JSON
```
按真实契约替换 payload。调试 check-output 时在信封顶层增加 `"output": ...`。mock 中只填代码实际读取的凭据，不要把生产 token 写进测试文件或 shell 历史。


_参见：`bizpkg.contract.envelope`、`bizpkg.development.independent-boundary`_


## 测试策略：流程与 SDK 边界解耦

> `bizpkg.development.testing`

推荐把流程写成接收依赖的函数，测试注入 `run`、`agent`、`models`、`config`、`secret`、`log` 等替身；app 入口只负责把真实 SDK 方法注入并映射 `sdk.return`/`sdk.fail`。这样无需真实 Jira、企微或大模型，就能覆盖分支、异常与状态写入。

当前参考业务把结果表达为 `FlowOutcome`，由 `apps/main/index.ts` 统一映射出口。至少覆盖：合法输入、缺字段、外部工具失败、模型非法输出、无产出、持久记录读写和重试边界。
check 的通用能力由 SDK 自测保障；业务自写逃生门仍需为复杂校验补测试。


_参见：`bizpkg.layout.programs`、`bizpkg.development.agent`_


## workspace 与 dataDir：临时和持久不要混用

> `bizpkg.development.state`

`sdk.input().workspace` 是每 run 独占的临时目录，也是进程 cwd；`sdk.dataDir()` 用于跨 run 的去重记录、游标和进度，平台不做 TTL，业务自行管理容量和清理。
runs 的“临时”目前只是数据分类，**当前没有自动 TTL 清理调度**。dataDir 按业务与通道隔离；同通道 run 串行，因此同一状态文件通常无需跨进程锁。不同通道不能假定共享状态或串行。

子程序默认拿不到 dataDir，确需持久化时由流程程序显式传路径。业务进程环境变量被清空，配置和凭据分别走 `sdk.config()`、`sdk.secret(name)`，不要依赖 `process.env`。


_参见：`bizpkg.operations.business-dedup`、`platform.operations.file-retention`_


## 调用工具：凭据由主流程显式传递

> `bizpkg.development.tools`

```ts
const ticket = await sdk.run("jira-fetch", {
  input: { issue_key: "PRJ-123" },
  config: {
    jira_url: sdk.config().jira_url,
    username: sdk.secret("jira_username"),
    password: sdk.secret("jira_password"),
  },
});
```
`sdk.run` 的可调范围是本包 programs 与已绑定工具 programs 的并集，按名查表，不能写物理路径。子程序只收到 input、config 和 workspace，不能读 secrets、调大模型、再按名调用其他程序或直接使用 dataDir。
子程序默认 5 分钟超时，可用 `timeout_ms` 覆盖；失败会 reject，由主流程决定失败或兜底。


_参见：`bizpkg.layout.requires`、`bizpkg.development.agent`_


## 调用大模型：模型、会话与配额

> `bizpkg.development.agent`

`sdk.agent({ skills, input, mode, model })` 只允许引用本业务已绑定 skill。`mode: "channel"` 沿用当前通道会话，适合多轮交互；`mode: "fresh"` 创建独立上下文，适合单轮审查和模型链式重试。
`sdk.models()` 返回当前生效的 provider/model 枚举，不含凭据；主流程可以自行实现换模型重试，但每次 `sdk.agent` 不论成败都计一次配额，控制台 `max_agent_calls` 必须覆盖最长调用链。

模型输入脱敏、输出解析和最终采纳规则属于业务代码。原始输出和每次失败原因应留日志，避免模型异常时只剩一句“解析失败”。


_参见：`bizpkg.development.testing`、`bizpkg.operations.run-failure`_


## 日志：为排错保留关键节点

> `bizpkg.development.logging`

使用 `sdk.log(level, message, fields)`，不要 `console.log`。至少在入口标识、外部取数、业务跳过、模型原始输出、模型尝试、状态写入与结果组装处留痕；字段优先放 issue key、event id、model、decision 等可检索值。
平台对 SDK 日志中的 secrets 做源头脱敏，但业务仍不应主动拼接完整凭据或大段敏感正文。stdout 只保留结果对象。


_参见：`bizpkg.operations.logs`、`bizpkg.contract.transport`_


## 独立验证的当前边界

> `bizpkg.development.independent-boundary`

当前已可独立完成：六条静态/单元检查、mock 信封运行 check/main、用测试替身覆盖 agent 边界，以及在 mock `programs` 中提供绝对路径后运行外部工具。
当前不能直接假设“拷贝 dist 就等价于完整平台”：`sdk.agent` 和 session 需要 agent endpoint 与已绑定 skill，外部工具需要 programs 映射，配置和 secrets 需要调用方提供。

**随包携带资产解析表、脱离平台完成全链路独立验证仍是后续工作。** 现阶段不要把这一设计目标写成已交付能力；优先用依赖注入测试证明业务逻辑，再到平台做真实冒烟。


_参见：`bizpkg.layout.runtime-deps`、`bizpkg.integration.smoke`_
