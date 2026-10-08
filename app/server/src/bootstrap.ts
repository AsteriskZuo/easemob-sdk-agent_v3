import { join } from "node:path";
import { createAssetRegistry } from "@asterisk/agent-asset-registry";
import type { AssetRegistry } from "@asterisk/agent-asset-registry";
import { createChannelPool, createChannelStore } from "@asterisk/agent-channel";
import { createConsoleApi } from "@asterisk/agent-console-api";
import type {
  ConsoleApi,
  EffectiveConfigView,
} from "@asterisk/agent-console-api";
import { openDatabase } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import { createExitRegistry } from "@asterisk/agent-exit-tools";
import { initLogger, logger } from "@asterisk/agent-logger";
import { createTaskQueue } from "@asterisk/agent-queue";
import type { TaskQueue } from "@asterisk/agent-queue";
import { createBusinessRegistry } from "@asterisk/agent-registry";
import type { BusinessRegistry } from "@asterisk/agent-registry";
import {
  createContextLoader,
  createEnvProvider,
  createLifecycle,
  createLifecycleStore,
} from "@asterisk/agent-runtime";
import type { EnvProvider } from "@asterisk/agent-runtime";
import { createEntryLoop, createExitLoop } from "@asterisk/agent-scheduler";
import type { PlatformConfig, SchedulerLoop } from "@asterisk/agent-scheduler";
import { createAgentService } from "@asterisk/agent-service";
import { createWorkflowRunner } from "@asterisk/agent-workflow-runner";
import { resolveServerConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import type { EntryAdapter } from "./entry-adapter.js";
import { createExitDriver } from "./exit-driver.js";
import { loadModelList } from "./models.js";
import { runSelfCheck } from "./self-check.js";

/** 装配产物：T13 管理 API 与 T18 入口适配器复用的全部实例 */
export interface AssembledContext {
  /** 平台运行配置（解析后只读） */
  config: ServerConfig;
  /** 平台唯一数据口（platform.db） */
  db: Database;
  /** 入口队列（entry_tasks） */
  entryQueue: TaskQueue;
  /** 出口队列（exit_tasks） */
  exitQueue: TaskQueue;
  /** 业务注册表（业务资料/匹配/出口绑定） */
  registry: BusinessRegistry;
  /** 两桶环境配置（vars/secrets） */
  env: EnvProvider;
  /** 资产注册表（git 物化） */
  assets: AssetRegistry;
  /** 入口事件循环 */
  entryLoop: SchedulerLoop;
  /** 出口事件循环 */
  exitLoop: SchedulerLoop;
}

/** 运行中的平台句柄 */
export interface ServerHandle {
  /** 装配产物（全部模块实例） */
  context: AssembledContext;
  /** 优雅停：管理 API stop → 入口适配器 stop（有则）→ 两循环 stop → db close；幂等 */
  stop(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 装配并启动平台。装配顺序固定（依赖方向即创建顺序），见代码内逐步注释。
 *  envMap 可注入（测试用）；配置/自检失败抛错（退出码归 main 负责） */
export async function bootstrap(overrides?: {
  /** 环境变量映射（缺省 process.env，仅 config.ts 接触） */
  env?: Record<string, string | undefined>;
  /** 入口适配器实例（本任务缺省为空——T18 起由 main 注入真实入口） */
  adapters?: EntryAdapter[];
}): Promise<ServerHandle> {
  // 1. 配置解析（env > {workspace}/config.json > 默认）
  const config = resolveServerConfig(overrides?.env);

  // 2. 日志全局外观（initLogger 自带 logsDir 可建/可写 fail-fast）
  initLogger({
    logsDir: join(config.workspace, "logs"),
    level: config.log_level,
    enabled: config.log_enabled,
  });
  const log = logger.for({ module: "system" });

  // 启动失败清理面：视装配进度逐步填充
  let db: Database | null = null;
  let entryLoop: SchedulerLoop | null = null;
  let exitLoop: SchedulerLoop | null = null;
  let consoleApi: ConsoleApi | null = null;
  const startedAdapters: EntryAdapter[] = [];
  let context: AssembledContext | null = null;

  try {
    // 3. 启动自检（fail-fast，全量收集一次性报出）
    await runSelfCheck(config);

    // 3.5 可选模型全量列表（自检已保证 models.json 可解析且非空，此处必成功）；
    // 不读不记 apiKey——它只属 pi 子进程
    const models = loadModelList(config.pi_agent_dir);

    // 4. system 日志「启动中」（回显关键配置，不含任何 secret）
    log.info("平台启动中", {
      workspace: config.workspace,
      hop_limit: config.hop_limit,
      task_concurrency: config.task_concurrency,
      result_concurrency: config.result_concurrency,
      pi_cli_path: config.pi_cli_path,
      pi_agent_dir: config.pi_agent_dir,
    });

    // 5. 接线（依赖方向即创建顺序）
    db = openDatabase(join(config.workspace, "data", "platform.db"));
    const entryQueue = createTaskQueue(db, "entry_tasks");
    const exitQueue = createTaskQueue(db, "exit_tasks");
    const registry = createBusinessRegistry(db);
    // 两个循环各持专用 ChannelPool（onActivate 每池单注册）
    const entryChannels = createChannelPool(db);
    const exitChannels = createChannelPool(db);
    const channelStore = createChannelStore(db);
    const assets = createAssetRegistry(db, {
      cache_root: join(config.workspace, "cache", "assets"),
      npm_registry: config.npm_registry,
    });
    const envProvider = createEnvProvider(db);
    const loader = createContextLoader({
      registry,
      assets,
      env: envProvider,
      defaults: {
        task_timeout_minutes: config.task_timeout_minutes,
        max_agent_calls: config.max_agent_calls,
      },
    });
    const runner = createWorkflowRunner({ workspaceRoot: config.workspace });
    const agentService = createAgentService({
      pi_cli_path: config.pi_cli_path,
      pi_agent_dir: config.pi_agent_dir,
      pi_env: config.pi_env,
      mapping: channelStore,
    });
    const lifecycle = createLifecycle({
      loader,
      runner,
      agentService,
      workspaceRoot: config.workspace,
      db,
    });
    const exits = createExitRegistry();
    const exitDriver = createExitDriver({ exits, env: envProvider });
    const platformConfig: PlatformConfig = {
      hop_limit: config.hop_limit,
      task_concurrency: config.task_concurrency,
      result_concurrency: config.result_concurrency,
    };
    entryLoop = createEntryLoop({
      queue: entryQueue,
      exitQueue,
      registry,
      channels: entryChannels,
      config: platformConfig,
      driver: lifecycle,
    });
    exitLoop = createExitLoop({
      queue: exitQueue,
      registry,
      channels: exitChannels,
      config: platformConfig,
      driver: exitDriver,
    });

    // 6. 崩溃恢复：processing 残留重置回 pending（start 前的装配纪律）
    const recoveredEntry = entryQueue.recover();
    const recoveredExit = exitQueue.recover();
    log.info("队列崩溃恢复", {
      entry_recovered: recoveredEntry,
      exit_recovered: recoveredExit,
    });

    // 7. 启动两个循环
    entryLoop.start();
    exitLoop.start();

    // 8. 入口适配器逐一 start（本任务缺省为空集——T18 起注入真实入口）
    for (const adapter of overrides?.adapters ?? []) {
      adapter.start({ queue: entryQueue, registry, env: envProvider });
      startedAdapters.push(adapter);
    }

    // 8.5 管理 API（console-api）：建表/首启 admin 注入在 start 内完成；
    // ensureBootstrapAdmin 'missing' 时其内部记 error 日志，不阻断启动。
    // consoleApi 是装配层局部资源（与 EntryAdapter 同列管理），不进 AssembledContext
    const lifecycleStore = createLifecycleStore(db);
    const configView: EffectiveConfigView = {
      workspace: config.workspace,
      log_level: config.log_level,
      log_enabled: config.log_enabled,
      hop_limit: config.hop_limit,
      task_concurrency: config.task_concurrency,
      result_concurrency: config.result_concurrency,
      task_timeout_minutes: config.task_timeout_minutes,
      max_agent_calls: config.max_agent_calls,
      pi_cli_path: config.pi_cli_path,
      pi_agent_dir: config.pi_agent_dir,
      models,
      // MVP 恒 ['pi']；新内核 = 代码新增 + 此处登记
      agents: ["pi"],
    };
    consoleApi = createConsoleApi(
      {
        db,
        registry,
        assets,
        env: envProvider,
        exits,
        entryQueue,
        exitQueue,
        lifecycle: lifecycleStore,
        config: configView,
      },
      {
        port: config.console_port,
        ...(config.bootstrap_admin !== undefined
          ? { bootstrap_admin: config.bootstrap_admin }
          : {}),
        ...(config.console_static_dir !== undefined
          ? { static_dir: config.console_static_dir }
          : {}),
      },
    );
    const consolePort = await consoleApi.start();

    // 9. system 日志「启动完成」
    log.info("平台启动完成", {
      adapters: startedAdapters.length,
      console_port: consolePort,
      ...(config.console_static_dir !== undefined
        ? { static_dir: config.console_static_dir }
        : {}),
    });

    context = {
      config,
      db,
      entryQueue,
      exitQueue,
      registry,
      env: envProvider,
      assets,
      entryLoop,
      exitLoop,
    };
  } catch (err) {
    log.error("平台启动失败", { error: errorMessage(err) });
    // 按装配进度反向清理，不留半启动状态（先关 API 入口，再停适配器/循环）
    if (consoleApi) {
      try {
        await consoleApi.stop();
      } catch {
        // 清理尽力而为，不掩盖启动错误
      }
    }
    for (const adapter of [...startedAdapters].reverse()) {
      try {
        await adapter.stop();
      } catch {
        // 清理尽力而为，不掩盖启动错误
      }
    }
    if (entryLoop) {
      try {
        await entryLoop.stop();
      } catch {
        // 同上
      }
    }
    if (exitLoop) {
      try {
        await exitLoop.stop();
      } catch {
        // 同上
      }
    }
    if (db) {
      try {
        db.close();
      } catch {
        // 同上
      }
    }
    throw err;
  }

  // 优雅停：consoleApi stop（先关 API 入口）→ 入口适配器 stop → 两循环 stop → db close；幂等
  // （到达此处装配必然成功：context/db/两循环/consoleApi 均已就位）
  const assembled = context as AssembledContext;
  const assembledConsoleApi = consoleApi as ConsoleApi;
  let stopPromise: Promise<void> | null = null;
  const adapters = startedAdapters;
  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopPromise = (async () => {
      try {
        await assembledConsoleApi.stop();
      } catch (err) {
        log.error("管理 API 停止失败", { error: errorMessage(err) });
      }
      for (const adapter of adapters) {
        try {
          await adapter.stop();
        } catch (err) {
          log.error("入口适配器停止失败", {
            source: adapter.source,
            error: errorMessage(err),
          });
        }
      }
      await assembled.entryLoop.stop();
      await assembled.exitLoop.stop();
      assembled.db.close();
      log.info("平台已停止");
    })();
    return stopPromise;
  };

  return { context: assembled, stop };
}
