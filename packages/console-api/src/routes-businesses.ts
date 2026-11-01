import type { EventSource } from "@asteriskzuo/agent-contracts";
import type { AssetRegistry } from "@asteriskzuo/agent-asset-registry";
import { logger } from "@asteriskzuo/agent-logger";
import type {
  BusinessMatch,
  BusinessPatch,
  BusinessProfile,
  BusinessRegistry,
  CreateBusinessInput,
  ExitBinding,
} from "@asteriskzuo/agent-registry";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import type { User } from "./accounts.js";
import { validateBusinessWrite } from "./binding-validation.js";
import { assertWebhookPathUnique } from "./binding-validation.js";
import { ApiError } from "./errors.js";
import { assertPlaceholderKeysExist } from "./placeholder-validation.js";
import type {
  BusinessDetail,
  CreateBusinessBody,
  EffectiveConfigView,
  MatchBody,
  PatchBusinessBody,
  RemoveMatchBody,
} from "./dto.js";
import {
  requireNonEmptyString,
  requirePlainObject,
  requireStringArray,
  requireStringRecord,
  sendJson,
  sendNoContent,
} from "./http.js";
import type { Route } from "./router.js";
import type { UpdateSubmitter } from "./updates.js";

// 与 @asteriskzuo/agent-contracts 的 EventSource 联合类型保持同步（contracts 未导出运行时列表）
const EVENT_SOURCES: readonly EventSource[] = [
  "wecom",
  "jira",
  "github",
  "webhook",
  "cron",
  "internal",
  "manual",
];

function assertEventSource(value: unknown, field: string): EventSource {
  if (
    typeof value !== "string" ||
    !(EVENT_SOURCES as readonly string[]).includes(value)
  ) {
    throw new ApiError(
      "invalid_input",
      `${field} 非法: ${String(value)}（允许: ${EVENT_SOURCES.join("/")}）`,
    );
  }
  return value as EventSource;
}

/** 写权限：业务 creator 本人或 admin；业务不存在 → 404 */
function assertWritable(
  registry: BusinessRegistry,
  businessId: string,
  actor: User,
): BusinessProfile {
  const profile = registry.getProfile(businessId);
  if (profile === undefined) {
    throw new ApiError("not_found", `业务不存在: ${businessId}`);
  }
  if (actor.role !== "admin" && profile.creator_id !== actor.user_id) {
    throw new ApiError("forbidden", "仅业务创建者或 admin 可写");
  }
  return profile;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError("invalid_input", `${field} 必须是字符串`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError("invalid_input", `${field} 必须是布尔值`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError("invalid_input", `${field} 必须是数字`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  return requireStringArray(value, field);
}

/** 匹配行 event_type（可选）：缺省/空串/纯空白 → ""（= 通配，接收该 source 全部事件）；
 *  提供了则必须是非空以外的字符串也接受——trim 后使用（trim 后为空同样落 ""） */
function optionalEventType(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ApiError("invalid_input", `${field} 必须是字符串`);
  }
  return value.trim();
}

/** 随建环境配置（POST /api/businesses 的 env 字段）解析为待写入条目；
 *  DTO 层校验：必须是 plain object、键非空、值字符串（键的空白合法性由应用处理器落库时兜底）。
 *  缺省/两桶皆缺 → 空列表（= 现状行为） */
function parseEnvEntries(
  value: unknown,
): Array<{ bucket: "vars" | "secrets"; key: string; value: string }> {
  if (value === undefined) return [];
  const obj = requirePlainObject(value, "env");
  const entries: Array<{
    bucket: "vars" | "secrets";
    key: string;
    value: string;
  }> = [];
  for (const bucket of ["vars", "secrets"] as const) {
    if (obj[bucket] === undefined) continue;
    const record = requireStringRecord(obj[bucket], `env.${bucket}`);
    for (const [key, item] of Object.entries(record)) {
      if (key === "") {
        throw new ApiError(
          "invalid_input",
          `env.${bucket} 的键必须是非空字符串`,
        );
      }
      entries.push({ bucket, key, value: item });
    }
  }
  return entries;
}

/** 出口绑定数组校验（create/patch 共用）：[{tool, config: Record<string,string>}] */
function parseExitBindings(
  value: unknown,
): Array<{ tool: string; config: Record<string, string> }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError("invalid_input", "exit_bindings 必须是数组");
  }
  return value.map((item, index) => {
    const obj = requirePlainObject(item, `exit_bindings[${index}]`);
    return {
      tool: requireNonEmptyString(obj.tool, `exit_bindings[${index}].tool`),
      config: requireStringRecord(
        obj.config ?? {},
        `exit_bindings[${index}].config`,
      ),
    };
  });
}

/** PATCH 白名单：BusinessPatch 同形字段，之外一律 invalid_input */
const PATCH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "business_name",
  "on_failure",
  "exit_bindings",
  "prompt",
  "model",
  "agent_kind",
  "package_asset_id",
  "entry_program",
  "tool_asset_ids",
  "skill_asset_ids",
  "timeout_minutes",
  "max_agent_calls",
]);

/** quota 覆盖字段：undefined = 不动；null = 清除覆盖；数字 = 设置 */
function parseQuotaOverride(
  body: Record<string, unknown>,
  field: "timeout_minutes" | "max_agent_calls",
): number | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError("invalid_input", `${field} 必须是数字或 null`);
  }
  return value;
}

/** 业务路由：读不设限（登录即可）；写 = creator 本人或 admin。
 *  create/patch 提交前做配置期校验（binding-validation）；写操作一律经统一更新队列：
 *  创建 = 空影响集合（立即应用）；patch/删除/匹配行 = 单业务屏障，忙时 202 排队 */
export function businessRoutes(deps: {
  registry: BusinessRegistry;
  assets: AssetRegistry; // 绑定校验：存在性/物化/清单键位检查
  env: EnvProvider; // 绑定校验：私有资产凭据解析（通用层安全桶）
  config: EffectiveConfigView; // 绑定校验：model/agent_kind 可选集合
  updates: UpdateSubmitter; // 统一更新入口
}): Route[] {
  const { registry, updates } = deps;
  const log = logger.for({ module: "console-api" });
  return [
    {
      method: "GET",
      pattern: "/api/businesses",
      handler: (_req, res) => {
        sendJson(res, 200, registry.list());
      },
    },
    {
      method: "POST",
      pattern: "/api/businesses",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as CreateBusinessBody;
        // API 层只强校验 business_name 非空、source 合法（event_type 可选：缺省/空串 = 通配，其余按 registry 缺省）
        const source = assertEventSource(body.source, "source");
        const eventType = optionalEventType(body.event_type, "event_type");
        const input: CreateBusinessInput = {
          business_name: requireNonEmptyString(
            body.business_name,
            "business_name",
          ),
          creator_id: actor.user_id,
          source,
          event_type: eventType,
        };
        const onFailure = optionalBoolean(body.on_failure, "on_failure");
        if (onFailure !== undefined) input.on_failure = onFailure;
        const prompt = optionalString(body.prompt, "prompt");
        if (prompt !== undefined) input.prompt = prompt;
        const model = optionalString(body.model, "model");
        if (model !== undefined) input.model = model;
        const agentKind = optionalString(body.agent_kind, "agent_kind");
        if (agentKind !== undefined) input.agent_kind = agentKind;
        const packageAssetId = optionalString(
          body.package_asset_id,
          "package_asset_id",
        );
        if (packageAssetId !== undefined)
          input.package_asset_id = packageAssetId;
        const entryProgram = optionalString(
          body.entry_program,
          "entry_program",
        );
        if (entryProgram !== undefined) input.entry_program = entryProgram;
        const toolAssetIds = optionalStringArray(
          body.tool_asset_ids,
          "tool_asset_ids",
        );
        if (toolAssetIds !== undefined) input.tool_asset_ids = toolAssetIds;
        const skillAssetIds = optionalStringArray(
          body.skill_asset_ids,
          "skill_asset_ids",
        );
        if (skillAssetIds !== undefined) input.skill_asset_ids = skillAssetIds;
        const timeoutMinutes = optionalNumber(
          body.timeout_minutes,
          "timeout_minutes",
        );
        if (timeoutMinutes !== undefined)
          input.timeout_minutes = timeoutMinutes;
        const maxAgentCalls = optionalNumber(
          body.max_agent_calls,
          "max_agent_calls",
        );
        if (maxAgentCalls !== undefined) input.max_agent_calls = maxAgentCalls;
        const exitBindings = parseExitBindings(body.exit_bindings);
        if (exitBindings !== undefined) input.exit_bindings = exitBindings;
        // 首个匹配行的入口配置（应用处理器落库复用同一解析结果）
        const entryConfig =
          body.entry_config === undefined
            ? undefined
            : requirePlainObject(body.entry_config, "entry_config");
        // 随建环境配置（可选）：解析为待写入条目；应用处理器创建业务后逐条落该业务两桶
        const envEntries = parseEnvEntries(body.env);
        // webhook 行端点 path 全平台唯一（候选行未落库，与全量既有行比对；冲突 → 400）
        if (source === "webhook") {
          assertWebhookPathUnique(registry, entryConfig);
        }

        // 配置期校验：带了任一绑定字段 → 校验生效绑定集合（顺带物化 fail-fast）；
        // model/agent_kind 出现且非空 → 校验 ∈ 可选集合（与绑定无关）
        const touchesBinding =
          body.package_asset_id !== undefined ||
          body.entry_program !== undefined ||
          body.tool_asset_ids !== undefined ||
          body.skill_asset_ids !== undefined;
        validateBusinessWrite(deps, actor, {
          binding: touchesBinding
            ? {
                package_asset_id: input.package_asset_id,
                entry_program: input.entry_program,
                tool_asset_ids: input.tool_asset_ids ?? [],
                skill_asset_ids: input.skill_asset_ids ?? [],
              }
            : undefined,
          model: input.model,
          agent_kind: input.agent_kind,
        });

        // 创建 = 空影响集合命令：立即应用（豁免队首等待），结果 = 新业务资料
        const submission = await updates.submit<BusinessProfile>({
          kind: "business.create",
          payload: {
            input,
            env_entries: envEntries,
            ...(entryConfig !== undefined ? { entry_config: entryConfig } : {}),
          },
          business_ids: [],
          requested_by: actor.user_id,
        });
        log.info("API 创建业务", {
          operator_id: actor.user_id,
          update_id: submission.update_id,
        });
        if (submission.outcome === "applied") {
          sendJson(res, 201, submission.result);
        } else {
          sendJson(res, 202, { accepted: true });
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/businesses/:id",
      handler: (req, res) => {
        const businessId = req.params.id;
        const profile = registry.getProfile(businessId);
        if (profile === undefined) {
          throw new ApiError("not_found", `业务不存在: ${businessId}`);
        }
        const detail: BusinessDetail = {
          profile,
          matches: registry.get(businessId),
          exit_bindings: registry.exitBindings(businessId),
        };
        sendJson(res, 200, detail);
      },
    },
    {
      method: "PATCH",
      pattern: "/api/businesses/:id",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        const profile = assertWritable(registry, businessId, actor);
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as PatchBusinessBody;
        for (const key of Object.keys(body)) {
          if (!PATCH_ALLOWED_KEYS.has(key)) {
            throw new ApiError("invalid_input", `未知字段: ${key}`);
          }
        }
        const patch: BusinessPatch = {};
        if (body.business_name !== undefined) {
          patch.business_name = requireNonEmptyString(
            body.business_name,
            "business_name",
          );
        }
        const onFailure = optionalBoolean(body.on_failure, "on_failure");
        if (onFailure !== undefined) patch.on_failure = onFailure;
        const exitBindings = parseExitBindings(body.exit_bindings);
        if (exitBindings !== undefined) {
          patch.exit_bindings = exitBindings.map((binding): ExitBinding => ({
            business_id: businessId,
            tool: binding.tool,
            config: binding.config,
          }));
        }
        const prompt = optionalString(body.prompt, "prompt");
        if (prompt !== undefined) patch.prompt = prompt;
        const model = optionalString(body.model, "model");
        if (model !== undefined) patch.model = model;
        const agentKind = optionalString(body.agent_kind, "agent_kind");
        if (agentKind !== undefined) patch.agent_kind = agentKind;
        const packageAssetId = optionalString(
          body.package_asset_id,
          "package_asset_id",
        );
        if (packageAssetId !== undefined)
          patch.package_asset_id = packageAssetId;
        const entryProgram = optionalString(
          body.entry_program,
          "entry_program",
        );
        if (entryProgram !== undefined) patch.entry_program = entryProgram;
        const toolAssetIds = optionalStringArray(
          body.tool_asset_ids,
          "tool_asset_ids",
        );
        if (toolAssetIds !== undefined) patch.tool_asset_ids = toolAssetIds;
        const skillAssetIds = optionalStringArray(
          body.skill_asset_ids,
          "skill_asset_ids",
        );
        if (skillAssetIds !== undefined) patch.skill_asset_ids = skillAssetIds;
        const timeoutMinutes = parseQuotaOverride(
          body as Record<string, unknown>,
          "timeout_minutes",
        );
        if (timeoutMinutes !== undefined)
          patch.timeout_minutes = timeoutMinutes;
        const maxAgentCalls = parseQuotaOverride(
          body as Record<string, unknown>,
          "max_agent_calls",
        );
        if (maxAgentCalls !== undefined) patch.max_agent_calls = maxAgentCalls;

        // 配置期校验：patch 出现任一绑定字段 → 校验「既有 profile 与 patch 覆盖合并后」的生效绑定集合；
        // patch 不涉及绑定字段时零校验、零物化（改个 prompt 不应触发 git clone）。
        // model/agent_kind 出现且非空 → 校验 ∈ 可选集合（与绑定无关）。
        // existing 传既有绑定：已下架资产只拦本次新增绑定，已有绑定保留
        const touchesBinding =
          body.package_asset_id !== undefined ||
          body.entry_program !== undefined ||
          body.tool_asset_ids !== undefined ||
          body.skill_asset_ids !== undefined;
        validateBusinessWrite(
          deps,
          actor,
          {
            binding: touchesBinding
              ? {
                  package_asset_id:
                    patch.package_asset_id ?? profile.package_asset_id,
                  entry_program: patch.entry_program ?? profile.entry_program,
                  tool_asset_ids:
                    patch.tool_asset_ids ?? profile.tool_asset_ids,
                  skill_asset_ids:
                    patch.skill_asset_ids ?? profile.skill_asset_ids,
                }
              : undefined,
            model: patch.model,
            agent_kind: patch.agent_kind,
          },
          {
            existing: {
              package_asset_id: profile.package_asset_id,
              entry_program: profile.entry_program,
              tool_asset_ids: profile.tool_asset_ids,
              skill_asset_ids: profile.skill_asset_ids,
            },
          },
        );

        // 占位 key 存在性校验（fail fast）：exit_bindings 出现在 patch 中才校验
        if (exitBindings !== undefined) {
          for (const [index, binding] of exitBindings.entries()) {
            assertPlaceholderKeysExist(
              deps.env,
              businessId,
              binding.config,
              `exit_bindings[${index}].config`,
            );
          }
        }

        // 自定义 Pi 配置的业务：model 不可单独修改（与配置是不可拆分的组合），
        // 必须走 pi-config 验证—确认流程（或先删除自定义配置恢复平台默认）
        if (
          patch.model !== undefined &&
          registry.getPiModels(businessId) !== undefined
        ) {
          throw new ApiError(
            "conflict",
            "该业务使用自定义 Pi 配置：model 只能随 pi-config 验证—确认流程一并修改",
          );
        }

        const submission = await updates.submit({
          kind: "business.patch",
          payload: { business_id: businessId, patch },
          business_ids: [businessId],
          requested_by: actor.user_id,
        });
        log.info("API 更新业务", {
          operator_id: actor.user_id,
          business_id: businessId,
          update_id: submission.update_id,
        });
        if (submission.outcome === "applied") {
          sendNoContent(res);
        } else {
          sendJson(res, 202, { accepted: true });
        }
      },
    },
    {
      method: "DELETE",
      pattern: "/api/businesses/:id",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertWritable(registry, businessId, actor);
        const submission = await updates.submit({
          kind: "business.delete",
          payload: { business_id: businessId },
          business_ids: [businessId],
          requested_by: actor.user_id,
        });
        log.info("API 删除业务", {
          operator_id: actor.user_id,
          business_id: businessId,
          update_id: submission.update_id,
        });
        if (submission.outcome === "applied") {
          sendNoContent(res);
        } else {
          sendJson(res, 202, { accepted: true });
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/businesses/:id/matches",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertWritable(registry, businessId, actor);
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as MatchBody;
        const source = assertEventSource(body.source, "source");
        const eventType = optionalEventType(body.event_type, "event_type");
        const entryConfig =
          body.entry_config === undefined
            ? undefined
            : requirePlainObject(body.entry_config, "entry_config");
        // webhook 行端点 path 全平台唯一（含与本业务既有行比对；冲突 → 400）
        if (source === "webhook") {
          assertWebhookPathUnique(registry, entryConfig);
        }
        // 占位 key 存在性校验（fail fast）：无占位 → 放行
        if (entryConfig !== undefined) {
          assertPlaceholderKeysExist(
            deps.env,
            businessId,
            entryConfig,
            "entry_config",
          );
        }
        const submission = await updates.submit<BusinessMatch[]>({
          kind: "business.match.add",
          payload: {
            business_id: businessId,
            source,
            event_type: eventType,
            ...(entryConfig !== undefined ? { entry_config: entryConfig } : {}),
          },
          business_ids: [businessId],
          requested_by: actor.user_id,
        });
        log.info("API 新增匹配行", {
          operator_id: actor.user_id,
          business_id: businessId,
          source,
          event_type: eventType,
          update_id: submission.update_id,
        });
        if (submission.outcome === "applied") {
          sendJson(res, 201, submission.result);
        } else {
          sendJson(res, 202, { accepted: true });
        }
      },
    },
    {
      method: "DELETE",
      pattern: "/api/businesses/:id/matches",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertWritable(registry, businessId, actor);
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as RemoveMatchBody;
        const source = assertEventSource(body.source, "source");
        const eventType = optionalEventType(body.event_type, "event_type");
        const submission = await updates.submit({
          kind: "business.match.remove",
          payload: { business_id: businessId, source, event_type: eventType },
          business_ids: [businessId],
          requested_by: actor.user_id,
        });
        log.info("API 删除匹配行", {
          operator_id: actor.user_id,
          business_id: businessId,
          source,
          event_type: eventType,
          update_id: submission.update_id,
        });
        if (submission.outcome === "applied") {
          sendNoContent(res);
        } else {
          sendJson(res, 202, { accepted: true });
        }
      },
    },
  ];
}
