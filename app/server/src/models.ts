import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** provider 名不得为纯整数形态（JS 对象整数键会被重排到最前，
 *  破坏"第一个 provider 的第一个模型"的默认模型派生语义） */
const INTEGER_LIKE = /^\d+$/;

/** 业务自定义 Pi 配置的结构校验（spec 2026-11-01 §9.2）：
 *  1. 顶层为非数组 object，providers 为非空 object；provider 名非空且**不得为纯整数形态**，配置为 object；
 *  2. baseUrl/api/apiKey 如出现必须为字符串（缺省可继承 Pi 内置 provider 元数据）；
 *  3. **models 必须出现**、为非空数组；每项为 object 且含非空 id；同 provider 内 id 不重复
 *     （不再允许简写形态——遍历验证与运行时枚举都依赖显式声明）；
 *  4. 未知顶层/provider/model 字段全部保留（不重建、不深合并、不自动修正）；
 *  5. 不做单 model 归属校验（被"全量枚举 + 逐个真实探针"取代）。
 *  错误只含字段路径，不含配置值。通过则原样返回配置对象 */
export function validateBusinessPiModels(
  value: unknown,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("业务 Pi 配置必须是 JSON object");
  }
  if (
    !isPlainObject(value.providers) ||
    Object.keys(value.providers).length === 0
  ) {
    throw new Error("业务 Pi 配置 providers 必须是非空对象");
  }
  const problems: string[] = [];
  for (const [provider, providerConfig] of Object.entries(value.providers)) {
    const providerPath = `providers.${provider}`;
    if (provider.trim() === "") {
      problems.push("provider 名不能为空");
      continue;
    }
    if (INTEGER_LIKE.test(provider)) {
      problems.push(`provider 名不得为纯整数形态: ${provider}`);
      continue;
    }
    if (!isPlainObject(providerConfig)) {
      problems.push(`${providerPath} 必须是对象`);
      continue;
    }
    for (const field of ["baseUrl", "api", "apiKey"] as const) {
      const fieldValue = providerConfig[field];
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        problems.push(`${providerPath}.${field} 必须是字符串`);
      }
    }
    if (
      !Array.isArray(providerConfig.models) ||
      providerConfig.models.length === 0
    ) {
      problems.push(`${providerPath}.models 必须是非空数组`);
      continue;
    }
    const ids = new Set<string>();
    for (const [index, item] of providerConfig.models.entries()) {
      const modelPath = `${providerPath}.models[${index}]`;
      if (!isPlainObject(item)) {
        problems.push(`${modelPath} 必须是对象`);
        continue;
      }
      if (!isNonEmptyString(item.id)) {
        problems.push(`${modelPath}.id 必须是非空字符串`);
        continue;
      }
      if (ids.has(item.id)) {
        problems.push(`${modelPath}.id 重复`);
      }
      ids.add(item.id);
    }
  }
  if (problems.length > 0) {
    throw new Error(`业务 Pi 配置非法:\n- ${problems.join("\n- ")}`);
  }
  return value;
}

/** 枚举配置中全部 provider/id（按声明顺序；调用方纪律：config 必须先过 validateBusinessPiModels） */
export function enumerateModels(config: Record<string, unknown>): string[] {
  const providers = (
    config as { providers: Record<string, { models: Array<{ id: string }> }> }
  ).providers;
  const out: string[] = [];
  for (const [provider, providerConfig] of Object.entries(providers)) {
    for (const model of providerConfig.models) {
      out.push(`${provider}/${model.id}`);
    }
  }
  return out;
}

/** 派生默认模型 = 第一个 provider 的第一个模型 id（调用方纪律：config 必须先过 validateBusinessPiModels） */
export function deriveDefaultModel(config: Record<string, unknown>): string {
  return enumerateModels(config)[0] as string;
}

/** 原子生成业务自定义 Pi 派生文件 <businessPiRoot>/agent/models.json（目录 0700、文件 0600）。
 *  返回派生 agent 目录绝对路径；写失败抛错（调用方让该 run 失败，不消费旧文件、不回退全局）。
 *  调用方纪律：config 必须先过 validateBusinessPiModels */
export function prepareBusinessPiModels(
  businessPiRoot: string,
  config: Record<string, unknown>,
): string {
  const agentDir = join(businessPiRoot, "agent");
  const path = join(agentDir, "models.json");
  const tempPath = join(
    agentDir,
    `.models.json.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    chmodSync(agentDir, 0o700);
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tempPath, path);
    return agentDir;
  } catch (err) {
    throw new Error(`业务 models.json 生成失败: ${path}: ${errorMessage(err)}`);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 清理失败不覆盖生成结果或原始错误
    }
  }
}
