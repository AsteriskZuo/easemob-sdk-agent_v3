import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@asteriskzuo/agent-console-api";
import type {
  PiModelValidationItem,
  PiValidationStatus,
} from "@asteriskzuo/agent-console-api";
import { newUlid } from "@asteriskzuo/agent-contracts";
import {
  collectPiModelsSecrets,
  findPiMaskPlaceholder,
  logger,
  maskPiModelsConfig,
  maskPiText,
} from "@asteriskzuo/agent-logger";
import { probePiModel } from "@asteriskzuo/agent-pi-probe";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import {
  deriveDefaultModel,
  enumerateModels,
  prepareBusinessPiModels,
  validateBusinessPiModels,
} from "./models.js";
import type {
  UpdateCoordinator,
  UpdateSubmission,
} from "./updates/coordinator.js";

/** 确认凭据 TTL：固定 10 分钟（从 done 起算；不做成配置项）；过期/重启后必须重新验证 */
const VALIDATION_TTL_MS = 10 * 60 * 1000;
/** 单模型探针超时：内部常量 30 秒（暂定值，待真实运行数据校准；
 *  本地模型冷启动可能较慢，未来可能按模型差异化——spec 2026-11-01 §10 已记录） */
const PROBE_TIMEOUT_MS = 30_000;
/** 前端轮询间隔建议值（写入注释供 console 对齐；服务端不强制） */
export const VALIDATION_POLL_INTERVAL_MS = 2_000;

/** 管理读面视图：当前生效配置（config 为递归脱敏对象，绝不含明文敏感字段） */
export interface BusinessPiConfigView {
  configured: boolean;
  model: string;
  config?: Record<string, unknown>;
}

/** 业务 Pi 配置服务：异步在线验证（提交 → 后台串行真实探针 → 轮询）→ 用户确认 → 经统一更新队列生效 */
export interface BusinessPiConfigService {
  /** 当前生效配置的脱敏读面（业务不存在的判定归路由） */
  getConfig(business_id: string): BusinessPiConfigView;
  /** 同步结构/掩码校验（失败抛 400，只含字段路径）→ 创建验证记录、后台开始串行探针 →
   *  立即返回凭据与模型总数。每业务同时只保留一个验证（新提交取消在飞探针并取代旧记录） */
  validate(
    business_id: string,
    operator_id: string,
    config: Record<string, unknown>,
  ): { validation_id: string; total: number };
  /** 查询验证进度/结果；未知/过期/重启 → 抛 not_found（前端提示重新验证） */
  getValidation(business_id: string, validation_id: string): PiValidationStatus;
  /** 按凭据确认同一份已验证配置（要求 done 且全部通过），形成持久化更新命令（pi.set，单业务屏障） */
  confirm(
    business_id: string,
    operator_id: string,
    validation_id: string,
  ): Promise<UpdateSubmission<unknown>>;
  /** 删除自定义配置（pi.remove，单业务屏障）；生效后业务回到未配置状态（model=''） */
  remove(
    business_id: string,
    operator_id: string,
  ): Promise<UpdateSubmission<unknown>>;
  /** 服务关闭：取消在飞探针、清空验证记录并清理验证目录 */
  close(): void;
}

/** 一次验证的内存记录（只存内存；重启即失效） */
interface ValidationRecord {
  business_id: string;
  operator_id: string;
  /** 原始候选配置（含 secret）：只在内存与短期目录，不回显、不进日志 */
  config: Record<string, unknown>;
  /** 派生默认模型（第一个 provider 的第一个模型；confirm 随配置同一写操作落库） */
  model: string;
  /** 待验证模型总数（声明顺序） */
  total: number;
  /** 已完成结果前缀（声明顺序逐个追加） */
  results: PiModelValidationItem[];
  status: "running" | "done" | "failed";
  /** done 时计算：全部通过才有确认资格 */
  all_passed?: boolean;
  /** status=failed 的原因（进程级故障，脱敏） */
  error?: string;
  /** done/failed 时间点（TTL 起点） */
  expiresAt?: number;
  /** 验证短期目录（cache/pi/validations/{validation_id}） */
  dir: string;
  /** 本次验证的串行探针取消器（新验证/关闭时 abort） */
  controller: AbortController;
}

export function createBusinessPiConfigService(deps: {
  registry: BusinessRegistry;
  updates: UpdateCoordinator;
  workspace: string;
  pi_cli_path: string;
  pi_env: Record<string, string>;
}): BusinessPiConfigService {
  const log = logger.for({ module: "pi-config-service" });
  const records = new Map<string, ValidationRecord>();
  /** 每业务同时只保留一个有效验证（新验证取代旧验证） */
  const byBusiness = new Map<string, string>();

  const validationsRoot = (businessId: string): string =>
    join(
      deps.workspace,
      "businesses",
      businessId,
      "cache",
      "pi",
      "validations",
    );

  const removeDir = (dir: string): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断流程（目录残留不影响正确性，重启时统一清）
    }
  };

  /** 作废并清理一条验证记录（取消在飞探针 + 目录 + 索引） */
  const discard = (validationId: string): void => {
    const record = records.get(validationId);
    if (record === undefined) return;
    record.controller.abort();
    records.delete(validationId);
    if (byBusiness.get(record.business_id) === validationId) {
      byBusiness.delete(record.business_id);
    }
    removeDir(record.dir);
  };

  // 启动即清理所有业务的 validations 残留（服务重启后未确认验证一律失效）
  const businessesRoot = join(deps.workspace, "businesses");
  if (existsSync(businessesRoot)) {
    for (const entry of readdirSync(businessesRoot)) {
      const dir = join(businessesRoot, entry, "cache", "pi", "validations");
      if (existsSync(dir)) removeDir(dir);
    }
  }

  /** 后台串行探针：逐个真实调用；任一失败不中断；被取代（abort）时静默退出不标终态 */
  const runProbes = (
    record: ValidationRecord,
    models: string[],
    agentDir: string,
    secrets: string[],
  ): void => {
    void (async () => {
      for (const model of models) {
        if (record.controller.signal.aborted) return;
        const result = await probePiModel({
          pi_cli_path: deps.pi_cli_path,
          pi_agent_dir: agentDir,
          model,
          env: deps.pi_env,
          cwd: record.dir,
          timeout_ms: PROBE_TIMEOUT_MS,
          signal: record.controller.signal,
        });
        if (record.controller.signal.aborted) return;
        if (result.ok) {
          record.results.push({
            model,
            ok: true,
            duration_ms: result.duration_ms,
          });
        } else {
          const detail = maskPiText(result.detail ?? "", secrets);
          record.results.push({
            model,
            ok: false,
            duration_ms: result.duration_ms,
            error: `${result.failure_kind ?? "unknown"}: ${detail || "未观察到真实模型生成"}`,
          });
        }
      }
      record.status = "done";
      record.all_passed = record.results.every((item) => item.ok);
      record.expiresAt = Date.now() + VALIDATION_TTL_MS;
      log.info("Pi 配置验证完成", {
        business_id: record.business_id,
        total: record.total,
        all_passed: record.all_passed,
      });
    })().catch((err: unknown) => {
      // 进程级故障（probe 实现抛错而非返回 ok:false）
      if (record.controller.signal.aborted) return;
      record.status = "failed";
      record.error = maskPiText(
        err instanceof Error ? err.message : String(err),
        secrets,
      );
      record.expiresAt = Date.now() + VALIDATION_TTL_MS;
      log.warn("Pi 配置验证进程级失败", {
        business_id: record.business_id,
        error: record.error,
      });
    });
  };

  return {
    getConfig(businessId) {
      const profile = deps.registry.getProfile(businessId);
      const piModels = deps.registry.getPiModels(businessId);
      const view: BusinessPiConfigView = {
        configured: piModels !== undefined,
        model: profile?.model ?? "",
      };
      if (piModels !== undefined) {
        view.config = maskPiModelsConfig(piModels);
      }
      return view;
    },

    validate(businessId, operatorId, config) {
      // 1. 结构校验（spec §9.2：显式 models 强制、provider 名禁纯整数等）；错误只含字段路径
      try {
        validateBusinessPiModels(config);
      } catch (err) {
        throw new ApiError(
          "invalid_input",
          err instanceof Error ? err.message : String(err),
        );
      }
      // 2. 掩码占位符拒绝：敏感字段必须重新填写，绝不把掩码当真值
      const placeholderPath = findPiMaskPlaceholder(config);
      if (placeholderPath !== undefined) {
        throw new ApiError(
          "invalid_input",
          `敏感字段需重新填写（当前为掩码占位符）: ${placeholderPath}`,
        );
      }
      // 3. 取代旧验证：取消在飞探针、作废旧凭据、清理旧目录
      const previous = byBusiness.get(businessId);
      if (previous !== undefined) discard(previous);

      // 4. 派生与枚举（配置已过结构校验）；候选配置整体一次原子写入验证目录
      const models = enumerateModels(config);
      const validationId = `val_${newUlid()}`;
      const dir = join(validationsRoot(businessId), validationId);
      const secrets = collectPiModelsSecrets(config);
      // 验证期间把敏感真值注册进平台日志外观（probe 进程错误文本可能带凭据）
      try {
        logger.addSecrets(secrets);
      } catch {
        // 未 initLogger（测试）静默跳过
      }
      const agentDir = prepareBusinessPiModels(dir, config);
      const record: ValidationRecord = {
        business_id: businessId,
        operator_id: operatorId,
        config,
        model: deriveDefaultModel(config),
        total: models.length,
        results: [],
        status: "running",
        dir,
        controller: new AbortController(),
      };
      records.set(validationId, record);
      byBusiness.set(businessId, validationId);
      log.info("Pi 配置验证已提交", {
        business_id: businessId,
        total: record.total,
      });
      // 5. 后台串行探针（不阻塞请求——HTTP 超时硬化后同步等待必然被掐断）
      runProbes(record, models, agentDir, secrets);
      return { validation_id: validationId, total: record.total };
    },

    getValidation(businessId, validationId) {
      const record = records.get(validationId);
      // 未知 id 或跨业务查询：直接 404，无副作用（不 discard——跨业务探测不得销毁他人记录）
      if (record === undefined || record.business_id !== businessId) {
        throw new ApiError("not_found", "验证不存在或已过期，请重新验证");
      }
      // 过期：作废清理后 404
      if (record.expiresAt !== undefined && record.expiresAt < Date.now()) {
        discard(validationId);
        throw new ApiError("not_found", "验证不存在或已过期，请重新验证");
      }
      if (record.status === "running") {
        return {
          status: "running",
          total: record.total,
          results: [...record.results],
        };
      }
      if (record.status === "failed") {
        return { status: "failed", error: record.error ?? "未知错误" };
      }
      return {
        status: "done",
        all_passed: record.all_passed === true,
        results: [...record.results],
        ...(record.all_passed === true ? { default_model: record.model } : {}),
      };
    },

    async confirm(businessId, operatorId, validationId) {
      const record = records.get(validationId);
      if (
        record === undefined ||
        (record.expiresAt !== undefined && record.expiresAt < Date.now())
      ) {
        discard(validationId);
        throw new ApiError(
          "conflict",
          "validation_id 无效或已过期，请重新验证",
        );
      }
      if (
        record.business_id !== businessId ||
        record.operator_id !== operatorId
      ) {
        throw new ApiError("conflict", "validation_id 不属于该业务/操作者");
      }
      if (record.status === "running") {
        throw new ApiError("conflict", "验证尚未完成，请等待全部模型验证结束");
      }
      if (record.status === "failed") {
        throw new ApiError(
          "conflict",
          `验证进程失败：${record.error ?? "未知错误"}`,
        );
      }
      if (record.all_passed !== true) {
        throw new ApiError(
          "conflict",
          "存在验证失败的模型，无法保存；请修正或移除后重新验证",
        );
      }
      // 确认只按凭据取服务端保存的同一份 config/model（派生默认模型），不接收另一份
      const submission = await deps.updates.submit({
        kind: "pi.set",
        payload: {
          business_id: businessId,
          config: record.config,
          model: record.model,
        },
        business_ids: [businessId],
        requested_by: operatorId,
      });
      discard(validationId);
      return submission;
    },

    remove(businessId, operatorId) {
      return deps.updates.submit({
        kind: "pi.remove",
        payload: { business_id: businessId },
        business_ids: [businessId],
        requested_by: operatorId,
      });
    },

    close() {
      for (const id of [...records.keys()]) discard(id);
    },
  };
}
