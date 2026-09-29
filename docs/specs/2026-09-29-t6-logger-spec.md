# T6 logger 包 spec

> 实现任务规格。**本文自包含，是执行者的唯一必读依据**；背景出处（非必读）：`docs/designs/2026-09-14-skill-platform-spec-v3/design/logging.md`、`design/dependency-rules.md`。

## 1. 目标

产出 `@easemob/agent-logger` 包，三层结构：

- **底层 `ConsoleLike`**（实例型工具）：与 Node `console` 方法签名严格一致的通用单文件日志器——可无缝替换 console.xxx、可移植到任何 Node 项目，管格式化、脱敏、等级、开关、写盘；
- **中层 `CategoryLogger`**：绑定式分类日志器——模块初始化时绑定固定上下文，调用只传消息 + 增量字段；`with()` 链式再绑定；
- **上层全局外观 `logger`**：按依赖管理规则第 2 类（全局共享）落地——装配根启动时 `initLogger()` 一次，之后任何模块 `import { logger }` 即用，不走参数传递。

## 2. 背景知识（执行所需的最小上下文）

- **平台侧三类日志文件**（全局外观的管辖范围）：

| 日志 | 内容 | 文件位置 |
|------|------|----------|
| system | 日志总纲：启动自检、初始化、关键事件（任务入队/完结/死信、生命周期状态变更、配置变更） | `{logsDir}/system.log` |
| entry-loop | 入口循环的机械流水（取出→匹配→挂通道→闸门→spawn→完结/扇出） | `{logsDir}/entry-loop.log` |
| exit-loop | 出口投递流水（归属匹配→绑定→目标→投递结果/重试/死信） | `{logsDir}/exit-loop.log` |

- **业务日志不归本包上层管**：业务流程程序通过业务 SDK 的 log API 记录（SDK → 业务进程 stderr → WorkflowRunner 捕获），T9 追加到 `logs/businesses/{source}/{session_id}/{business_id}/{run_id}.log`（三维与 channel_id 对齐）时直接使用本包**底层**的 `createFileLogger`（通用单文件写口，不需要任何业务特殊化 API）。
- **依赖管理规则（必须遵守）**：平台日志外观属第 2 类「全局共享」——模块级单例外观（包内内部实例 + 导出委托，不用 class static）；装配根 init 一次；**未初始化就调用 = 抛错**；**初始化后配置不可变**；提供 `resetForTests()`。唯一例外：脱敏注册表**只增不改**（业务密钥运行期才出现，只能运行时登记；append-only 无行为分叉）。
- **关联键是命名约定，不是类型**：`event_id` / `lifecycle_id` / `channel_id` / `correlation_id` 是保留字段名（有就用这些名字，保证跨日志互跳的检索一致性），任何模块都可附加自由字段。
- **纪律**：error/warn/info 三级契约性必打（调用方职责），debug 可选；脱敏内建（注册敏感值，输出前子串替换为 `***`）；写盘异常降级 console 兜底，**日志管道自身永不使平台崩溃**；文件分割不做（交 logrotate）。
- **fail-fast**：init 时 logsDir 不可创建/不可写 = 启动自检失败，直接抛错。

## 3. 范围与不做清单

**本任务做**：`createFileLogger`（底层实例工具）+ `initLogger` / `logger` / `CategoryLogger`（全局外观 + 中层）+ `resetForTests`。

**本任务不做**：

- 业务日志的专用 API（见 §2，走 SDK + 底层通用写口）；
- 文件分割/轮转/清理；日志采集侧（stderr 捕获归 T9）；循环埋点调用（归 T7/T11）；远程收集、查询 UI。

## 4. 包结构

```text
packages/logger/
├── package.json            # @easemob/agent-logger
├── tsconfig.json
├── src/
│   ├── index.ts            # 统一导出
│   ├── file-logger.ts      # 底层 ConsoleLike（实例型，可移植）
│   └── facade.ts           # initLogger + logger 全局外观 + CategoryLogger
└── tests/
    ├── file-logger.test.ts
    └── facade.test.ts
```

工程约定同 T0 spec §4。运行时依赖为零（只用 `node:fs`、`node:path`、`node:util`）。本包不 import contracts（关联键按不透明字符串处理）。

## 5. 详细规格

### 5.1 底层：ConsoleLike（实例型工具，不属于全局共享）

```ts
/** 与 Node console 对应方法签名严格一致——console.debug(...) 与 fileLogger.debug(...)
 *  可无脑互相替换；可移植到任何 Node 项目独立使用。四个方法语义与 console 完全对齐：
 *  多参数 util.format 拼接、占位符 %s/%d/%j、对象 inspect */
export interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface FileLoggerOptions {
  level?: LogLevel;                    // 默认 'info'
  enabled?: boolean;                   // 默认 true
  secrets?: readonly string[];         // 初始脱敏值列表
  control?: SharedControl;             // 内部使用：全局外观共享控制对象；独立使用时省略
}

/** 创建写单个文件的底层日志器；父目录自动创建 */
export function createFileLogger(path: string, options?: FileLoggerOptions): ConsoleLike;
```

底层实现要点：

1. **参数格式化**：`util.format(...args)`（与 console 完全相同的语义：`%s/%d/%j` 占位、多参数空格连接、对象走 inspect）；
2. **落盘格式**：JSONL，一行一条 `{"ts","level","message"}`（ts = `new Date().toISOString()`）；
3. **写盘**：`appendFileSync`；写盘异常降级 `console.error` 兜底输出一次，不向上抛；
4. **脱敏**：对格式化后的整行做子串替换（所有注册值出现即替换 `***`）；空串/长度 < 8 的值不参与（防误伤）；
5. **等级过滤**：error < warn < info < debug 阈值；`enabled=false` 全静默；
6. **控制来源**：默认持有私有控制对象；传入 `control`（SharedControl，包内类型）时共享之——全局外观用它实现"一改全员生效"，独立使用者不感知。

### 5.2 上层：全局外观 + 中层 CategoryLogger

```ts
/** 自由字段：开放结构，类型不设限。保留字段名约定（检索一致性）：event_id / lifecycle_id / channel_id / correlation_id */
export type LogFields = Record<string, unknown>;

/** 中层：绑定固定上下文的分类日志器。调用只传消息 + 本次增量字段 */
export interface CategoryLogger {
  /** 四级方法与 console 级别语义一致；message 为主消息，fields 为本次增量字段（与绑定字段合并，同名覆盖） */
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;

  /** 追加绑定字段，返回新实例（继承原绑定 + 追加，同名覆盖；原实例不受影响） */
  with(fields: LogFields): CategoryLogger;
}

export interface LoggerInitOptions {
  logsDir: string;                       // 平台日志目录（system/entry-loop/exit-loop 三个文件写在这里）
  level?: LogLevel;                    // 默认 'info'；初始化后不可变
  enabled?: boolean;                   // 默认 true；初始化后不可变
  secrets?: readonly string[];         // 初始脱敏值列表；运行期新增走 logger.addSecrets
}

/** 全局外观初始化：仅装配根启动时调用一次；重复调用抛错。
 *  fail-fast：logsDir 不可创建/不可写 → 抛错（启动自检） */
export function initLogger(options: LoggerInitOptions): void;

/** 平台日志全局外观。未初始化时调用任何方法 → 抛错 */
export const logger: {
  /** 绑定模块上下文取分类日志器。路由：module 'entry-loop'→entry-loop.log、
   *  'exit-loop'→exit-loop.log、其余一律归 system.log */
  for(context: { module: string } & LogFields): CategoryLogger;

  /** 登记脱敏值：只增不改（append-only，依赖管理规则第 2 类唯一例外） */
  addSecrets(values: readonly string[]): void;
};

/** 测试专用：重置全局外观（含共享控制与已建文件日志器）。生产代码禁止调用 */
export function resetForTests(): void;
```

中上层实现要点：

1. **共享可变控制**：init 创建一个 `{level, enabled, secrets[]}` 控制对象，三个底层文件日志器（system/entry-loop/exit-loop，懒建）经 `control` 共享之；`addSecrets` 追加进该对象即全员生效；
2. **中层落盘格式**：JSONL `{ts, level, ...绑定字段, ...增量字段, message}`——绑定字段在前、增量字段在后（同名增量覆盖绑定）；脱敏对整行生效；写盘复用底层的写盘/脱敏内部实现（共享，不复制代码）；
3. **with()**：返回新 CategoryLogger，绑定字段 = 原绑定 ∪ 新字段（新覆盖同名）；可链式；
4. **fail-fast**：init 时对 logsDir 做"建目录 + 写测文件 + 删除"，失败即抛错（说明目录与原因）。

## 6. 测试清单

**file-logger.test.ts**
- 与 console 同签名：多参数、`%s` 占位、对象参数各一例，落盘内容与 `util.format` 结果一致；
- JSONL 格式（ts/level/message 齐全）；等级过滤；enabled=false 全静默；
- 脱敏：注册值在任意参数位置被替换；<8 字符不参与；
- 父目录自动创建；写盘异常降级不抛错。

**facade.test.ts**（每个用例后 resetForTests）
- 未初始化调用 `logger.for` / `addSecrets` → 抛错；init 重复调用 → 抛错；
- 路由：`for({module:'entry-loop'})` / `'exit-loop'` / 其他名 → 三个文件各归各位；
- 绑定：`for({module:'queue', component:'take'})` 后 `info('msg')` 落盘行含 module+component+message；
- `with()`：继承 + 追加 + 同名覆盖；原实例不受影响；链式两次叠加正确；
- 增量字段自由：任意自定义字段（如 sql、tokens）原样落盘；
- `addSecrets` 后登记的密钥在后续日志中被替换（含已创建实例的输出）；
- fail-fast：logsDir 不可写（同名文件占位）→ initLogger 抛错。

## 7. 验收标准

1. 包级与根级六项检查全绿；
2. 运行时零依赖（只 import `node:*`）；
3. 导出签名与本文 §5 一致（底层四个方法与 console 签名逐项核对）；
4. 包内不出现任何业务概念（无 business/run/session 字样的 API）；
5. 全局外观符合依赖管理规则第 2 类全部纪律（init 一次 / 未初始化抛错 / 初始化后配置不可变 / addSecrets 只增不改 / resetForTests 存在）。
