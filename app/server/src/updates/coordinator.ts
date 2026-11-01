import { logger } from "@asteriskzuo/agent-logger";
import type { UpdateCommand, UpdateQueue } from "@asteriskzuo/agent-queue";

/** 提交输入：命令类型 + 完整参数 + 受影响业务范围 + 操作者 */
export interface SubmitUpdateCommand {
  /** 命令类型；决定应用处理器（handlers 的键），不序列化函数 */
  kind: string;
  /** JSON 可序列化完整参数；可含 Pi/env secret，禁止进入日志 */
  payload: unknown;
  /** 空数组=创建或无引用资产；单业务为一项、共享资产为多个引用方；all=全局 env/缓存等全业务屏障 */
  business_ids: string[] | "all";
  /** 已认证操作者 user_id，仅用于审计 */
  requested_by: string;
}

export type UpdateSubmission<T> =
  | {
      /** 持久化命令 id；用于系统日志关联，控制台不展示 */
      update_id: string;
      /** 本次请求已等待应用完成 */
      outcome: "applied";
      /** 应用处理器结果；路由用它保持创建详情、资产 meta 等既有响应 */
      result: T;
    }
  | {
      /** 持久化命令 id；用于系统日志关联，控制台不展示 */
      update_id: string;
      /** 已持久化但仍被活动执行阻塞，稍后自然空闲时应用；没有应用结果 */
      outcome: "accepted";
    };

export interface UpdateCoordinator {
  /** 无受影响活动执行时等待可用应用窗口并完成；仍被活动执行阻塞时只等待持久化并返回 accepted。
   *  立即应用失败（处理器抛错）时同步抛出该错误 */
  submit<T>(command: SubmitUpdateCommand): Promise<UpdateSubmission<T>>;
  /** 包裹 scheduler 业务执行；fn 抛错也必须在 finally 释放活动计数并触发空闲调度 */
  run<T>(business_id: string, fn: () => Promise<T>): Promise<T>;
  /** 启动循环前把 processing 恢复为 pending 并驱动队列；失败项不自动重试 */
  recover(): Promise<void>;
  /** 停止接受新调度；未应用命令保留到下次启动；等待进行中的应用窗口落定 */
  stop(): Promise<void>;
}

/** 应用处理器：payload 为落库的完整参数；返回值为 applied.result（路由响应用）。
 *  处理器抛错 = 应用失败（命令标 failed，错误须已脱敏） */
export type UpdateHandler = (payload: unknown) => unknown | Promise<unknown>;

export interface UpdateCoordinatorDeps {
  queue: UpdateQueue;
  /** kind → 应用处理器；未注册 kind 按失败处理（不丢队列） */
  handlers: Record<string, UpdateHandler>;
  /** 可选：进入应用窗口前重算受影响业务（如共享资产引用方）；缺省用落库的 business_ids */
  resolveScope?: (command: UpdateCommand) => string[] | "all";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 统一更新协调器：所有影响业务执行的在线配置/资产写命令的唯一入口。
 *  持久化/FIFO/崩溃恢复归 UpdateQueue；本类负责闲时判断、应用屏障与命令调度。
 *  纪律：严格全局 FIFO（队首未空闲则原地等待，有影响集合的后续命令不插队）；
 *  空影响集合命令豁免队首等待，但不得在全平台应用窗口进行中应用。 */
export function createUpdateCoordinator(
  deps: UpdateCoordinatorDeps,
): UpdateCoordinator {
  const log = logger.for({ module: "update-coordinator" });
  const active = new Map<string, number>(); // business_id → 活动执行数
  const applyingBusinesses = new Set<string>(); // 应用窗口中的业务屏障
  let platformApplying = false; // 全平台应用窗口标记
  let stopped = false;
  /** 正在应用的命令 id（submit 据此判断本次请求是否等待应用结果） */
  const applyingIds = new Set<string>();
  /** 等待中的 submit 终态（applied 路径用）；accepted 后移除 */
  const terminals = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (err: unknown) => void }
  >();
  /** 屏障释放时唤醒等待中的 run */
  const barrierWaiters = new Set<() => void>();
  let currentApply: Promise<void> | null = null;

  const isScopeIdle = (scope: string[] | "all"): boolean => {
    if (scope === "all") {
      for (const n of active.values()) if (n > 0) return false;
      return true;
    }
    return scope.every(
      (id) => (active.get(id) ?? 0) === 0 && !applyingBusinesses.has(id),
    );
  };

  const isEmptyScope = (scope: string[] | "all"): boolean =>
    scope !== "all" && scope.length === 0;

  /** 同步临界段：为命令设置应用屏障（调用前已确认空闲）。返回最终屏障范围 */
  const acquireBarrier = (scope: string[] | "all"): string[] | "all" => {
    if (scope === "all") {
      platformApplying = true;
      return scope;
    }
    for (const id of scope) applyingBusinesses.add(id);
    return scope;
  };

  const releaseBarrier = (scope: string[] | "all"): void => {
    if (scope === "all") {
      platformApplying = false;
    } else {
      for (const id of scope) applyingBusinesses.delete(id);
    }
    // 唤醒等待屏障的新 run；它们自行重新检查屏障条件
    for (const wake of barrierWaiters) wake();
  };

  /** 应用一条命令：begin → handler → complete/fail → 释放屏障 → 推进队列。
   *  清理挂 promise.finally（微任务）而非 IIFE 内 finally：同步完成的处理器会让 IIFE
   *  在当前同步段内跑完，若 finally 内置会在 currentApply 赋值前就把它清回 null */
  const applyCommand = (
    cmd: UpdateCommand,
    barrierScope: string[] | "all",
  ): Promise<void> => {
    applyingIds.add(cmd.update_id);
    const promise = (async () => {
      try {
        const handler = deps.handlers[cmd.kind];
        if (!handler) throw new Error(`未知更新命令 kind: ${cmd.kind}`);
        const result = await handler(cmd.payload);
        deps.queue.complete(cmd.update_id);
        log.info("更新命令已应用", {
          update_id: cmd.update_id,
          kind: cmd.kind,
          requested_by: cmd.requested_by,
        });
        // 业务删除已生效：同业务排在它之后的 pending 命令不再有归宿，全部标 failed
        if (cmd.kind === "business.delete") {
          const businessId = (cmd.payload as { business_id?: unknown })
            .business_id;
          if (typeof businessId === "string") {
            const n = deps.queue.failPendingFor(
              businessId,
              cmd.seq,
              "业务已删除",
            );
            if (n > 0) {
              log.info("业务删除后清理后续 pending 命令", {
                update_id: cmd.update_id,
                business_id: businessId,
                failed_count: n,
              });
            }
          }
        }
        terminals.get(cmd.update_id)?.resolve(result);
      } catch (err) {
        // 处理器错误应已脱敏；这里只记有界 message，绝不打印 payload
        const message = errMessage(err);
        deps.queue.fail(cmd.update_id, message);
        log.error("更新命令应用失败", {
          update_id: cmd.update_id,
          kind: cmd.kind,
          error: message,
        });
        terminals.get(cmd.update_id)?.reject(err);
      }
    })();
    currentApply = promise;
    void promise.finally(() => {
      terminals.delete(cmd.update_id);
      applyingIds.delete(cmd.update_id);
      releaseBarrier(barrierScope);
      currentApply = null;
      schedule(); // 同步推进：下一条队首/豁免命令在同一轮继续
    });
    return promise;
  };

  /** 同步调度：无应用窗口时评估队首；队首未空闲则尝试空影响豁免命令。
   *  单飞：一个时刻至多一个应用窗口 */
  const schedule = (): void => {
    if (stopped || currentApply !== null || platformApplying) return;
    const head = deps.queue.peek();
    if (head !== null) {
      // 应用前重算受影响业务（新增引用方也纳入屏障）
      const scope = deps.resolveScope?.(head) ?? head.business_ids;
      if (isEmptyScope(scope)) {
        if (platformApplying) return;
        deps.queue.begin(head.update_id);
        void applyCommand(head, []);
        return;
      }
      if (isScopeIdle(scope)) {
        const barrier = acquireBarrier(scope);
        deps.queue.begin(head.update_id);
        void applyCommand(head, barrier);
        return;
      }
      // 队首未空闲：原地等待（严格 FIFO），但空影响豁免命令可越过
    }
    const emptyNext = deps.queue.peekNextEmptyScope();
    if (emptyNext !== null && emptyNext.update_id !== head?.update_id) {
      deps.queue.begin(emptyNext.update_id);
      void applyCommand(emptyNext, []);
    }
  };

  return {
    async submit<T>(
      command: SubmitUpdateCommand,
    ): Promise<UpdateSubmission<T>> {
      if (stopped) {
        throw new Error("UpdateCoordinator 已停止，不再接受更新命令");
      }
      // delete 已接受的业务拒新写（409 由路由前缀映射）；delete 自身不受限。先于入队
      if (
        command.kind !== "business.delete" &&
        command.business_ids !== "all"
      ) {
        for (const businessId of command.business_ids) {
          if (deps.queue.hasPendingKindFor("business.delete", businessId)) {
            throw new Error(
              `business_deleting: ${businessId}（删除已排队，拒绝对其写入）`,
            );
          }
        }
      }
      const record = deps.queue.enqueue(command);
      const terminal = new Promise<unknown>((resolve, reject) => {
        terminals.set(record.update_id, { resolve, reject });
      });
      // 同步调度：若本条可立即应用，此刻已进入应用窗口（barrier 在第一个 await 前设置）。
      // 注意：同步完成的处理器在 schedule() 返回时已脱离 applyingIds（finally 已跑），
      // 因此判定依据用落库状态而非内存集合：非 pending = 已被应用窗口处理（含已失败）
      schedule();
      const recordAfter = deps.queue.get(record.update_id);
      const started = recordAfter !== null && recordAfter.status !== "pending";
      const emptyScope = isEmptyScope(command.business_ids);
      if (emptyScope || started) {
        // 空影响集合：只可能被进行中的窗口短暂阻塞，等待其落定后本轮即应用；
        // 其余：本条已在应用窗口中。立即应用失败 = 同步抛错（路由按现有错误映射）
        const result = await terminal;
        return {
          update_id: record.update_id,
          outcome: "applied",
          result: result as T,
        };
      }
      // 仍被活动执行阻塞：命令已持久化，稍后自然空闲时由调度应用
      terminals.delete(record.update_id);
      void terminal.catch(() => {}); // 防未处理拒绝（后台应用失败只写系统日志）
      return { update_id: record.update_id, outcome: "accepted" };
    },

    async run<T>(business_id: string, fn: () => Promise<T>): Promise<T> {
      // applying 屏障等待：不登记活动、不占并发名额
      while (platformApplying || applyingBusinesses.has(business_id)) {
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            barrierWaiters.delete(wake);
            resolve();
          };
          barrierWaiters.add(wake);
        });
      }
      // 同步登记活动执行（先于任何 await，更新窗口无法穿过）
      active.set(business_id, (active.get(business_id) ?? 0) + 1);
      try {
        return await fn();
      } finally {
        const remaining = (active.get(business_id) ?? 1) - 1;
        if (remaining <= 0) active.delete(business_id);
        else active.set(business_id, remaining);
        schedule(); // 最后一个活动 run 结束可能让队首变为可应用
      }
    },

    async recover(): Promise<void> {
      const recovered = deps.queue.recover();
      if (recovered > 0) {
        log.info("更新队列崩溃恢复", { recovered });
      }
      schedule();
    },

    async stop(): Promise<void> {
      stopped = true;
      // 进行中的应用窗口不等打断：等它落定，之后不再调度
      while (currentApply !== null) {
        await currentApply;
      }
    },
  };
}
