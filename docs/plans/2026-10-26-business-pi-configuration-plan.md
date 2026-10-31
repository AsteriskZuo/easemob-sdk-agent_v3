# 业务配置安全更新与自定义 Pi 配置实现计划

> 日期：2026-10-26（2026-10-31 修订：资产下架改为 enabled 开关并与既有物理删除并存；更新队列复用 packages/queue 通用能力，严格全局 FIFO）
> 执行规格：`docs/specs/2026-10-26-business-pi-configuration-spec.md`（已确认）
> 约束：全部任务完成后统一提交实现代码；自动测试不访问真实厂商；不擅自执行 npm publish。

## 已收敛的实现边界

1. 业务可保存完整 Pi 原生 `models.json` 对象；平台不内置厂商适配、不自动修复配置，保留 `!command` 等原生能力及其执行风险。
2. 自定义配置必须先通过真实模型探针，再由用户点击确认；未通过不能保存。只验证本次选择的 `provider/id`，不逐个调用配置里的其他模型。
3. 在线验证只使用 `businesses/{business_id}/cache/pi/` 下的短期验证目录；确认、取消、过期后清理。未确认状态不持久化，重启后重新验证。
4. 原始业务配置存 `platform.db`，不进入 EnvProvider 两桶、Runner 信封或 `sdk.secret()`；控制台和日志使用复合对象脱敏，当前不新增加密。
5. 本次保留现有全局 Pi 配置和兜底；未来删除全局配置另行迁移。初始化不做真实模型探针，不处理 `--max-tokens`。
6. 新增 `process-runner` 与 `pi-probe` 两个技术包；其中 process-runner 公共发布，SDK 依赖并复用它，随变更重新发布，不保留第二套 spawn。探针由 agent-server 调用，不是常驻服务；真实生成事件出现后立刻取消 Pi 子进程。
7. agent-server 只新增一个持久化 UpdateCoordinator，统一处理所有影响业务执行的在线配置与资产变更，包括全局 env；Pi 不走独立更新通道。等待自然空闲期间不阻止新 run；实际应用更新与新 run 登记之间必须短时互斥。控制台不展示队列状态，只说明生效时机。
8. 不引入候选配置体系、run 级 Pi 快照或资产内容版本系统；通过每业务 Pi 目录与更新屏障保护当前 run。
9. 资产下架/上架是 `AssetMeta.enabled` 开关：关闭后绑定该资产的业务运行时直接失败，登记、绑定、commit 与物化缓存全部保留，上架即恢复。既有 `AssetRegistry.remove` 的物理删除语义保留，与开关并存，同样纳入统一更新队列。
10. 更新队列复用 `packages/queue` 的通用持久化队列能力；更新命令是新建的任务对象，不复用 EventEnvelope。逻辑上成为与入口/出口并列的第三条持久化队列和第三个 update loop，严格全局 FIFO：队首涉及业务未空闲时原地等待，后续命令不插队。

## 任务

- [ ] 1. 新增可公共发布的通用 `process-runner` 包
  - 新建 `packages/process-runner`，包名 `@asteriskzuo/agent-process-runner`，采用现有 workspace、TypeScript、Jest/esbuild 约定，并按 `agent-sdk` 的公共发布边界配置 files、publishConfig 和构建产物。
  - 实现 `runProcess(command, args, options)`：数组参数、显式 env 策略、cwd/stdin、流式 stdout/stderr、可配置输出上限、超时、AbortSignal、SIGTERM→SIGKILL 和结构化错误。
  - 在支持的 POSIX 环境管理子进程组，避免取消 Pi 后遗留命令子进程；不得在包内散读平台配置。
  - 用本地 fixture 覆盖成功、非零退出、spawn 失败、超时、主动取消、输出超限、显式不限制输出和流回调，不访问外部服务。

- [ ] 2. 迁移全部生产 `spawn` 并准备 SDK 重新发布
  - 将 `packages/agent-service/src/pi-runner.ts`、`pi-compact.ts`、`packages/workflow-runner/src/runner.ts` 和 `packages/sdk/src/run.ts` 全部接入 `process-runner`，删除各自重复的 spawn、超时和进程终止管理。
  - 在 `@asteriskzuo/agent-sdk` 的 dependencies 中声明公共 `@asteriskzuo/agent-process-runner` 兼容版本，不依赖平台私有包或把 workspace 协议泄漏到发布产物；发布顺序为 process-runner → SDK，版本号按发布流程确定。
  - 保持现有参数、stdin/stdout 契约、结果优先级、错误前缀、超时、业务日志和 AgentService close 语义；`sdk.run` 显式保留现有 5 秒终止宽限和 stdout 聚合需求，调用方用 AbortController 管理在飞进程。
  - JSONL、业务结果和 compact 响应解析仍归各调用方，不塞入通用进程包；只有测试 fixture 可直接创建辅助进程。
  - 运行相关包及模板验收测试，并对 process-runner 和 SDK 执行 npm pack，在隔离目录安装压缩包验证公共依赖解析和真实子程序调用；实际 npm 发布不在本地测试中擅自执行。

- [ ] 3. 扩展 queue 包并实现唯一的持久化 UpdateCoordinator 与运行屏障
  - 在 `packages/queue` 抽出可共享的持久化 FIFO 基础（表结构、pending/processing/done/failed 状态机、recover/purge），保持 `createTaskQueue` 与入口/出口队列 API、表结构和既有测试兼容；更新命令是新建任务对象，不复用 EventEnvelope 信封。
  - 基于该基础在 queue 包新增更新命令队列能力，落地 `business_update_commands` 及 `business_update_command_businesses` 关联表；全局自增 seq，单一物理队列，严格全局 FIFO。
  - 在 `app/server/src/updates/` 实现命令类型、UpdateCoordinator 与第三个 update loop；在 scheduler 增加窄 RunGate 接缝并包裹全局并发闸与 EntryDriver。queue 包只负责持久化与状态恢复，闲时判断、应用屏障与命令处理器归 app/server。
  - 命令覆盖：业务创建、资料/绑定/quota、业务删除、匹配行、全局/业务 env、业务 Pi、资产登记/更新/上架/下架/删除及资产缓存清理。业务创建和无引用新资产登记也提交同一协调器，只是在无竞争时立即应用；部署启动配置和账号等非运行时写入口不纳入。
  - run 登记必须发生在 ContextLoader 之前，release 在 runner、AgentService.close 和终态处理后的 finally 中执行；同一业务所有 session 共用活动计数。RunGate 同时检查全平台与本业务 applying。
  - update loop 只取队首命令：队首涉及的业务（单业务、全部资产引用方或全业务）活动数均为 0 时，在同一个无 await 的临界段设置 applying 屏障后进入应用窗口；未空闲则原地等待，有影响集合的后续命令不插队。空影响集合命令（业务创建、无引用资产登记）豁免队首等待，但不得在全平台应用窗口进行中应用。等待期间新 run 照常登记；应用完成后释放屏障、唤醒等待的新 run 并推进队列。共享资产命令只应用一次。
  - 已确认命令持久化；无受影响活动执行时 submit 等待可用应用窗口，返回 applied 及应用结果，仍被活动执行阻塞时返回 accepted。`processing` 崩溃残留恢复为 pending，并在 entry/exit loop、入口 adapter 和控制台 API 启动前恢复。
  - 失败命令记错误、不自动重试，释放屏障并继续后续命令；business.delete 应用时将同业务后续 pending 命令标记 failed。日志不含配置秘密。控制台读面仍表示当前生效值，不暴露 pending 状态。

- [ ] 4. 将全部运行时管理写入口接入同一协调器，并落地资产开关
  - 在 `packages/console-api/src/server.ts` 注入窄接口，`routes-businesses.ts`、`routes-env.ts`、`routes-assets.ts`、`routes-config.ts` 只组装命令和权限校验，不再直接写生效注册表；业务创建和全局 env 也包含在内。
  - 业务创建、业务删除、全局/业务 env、资产写入和 `POST /api/cache/clear` 统一调用 submit；能立即应用时从 applied.result 保留现有同步 API 响应，仍被活动执行阻塞时返回 202，不保留绕过协调器的即时写分支。
  - `AssetMeta` 新增 `enabled`（存量迁移为 true）；`AssetRegistry` 新增幂等 `setEnabled`，登记失败回滚的物理删除保留为私有清理。`DELETE /api/assets/:id` 保持既有物理删除语义并改为提交命令，提交时仍有引用方则返回 409 并提示先解绑或下架；新增上架/下架写入口 `PUT /api/assets/:id/status`（body `{ enabled }`）提交 `asset.enabled.set`。
  - ContextLoader 物化前检查业务绑定资产，任一 enabled=false 以 `asset_disabled: <asset_id>` 失败且不进入业务程序；绑定配置校验拒绝新增绑定 disabled 资产，已有绑定保留，重新上架后自动恢复。`assets.list` 增加可选 enabled 过滤。
  - 从 asset-registry 导出只读 `resolveRef`，并新增 `resolveUpdateRef(asset_id, ref, opts)` 返回 commit/changed；提交时固定版本，changed=false 直接幂等返回，物化只在应用窗口执行。
  - 登记命令使用固定后的 input.ref 和 computeAssetId 判断在役引用；无引用时以空影响集合提交并立即应用。credential_key 只存键名，提交/应用时分别解析真值。配置期校验与真正写入分开，不提前改写 live 缓存。
  - 同一业务多个命令按队列 seq 顺序应用，后者覆盖前者，不做深合并；应用失败保留可用的旧生效配置并写系统日志。立即应用保持现有同步响应，忙时接受返回 202。
  - 用并发测试证明：忙时写入不影响旧 run、等待期新 run 可继续、空闲交接无竞态、多 session 计数正确、严格全局 FIFO（队首未空闲后续命令不插队）、空影响命令在队首阻塞时立即完成、删除有引用资产返回 409、business.delete 应用后同业务后续 pending 命令标 failed、重启后 pending 先恢复、共享资产只更新一次、业务删除与 cache clear 的屏障正确、全局 env 成为队首后等待全业务空闲，以及资产下架 fail-fast、上架恢复、绑定与缓存保留。

- [ ] 5. 增加业务 Pi 配置存储与运行时目录解析
  - 在 `packages/registry/src/business-registry.ts` 为 businesses 增加私有 `pi_models` JSON 列和专用读写方法；原始值不出现在 `BusinessProfile`、list/getProfile 或普通 BusinessPatch 中。
  - Pi 设置与 `model` 在同一 registry 写操作中更新；普通 PATCH 不得绕过专用验证流程修改自定义配置。删除自定义配置时同时选择合法的全局模型。
  - 在 `app/server/src/models.ts` 保留全局严格校验，新增业务原生配置校验：允许内置 provider 简写，保留所有未知字段，校验所选 model 的 provider/id 归属；不校验厂商语义。
  - 原始配置存 platform.db；每次 run 在配置读取阶段，如存在业务配置则原子生成 `businesses/{business_id}/cache/pi/agent/models.json`。生成失败则该 run 失败，禁止静默回退全局。
  - 给 ContextLoader/RunContext/AgentServeContext 增加可选 `pi_agent_dir`；`buildPiEnv` 优先使用 run 上下文，未配置业务才使用现有 `deps.pi_agent_dir`。
  - 验证 agent 与 compact 使用相同业务目录，Runner stdin 和 sdk.secret() 不含 `AGENT_PI_MODELS` 或其值。

- [ ] 6. 新增独立 `pi-probe` 包
  - 新建 `packages/pi-probe`，包名 `@asteriskzuo/agent-pi-probe`，只依赖显式注入的 CLI、候选 agent dir、provider/id、env、cwd、timeout 和 `process-runner`。
  - 使用 `pi -p --mode json --no-session`，关闭 tools/skills/extensions/prompt-templates/context-files；不传业务 prompt、业务数据或 `--max-tokens`。
  - 逐行解析 stdout；只有非空 `text_delta`、`thinking_delta`，或带实际内容的对应 end/最终 assistant 事件可证明真实生成。session/header、prompt accepted、message_start、HTTP 200 和退出码 0 均不能单独算成功。
  - 首个有效生成事件后立即 abort；短超时、清理进程。assistant error、超时、无生成事件退出、spawn/非零退出分别返回结构化失败。
  - 不读取 DB、不保存配置、不决定兜底、不处理模板和控制台脱敏；原始 stdout/stderr 不直接写日志，返回详情有长度上限，由调用方二次脱敏。
  - 用假 Pi 覆盖首 delta 成功、只有 header 失败、exit 0 但 assistant error、非流式内容事件、超时和取消清理。

- [ ] 7. 实现验证—确认服务与管理 API
  - 在 app/server 增加短期验证服务：同一业务新验证取消并取代旧验证，候选文件写 `cache/pi/validations/{validation_id}/agent/models.json`，目录 0700、文件 0600。
  - 验证状态仅内存保存并设短 TTL，绑定 business_id、操作者、完整配置、model 和随机 validation_id；确认只接受 validation_id，不接收另一份配置。重启/过期后要求重新验证。
  - 新增脱敏读取、在线验证、确认保存、删除自定义配置路由；确认形成 UpdateCoordinator 命令，空闲时等待应用，忙时返回 accepted 且不立即改生效值。
  - 验证失败或确认前任何编辑都不能保存；更新已有配置失败时旧配置不变。真实调用失败不 fallback。
  - 在 logger 包增加 Pi 复合对象递归掩码、敏感值收集和专用文本脱敏纯函数；普通 vars/secrets 的既有脱敏流程不变。控制台展示和平台日志不得输出原始配置，API 错误只含字段路径及脱敏后的有界详情。
  - 对所有敏感字段要求更新时重新填写，掩码占位符不得保存为真值；原生 `!command` 不禁止，但文档和 UI 明确验证阶段也可能执行命令。

- [ ] 8. 更新控制台业务编辑页
  - 在 `BusinessEditPage.tsx` 增加“平台默认 / 业务自定义”模式；创建页本次沿用平台默认，已有业务编辑页可配置自定义 Pi。
  - 自定义模式允许手工输入 provider/id，不再受全局 `/api/config.models` 限制；提供完整 JSON 编辑、在线验证和验证成功后的确认保存。
  - 验证后任何字段改动使确认按钮失效；所有掩码字段重新填写。删除自定义配置恢复平台默认，经更新队列生效。
  - 增加厂商帮助抽屉：千问、DeepSeek、OpenAI 分标签、完整占位模板、复制和官方文档链接；模板不自动合并或保存，不参与运行校验。
  - 千问使用 DashScope 兼容地址和 openai-completions 显式模型；DeepSeek/OpenAI 优先内置 provider 简写，避免覆盖内置模型元数据。baseUrl 不追加端点路径。
  - 资产页（`app/console/src/pages/AssetsPage.tsx`）显示“已上架/已下架”状态列，提供上架/下架动作并提示“下架后绑定该资产的业务运行时将直接失败，重新上架后恢复；登记、绑定与缓存均保留”；删除维持既有操作与语义。
  - 不展示 pending、update_id 或进度，只显示“当前有任务执行时，修改将在受影响业务空闲后自动生效，后续运行使用新配置；生效前页面显示当前生效值”。

- [ ] 9. 同步当前文档和注释
  - 更新 `docs/specs/2026-10-25-pi-managed-configuration-spec.md`、`2026-10-05-t13-console-api-spec.md` 的冲突条款，指向新业务配置与统一更新队列规格。
  - 同步 `docs/specs/2026-09-28-t3-queue-spec.md`（queue 包新增通用更新命令队列能力）与 `docs/specs/2026-09-30-t16-asset-registry-spec.md`（下架不再是物理删除，改为 enabled 开关，remove 保留为显式删除）；清理 asset-model、core-modules、console-design 中“下架=删除”“只有入口/出口两条队列”的旧口径。
  - 更新 console-design、lifecycle、core-modules、security、dependency-rules、README 和 `docs/PROGRESS.md`；补充 businesses/{id}/cache/pi 目录、platform.db 新用途、全局/业务配置统一写入口、资产开关语义、第三条更新队列，以及 process-runner → SDK 的公共发布边界和依赖顺序，不保留 SDK 私有例外。
  - 清理“全部模型只能启动重启生效”“模型配置绝不进 SQLite/控制台”“业务密钥不落盘”等与新明文派生缓存契约冲突的当前表述；历史调研和旧计划不改写。
  - 更新 AGENTS.md 仅在其记载规则实际变化时；不改真实 platform/config.json、.pi、业务数据或用户无关文件。

- [ ] 10. 全量验证与交付审查
  - 先运行新包及相关包 build/test/typecheck，再运行根级 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 和 `git diff --check`。
  - 用构建产物和假 Pi 完成端到端：验证成功才能确认、确认进入同一更新队列、忙时旧 run 不受影响、自然空闲后下一 run 使用业务配置、全局 env 等待全业务空闲、重启恢复、secret 不进入 API/Runner/日志；资产下架后绑定业务 fail-fast、上架后恢复、登记与缓存保留，队首涉及业务未空闲时后续更新命令不插队。
  - 检查生产代码不存在绕过 process-runner 的第二套 spawn；安装 npm pack 产物并运行 SDK 子程序，证明业务包脱离 monorepo 后仍能解析公共 process-runner 依赖。
  - 自动测试不访问真实厂商。真实 DeepSeek/千问/OpenAI 探针只在用户提供测试配置并明确授权请求与费用后执行；未执行时明确报告，不伪装已验证。
  - 通读 diff、核对文档事实和旧注释，更新本计划复选框；不执行 git commit 或 npm publish，等待用户审查与发布指令。

## 任务依赖关系

1. 任务 1 → 任务 2、6：平台与 SDK 的所有生产进程调用共用原语，探针和 SDK 都不复制 spawn 管理。
2. 任务 3 → 任务 4、7：queue 包通用队列能力与 UpdateCoordinator 先就绪，全部运行时管理写入和 Pi 确认保存必须经同一更新协调器。
3. 任务 5 → 任务 7、8：验证/API/UI 依赖业务配置存储与运行时边界。
4. 任务 1、5、6 → 任务 7：真实验证服务依赖进程包、业务目录和探针。
5. 任务 4、7 → 任务 8：控制台只消费已确定的 API 与生效说明。
6. 任务 1–8 → 任务 9 → 任务 10：按最终实现同步文档后统一验证和自审。
