# 交接文档：webhook 契约化改造（波次 2 收尾）

> 写于 2026-11-03。面向接续工作的 AI/开发者：读完本文 + 「开发依据」两文档即可继续，无需翻历史会话。

## 一句话现状

平台侧（T5b）已完成并提交；业务仓迁移（T5d）代码完成、本地验证全绿，**但卡在 `@asteriskzuo/agent-sdk` 0.4.0 尚未发布到 npm**（`npm whoami` 返回 401，未登录）。下一步：用户登录 npm → 发版 SDK 0.4.0 → 业务仓重生成 lock 复测 → 提交业务仓 → 向用户请示 push/控制台重钉/T4 冒烟。

## 背景与目标

平台要真实接入上游 webhook（替代测试用的 `AGENT_ENTRY_JIRA_POLLING_ENABLED` polling 开关）。讨论中确立核心改造：**业务包契约化**——每个业务包必须有入口检查（check-input）与出口校验（check-output），平台统一定义规则并自动调用，业务包负责实现；契约（contract.json）声明输入/输出格式，控制台可查看。工单审查业务包（`business/jira-ticket-review/`）即模板项目，后续业务包照此模式实现。

## 开发依据（必读，按序）

1. `docs/decisions/2026-11-02-webhook-ingress-decisions.md` —— **D1–D8 全部决策与任务拆分（T1–T6）**，唯一权威依据。
2. `docs/designs/2026-11-02-business-io-contract.md` —— 契约设计细节（contract.json 词表、三段程序、逃生门等）。
3. 本仓 `AGENTS.md` —— 工程纪律（中文文档、单次提交、dailylog、重大变更先确认等）。
4. 参考 spec：`docs/specs/2026-09-29-t10-workflow-runner-sdk-spec.md`、`docs/specs/2026-09-29-t15-package-template-spec.md`（T5a/T5b 已按新版契约改过其中相关章节）。

## 两个仓库

| 仓库 | 路径 | 说明 |
|---|---|---|
| 平台主仓 | `/Users/asterisk/Codes/ai/easemob-sdk-agent_v3` | yarn 4 monorepo；根级六连：`yarn build` / `yarn test` / `yarn typecheck` / `yarn lint` / `yarn format:check` / `yarn circular` |
| 业务仓（模板项目） | `business/jira-ticket-review/`（独立 git，远端 `git@github.com:AsteriskZuo/jira-ticket-review.git`） | 测试：`cd business/jira-ticket-review/package && npm test` |

## 进度总览

- **T1–T3、T5a、T5b：已完成并提交**（平台仓 HEAD `72ead53`，工作区干净）。
- **T5d 业务迁移：代码完成、本地验证全绿、未提交**（见下「业务仓待提交内容」）。
- **T5c（波次 3，控制台联动）：未开始**。
- **T4（真实冒烟，D6 手工项）：未开始**，需用户操作。
- **T6（波次 4，文档修正）：未开始**。

平台仓未 push 的 5 个 commit（push 授权未获，勿擅自 push）：
`3a6bc25`、`c5c3d41`、`d49ebb1`、`9d2afc4`、`72ead53`。

## 下一步操作手册（按序执行）

1. **确认 npm 登录**：`npm whoami`。若仍 401 → 停下来请用户 `npm login`（registry.npmjs.org），不要继续第 2 步。
2. **发版 SDK 0.4.0**：先读 `packages/sdk/package.json` 确认 `publishConfig`（scoped 包 @asteriskzuo 可能需 `--access public`，0.1.0–0.3.0 已在 registry，照以往方式）；然后 `cd packages/sdk && npm publish`。
3. **业务仓重生成 lock**：`cd business/jira-ticket-review/package && npm install`（会同时替换掉本地软链，见「坑 1」）。
4. **业务仓复测**：`npm test`（预期 89/89）+ typecheck / lint / format:check / circular 全绿。
5. **提交业务仓**：`git add -A && git commit`，提交信息风格照平台仓：
   `feat: T5d 契约化迁移——apps/packages 布局 + contract.json + check 程序（D7/D8）`。
   同时按 AGENTS.md 在 `dailylog/AsteriskZuo/2026-11-03.md` 追加条目（格式 `- HH:MM …，原因：…`，平台仓日志随平台仓提交）。
6. **向用户请示后再做**（不要默认代做）：
   - push 两个仓库；
   - 控制台资产重钉（业务仓当前 pin 在旧 commit `3a131509`；重钉=低峰操作、接受 in-flight 小概率失败，见 D8-Q11）；
   - T4 冒烟：控制台加 webhook match 行、把平台 webhook 注册进上游服务、`AGENT_ENTRY_JIRA_POLLING_ENABLED` 改 false，真实验证。
7. **之后开波次 3（T5c，需用户点头）**：console-api 资产详情 API 携带 contract、Console 侧 ContractDrawer 抽屉展示、绑定闸、run 详情 `failed_at` 徽标（范围 packages/console-api、app/console）。
8. **波次 4（T6）**：把设计文档附录 A 的「条件必填」措辞修正为已实现语义（空产出放行、非空校验的逃生门），保持文档与代码一致。

## 业务仓待提交内容（T5d）

- 布局迁移（git mv 已 staged，保历史）：`package/src/` → `apps/{main,check-input,check-output}/` + `packages/`。
- 新增：`contract.json`、`apps/check-input/`、`apps/check-output/`、`tests/check-input.test.ts`、`tests/check-output.test.ts`（8 例）。
- 修改：`agent-package.json`、`agent.materialize.mjs`、`tsconfig.json`、`eslint.config.js`、全部测试 import、`person-mapping.ts` 的 `defaultMappingPath` 改上溯两级。
- 契约要点（对设计附录 A 的**有意修正**）：input required 仅 `payload.issue_key`；output `content` 必填、`mentions` 可选；skip 路径合法产出 null → check-output 走逃生门「空产出放行、非空校验」。
- 已验证：89/89 测试、typecheck/lint/circular/format 全绿；`node agent.materialize.mjs` 产物过平台 `assertContractGate` 真实校验；四个运行时探针符合预期。

## 关键坑与注意事项

1. **业务仓 `node_modules/@asteriskzuo/agent-sdk` 是本地软链** → 平台 `packages/sdk`（仅为本地验证，git 已忽略）。`npm install` 重生成 lock 时会替换为 registry 真包。**package.json 已升 `^0.4.0` 但 package-lock 还是 0.3.0，不一致，npm ci 会报错**——必须等 SDK 0.4.0 发布后再 `npm install`。
2. push、控制台重钉均需用户明确授权；T4 冒烟由用户主导（涉及真实上游）。
3. check 程序由平台统一调用：60s 固定超时（常量可测试注入）、最小注入（无 secrets/endpoint/programs/dataDir）、check 失败不升级平台错误（`RunOutcome.failed_at`）；contract.json 从 check 程序路径向上 ≤5 级探测，旧资产/坏契约跳过 check 阶段并记 warn；`input:null` 跳过阶段 1。
4. 平台去重（协议层：同工单同时间戳）与业务去重分层已在 runner/runtime 内，勿再改平台侧去重。
5. polling 与 webhook 双 true 时平台已兜底：webhook 优先、polling 抑制（commit `d49ebb1`，D2）。
6. `.prettierignore` 有一行 `pkg-bad-contract/contract.json` 排除（测试夹具故意坏契约），勿删。

## 验证命令速查

```bash
# 平台仓（根目录）六连
yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular
# 单包测试示例
yarn workspace @asteriskzuo/agent-runner test
# 业务仓
cd business/jira-ticket-review/package && npm test
# 物化 + 契约闸验证
node agent.materialize.mjs
```
