# Pi 受管配置实现计划

> 日期：2026-10-25
> 执行规格：`docs/specs/2026-10-25-pi-managed-configuration-spec.md`
> 约束：中文文档；不提交代码；不修改真实凭据和 workspace 数据；保留用户现有 Jira/Runner 未提交修改。

## 任务

- [x] 1. 扩展模型配置解析与 server 配置契约
  - 在 `app/server/src/models.ts` 定义完整 Pi 配置类型、严格校验和模型列表提取，保留未知字段。
  - 在 `app/server/src/config.ts` 增加 `pi_models`，支持文件 object 与 env JSON 字符串；`AGENT_PI_AGENT_DIR` 改为可选并派生默认路径，CLI 维持自动解析。
  - 在 `app/server/src/index.ts` 导出新增内部能力与类型。
  - 验证：`app/server/tests/config.test.ts`、`models.test.ts` 覆盖优先级、默认值、非法输入和 secret 错误脱敏。

- [x] 2. 实现启动生成并接入装配根
  - 在 `app/server/src/models.ts` 实现受管目录创建、0600 临时文件、原子 rename 和失败清理。
  - 在 `app/server/src/bootstrap.ts` 按“源校验 → 生成 → 自检 → 模型列表”顺序接线。
  - 保持 self-check 独立验证、AgentService 路径注入及 EffectiveConfigView 白名单不变。
  - 验证：首次生成、重启同步、字段保留、权限与失败不消费旧文件。

- [x] 3. 更新 server 测试 fixture 与管理 API 验证
  - 更新 `self-check.test.ts`、`console-api.test.ts`、`entry-adapters.test.ts`、`integration.test.ts`。
  - 运行时 fixture 不再人工准备 `models.json`，改由 `AGENT_PI_MODELS` 生成；self-check 独立单测可直接构造派生文件。
  - 验证 `/api/config` 只暴露 provider/id，不包含 sentinel secret。

- [x] 4. 同步当前文档
  - 更新 `README.md`：快速开始、配置优先级、可选路径、缓存重置和模板用途。
  - 更新当前设计/相关 spec 中的模型来源、密钥落盘和宿主 Pi 前提；保留历史调研与旧 plans。
  - 同步 console、console-api、agent-service、registry 的模型来源提示与注释，不改变运行行为。
  - 在 `docs/PROGRESS.md` 追加本次完成项；`templates/models.json.example` 仅保留为配置结构示例。

- [x] 5. 验证与交付审查
  - 运行 server build/test/typecheck 和 prettier 检查。
  - 运行根级 build、test、typecheck、lint、format:check、circular，以及 `git diff --check`。
  - 使用构建产物完成默认 CLI/目录、配置生成、权限和模型列表冒烟验证。
  - 通读最终 diff，核对无 secret、无真实 workspace 变更、无误改用户文件；更新本计划复选框。
  - 不执行 git commit，向用户报告改动和验证结果。

## 任务依赖关系

1. 任务 1 → 任务 2：生成逻辑复用配置类型和校验器。
2. 任务 1、2 → 任务 3：测试 fixture 依赖新启动契约。
3. 任务 1–3 → 任务 4：文档按最终实现口径回写。
4. 任务 1–4 → 任务 5：全部改动完成后统一验证和自审。
