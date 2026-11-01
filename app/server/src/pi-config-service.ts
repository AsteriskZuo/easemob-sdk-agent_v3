import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@asteriskzuo/agent-console-api";
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
import { prepareBusinessPiModels, validateBusinessPiModels } from "./models.js";
import type {
  UpdateCoordinator,
  UpdateSubmission,
} from "./updates/coordinator.js";

/** 验证凭据 TTL：固定 10 分钟（不做成配置项）；过期/重启后必须重新验证 */
const VALIDATION_TTL_MS = 10 * 60 * 1000;
/** 探针超时：固定 15 秒（真实模型调用的有界等待） */
const PROBE_TIMEOUT_MS = 15_000;

/** 管理读面视图：当前生效配置（config 为递归脱敏对象，绝不含明文敏感字段） */
export interface BusinessPiConfigView {
  configured: boolean;
  model: string;
  config?: Record<string, unknown>;
}

export interface PiValidateResult {
  /** 一次性、短时效确认凭据；不是更新队列 id */
  validation_id: string;
  /** 到首个真实生成事件或完整非流式响应的耗时 */
  duration_ms: number;
}

/** 业务 Pi 配置服务：在线验证（真实模型调用）→ 用户确认 → 经统一更新队列生效 */
export interface BusinessPiConfigService {
  /** 当前生效配置的脱敏读面（业务不存在的判定归路由） */
  getConfig(business_id: string): BusinessPiConfigView;
  /** 结构校验 → 真实探针验证；失败抛 400（可修正错误，已脱敏）；成功返回一次性凭据 */
  validate(
    business_id: string,
    operator_id: string,
    model: string,
    config: Record<string, unknown>,
  ): Promise<PiValidateResult>;
  /** 按凭据确认同一份已验证配置，形成持久化更新命令（pi.set，单业务屏障） */
  confirm(
    business_id: string,
    operator_id: string,
    validation_id: string,
  ): Promise<UpdateSubmission<unknown>>;
  /** 删除自定义配置并切回合法全局模型（pi.remove，单业务屏障） */
  remove(
    business_id: string,
    operator_id: string,
    model: string,
  ): Promise<UpdateSubmission<unknown>>;
  /** 服务关闭：取消在飞探针、清空验证记录并清理验证目录 */
  close(): void;
}

/** 一次未确认的验证（只存内存；重启即失效） */
interface ValidationRecord {
  business_id: string;
  operator_id: string;
  model: string;
  /** 原始候选配置（含 secret）：只在内存与短期目录，不回显、不进日志 */
  config: Record<string, unknown>;
  expiresAt: number;
  /** 验证短期目录（cache/pi/validations/{validation_id}） */
  dir: string;
}

export function createBusinessPiConfigService(deps: {
  registry: BusinessRegistry;
  updates: UpdateCoordinator;
  workspace: string;
  pi_cli_path: string;
  pi_env: Record<string, string>;
  /** 全局可选模型（provider/id 列表，来自启动生成的全局 models.json） */
  globalModels: string[];
}): BusinessPiConfigService {
  const log = logger.for({ module: "pi-config-service" });
  const records = new Map<string, ValidationRecord>();
  /** 每业务同时只保留一个有效验证（新验证取代旧验证） */
  const byBusiness = new Map<string, string>();
  /** 在飞探针取消器（按业务；新验证先取消旧探针） */
  const inFlight = new Map<string, AbortController>();

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

  /** 作废并清理一条验证记录（目录 + 索引） */
  const discard = (validationId: string): void => {
    const record = records.get(validationId);
    if (record === undefined) return;
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

    async validate(businessId, operatorId, model, config) {
      // 1. 结构校验（含 model 归属）；错误只含字段路径
      try {
        validateBusinessPiModels(config, model);
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
      inFlight.get(businessId)?.abort();
      const previous = byBusiness.get(businessId);
      if (previous !== undefined) discard(previous);

      const validationId = `val_${newUlid()}`;
      const dir = join(validationsRoot(businessId), validationId);
      const secrets = collectPiModelsSecrets(config);
      // 验证期间把敏感真值注册进平台日志外观（probe 进程错误文本可能带凭据）
      try {
        logger.addSecrets(secrets);
      } catch {
        // 未 initLogger（测试）静默跳过
      }
      const controller = new AbortController();
      inFlight.set(businessId, controller);
      try {
        const agentDir = prepareBusinessPiModels(dir, config);
        const result = await probePiModel({
          pi_cli_path: deps.pi_cli_path,
          pi_agent_dir: agentDir,
          model,
          env: deps.pi_env,
          cwd: dir,
          timeout_ms: PROBE_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (!result.ok) {
          removeDir(dir);
          const detail = maskPiText(result.detail ?? "", secrets);
          throw new ApiError(
            "invalid_input",
            `配置验证失败（${result.failure_kind ?? "unknown"}）：${detail || "未观察到真实模型生成"}`,
          );
        }
        records.set(validationId, {
          business_id: businessId,
          operator_id: operatorId,
          model,
          config,
          expiresAt: Date.now() + VALIDATION_TTL_MS,
          dir,
        });
        byBusiness.set(businessId, validationId);
        log.info("Pi 配置验证成功", {
          business_id: businessId,
          model,
          duration_ms: result.duration_ms,
        });
        return {
          validation_id: validationId,
          duration_ms: result.duration_ms,
        };
      } finally {
        inFlight.delete(businessId);
      }
    },

    async confirm(businessId, operatorId, validationId) {
      const record = records.get(validationId);
      if (record === undefined || record.expiresAt < Date.now()) {
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
      // 确认只按凭据取服务端保存的同一份 config/model，不接收另一份
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

    async remove(businessId, operatorId, model) {
      if (!deps.globalModels.includes(model)) {
        throw new ApiError(
          "invalid_input",
          `回退模型必须是当前全局可选模型: ${model}（可选: ${deps.globalModels.join(", ") || "无"}）`,
        );
      }
      return deps.updates.submit({
        kind: "pi.remove",
        payload: { business_id: businessId, model },
        business_ids: [businessId],
        requested_by: operatorId,
      });
    },

    close() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      for (const validationId of [...records.keys()]) discard(validationId);
    },
  };
}
