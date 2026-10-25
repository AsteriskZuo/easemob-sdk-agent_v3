# Pi 受管配置规格

> 日期：2026-10-25
> 状态：已确认，实施依据
> 范围：`app/server` 的 Pi 路径解析、模型配置解析与启动生成；同步当前操作/设计文档。本文自包含，旧 spec 与本文件冲突的 Pi 配置口径以本文件为准。

## 1. 背景与目标

当前 `AGENT_PI_CLI_PATH` 已能从 npm 依赖自动解析，但 `AGENT_PI_AGENT_DIR` 仍必填，且启动自检要求用户提前手工准备其中的 `models.json`。这使运行依赖开发机目录和人工操作，不适合可控部署。

本次将配置关系统一为：

- `AGENT_PI_CLI_PATH`：可选；缺省从项目锁定的 `@earendil-works/pi-coding-agent` npm 依赖解析，显式值优先。
- `AGENT_PI_AGENT_DIR`：可选；缺省为 `{workspace}/platform/cache/pi/agent`，显式值优先。
- `AGENT_PI_MODELS`：必需的模型配置来源；server 每次启动校验并生成/同步 `{pi_agent_dir}/models.json`。
- `models.json` 是平台派生缓存，不再是人工维护的第二份配置。
- 默认与自定义 agent 目录均为平台专用受管目录；自定义只改变位置，不切换成“人工维护 models.json”模式。

配置优先级保持：`环境变量 > {workspace}/platform/config.json > 平台默认值`。显式路径非法时失败，不回退默认值。

## 2. 范围与不做清单

做：

1. 扩展 server 配置契约和解析测试。
2. 严格校验模型配置，保留完整 Pi 配置字段。
3. 启动时创建受管目录并原子同步 `models.json`，然后执行现有自检和模型列表加载。
4. 保持 Pi 子进程的 `PI_CODING_AGENT_DIR`、per-run cwd、`--session-dir` 现有显式传递不变。
5. 更新当前 README、设计及相关 spec；历史调研和历史实施进度不改写。

不做：

- 不增加“完全外置、平台只读”的 Pi 配置模式。
- 不支持热更新；修改模型配置后重启生效。
- 不把模型配置迁入 SQLite、控制台可写设置或业务两桶。
- 不改变 Pi 子进程 `PATH/HOME` 白名单，不扩展 Docker、沙箱或 OS 级隔离。
- 不自动复制、删除或改写 `auth.json`、`settings.json` 等其他 Pi 文件；受管目录应是专用目录，避免已有凭据产生额外优先级。
- 不修改真实 workspace 的 `platform/config.json`、`.pi/` 凭据或业务数据。

## 3. 配置契约

### 3.1 路径配置

| 键 | 必填 | 缺省行为 | 显式配置行为 |
|---|---|---|---|
| `AGENT_PI_CLI_PATH` | 否 | 从 server 的 npm 依赖 manifest `bin` 解析 Pi CLI | 使用该路径；自检验存在且可执行 |
| `AGENT_PI_AGENT_DIR` | 否 | `{workspace}/platform/cache/pi/agent` | 使用该专用受管目录；启动创建并同步其中的 `models.json` |

推荐使用两个缺省值。显式路径建议使用绝对路径；自定义目录不得指向个人共用目录或其他平台实例的受管目录。启动会覆盖其中的 `models.json`，人工修改不会保留。

### 3.2 模型配置

`AGENT_PI_MODELS` 必须由环境变量或 `platform/config.json` 提供，最终至少包含一个可用模型。

文件来源是 JSON object，结构与 Pi `models.json` 相同：

```json
{
  "AGENT_PI_MODELS": {
    "providers": {
      "example-provider": {
        "baseUrl": "https://example.com/v1",
        "api": "openai-completions",
        "apiKey": "replace-with-real-key",
        "models": [{ "id": "model-a" }]
      }
    }
  }
}
```

环境变量来源是同结构 JSON 字符串，例如 `AGENT_PI_MODELS='{"providers":...}'`。环境变量存在时整体覆盖文件值，不做深合并；高优先级来源存在但非法时直接失败，不 fallback。

`templates/models.json.example` 保留为 `AGENT_PI_MODELS` 值的结构示例，不再表示“复制到 agent 目录并改名为 models.json”。旧版升级由用户把原 `models.json` 的 `{ "providers": ... }` 一次性迁入 `AGENT_PI_MODELS`；本任务不自动读取或改写真实配置，不提供双来源兼容。

### 3.3 校验规则与字段保留

- 顶层必须是非数组 object，`providers` 必须是非空、非数组 object。
- 每个 provider 配置必须是 object，`baseUrl`、`api`、`apiKey` 必须是非空字符串，`models` 必须是非空数组。
- 每个 model 必须是 object，`id` 必须是非空字符串；同一 provider 内模型 id 不重复。
- 任一已声明 provider/model 非法都失败，不允许静默跳过坏项后使用剩余模型。
- 未知的顶层、provider、model 字段原样保留并序列化，以兼容锁定 Pi 版本支持的 `headers`、模型元数据等配置；平台不重建简化对象。
- `apiKey` 应使用字面量，Pi 子进程不继承厂商密钥环境变量，不能依赖 `$ENV_VAR` 插值；本地服务可使用 Pi 接受的占位值。平台不额外判断密钥真实性或请求供应商。
- 可用模型列表按声明顺序产出为 `provider/id`，平台代码不内置模型名。

## 4. 内部接口与启动顺序

### 4.1 ServerConfig 增量

```ts
export interface PiModelDefinition {
  /** 模型在 provider 内的唯一标识；用于组成 provider/id */
  id: string;
  /** 其他 Pi 原生模型字段原样保留 */
  [key: string]: unknown;
}

export interface PiProviderDefinition {
  /** 兼容接口地址；非空字符串 */
  baseUrl: string;
  /** Pi 协议适配器名；非空字符串 */
  api: string;
  /** 模型凭据；禁止进入日志、错误详情和 API 回显 */
  apiKey: string;
  /** 该 provider 的可用模型；至少一项 */
  models: PiModelDefinition[];
  /** 其他 Pi 原生 provider 字段原样保留 */
  [key: string]: unknown;
}

export interface PiModelsConfig {
  /** provider 名到完整 Pi 配置的映射；至少一个 provider */
  providers: Record<string, PiProviderDefinition>;
  /** 其他 Pi 原生顶层字段原样保留 */
  [key: string]: unknown;
}

export interface ServerConfig {
  /** 已校验的完整模型配置；含 secret，不进入 EffectiveConfigView */
  pi_models: PiModelsConfig;
  // 其余既有字段保持不变。
}
```

`app/server/src/models.ts` 提供内部能力：

```ts
/** 校验未知输入并提取模型列表；错误只含配置键/字段路径，不含原始值 */
export function validatePiModelsConfig(
  value: unknown,
  source?: string,
): { config: PiModelsConfig; models: string[] };

/** 创建受管目录并原子同步 models.json；失败抛出且不继续使用旧文件 */
export function preparePiModels(
  piAgentDir: string,
  config: PiModelsConfig,
): void;

/** 读取并严格校验派生文件，返回 provider/id 列表 */
export function loadModelList(piAgentDir: string): string[];
```

`resolveServerConfig` 在返回前完成 `pi_models` 校验。`preparePiModels` 仍调用同一校验器，防止绕过配置解析的直接调用写入非法文件。

### 4.2 文件生成纪律

1. 递归创建 agent 目录；受管目录权限设为 `0700`。
2. 序列化完整 `pi_models`，保留未知字段，末尾换行。
3. 在同一目录创建随机临时文件，权限 `0600`，写入后通过原子 rename 替换 `models.json`。
4. 任一写入/替换失败都清理本次临时文件并中止启动；不删除旧文件、不继续消费旧文件。
5. 派生文件虽可重建，仍含 API Key，必须按 secret 管理。

### 4.3 bootstrap 顺序

```text
resolveServerConfig（含源配置严格校验）
→ initLogger
→ preparePiModels（创建/同步派生文件）
→ runSelfCheck（检查 CLI、派生文件及其他既有前提）
→ loadModelList（供 /api/config）
→ 打开数据库、装配并启动循环/入口/API
```

源配置非法、目录不可写或生成失败都不得使用旧 `models.json` 启动。`runSelfCheck` 保留独立验证派生文件的职责。

### 4.4 Pi 运行目录保持现状

- `PI_CODING_AGENT_DIR = config.pi_agent_dir`。
- agent/compact 子进程 cwd 均为 `businesses/{business_id}/runs/{source}/{session_id}/{run_id}/`。
- `--session-dir` 均为 `businesses/{business_id}/cache/agent-sessions/{source}/{session_id}/`。
- Pi 子进程环境仍只有 `PATH/HOME` 加平台内部变量；模型 Key 通过受管 `models.json` 提供，不加入 Pi 子进程环境。

## 5. 安全与管理 API

- `ServerConfig.pi_models` 不加入 `EffectiveConfigView`，不得通过展开 `ServerConfig` 构造 API DTO。
- `/api/config` 继续只返回 `models: string[]` 和非敏感路径，不返回 providers 原文、API Key 或原始 JSON。
- 配置解析可能发生在 logger 初始化前，因此错误文本不能依赖日志脱敏：不得包含原始 JSON、JSON.parse 原文、`apiKey` 值或其他配置值。
- 真实 `platform/config.json` 和派生 `models.json` 均不得进 git；只有脱敏示例可进仓库。
- 启动日志不得打印 `pi_models`；现有路径回显可保留。

## 6. 测试与验收

至少覆盖：

1. 两个路径缺省：CLI 命中 npm bin，agent dir 命中 workspace 默认路径；显式值分别优先。
2. `AGENT_PI_MODELS` 文件 object、env JSON 字符串、env 整体覆盖文件、缺失/非法 JSON/非法类型/坏 provider/坏 model/重复 id。
3. 校验错误和启动日志不含 sentinel secret。
4. 首次生成、配置变化后重启同步、完整未知字段保留、目录/文件权限、生成后模型列表正确。
5. 非法源配置不覆盖已有文件；写入失败中止，不消费旧文件。
6. 现有自检、console API、入口适配器和集成测试改用 `AGENT_PI_MODELS` fixture；API 不泄漏 secret。
7. `yarn workspace @asteriskzuo/agent-server build && yarn workspace @asteriskzuo/agent-server test && yarn workspace @asteriskzuo/agent-server typecheck` 通过。
8. 根级 `yarn build && yarn test && yarn typecheck && yarn lint && yarn format:check && yarn circular` 通过，`git diff --check` 无问题。

完成实现和检查后更新 plan 复选框；本任务不执行 git commit，不修改或还原用户已有的 Jira/Runner 工作区改动。
