import type { EventSource } from "@asterisk/agent-contracts";
import type { AssetRegistry } from "@asterisk/agent-asset-registry";
import { logger } from "@asterisk/agent-logger";
import type {
  BusinessPatch,
  BusinessProfile,
  BusinessRegistry,
  CreateBusinessInput,
  ExitBinding,
} from "@asterisk/agent-registry";
import type { EnvProvider } from "@asterisk/agent-runtime";
import type { User } from "./accounts.js";
import { validateBusinessWrite } from "./binding-validation.js";
import { assertWebhookPathUnique } from "./binding-validation.js";
import { ApiError } from "./errors.js";
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

// 与 @asterisk/agent-contracts 的 EventSource 联合类型保持同步（contracts 未导出运行时列表）
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
 *  create/patch 落库前做配置期校验（binding-validation）：不涉及绑定字段的 patch 零校验零物化 */
export function businessRoutes(deps: {
  registry: BusinessRegistry;
  assets: AssetRegistry; // 绑定校验：存在性/物化/清单键位检查
  env: EnvProvider; // 绑定校验：私有资产凭据解析（通用层安全桶）
  config: EffectiveConfigView; // 绑定校验：model/agent_kind 可选集合
}): Route[] {
  const { registry } = deps;
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
      handler: (req, res) => {
        const actor = req.actor as User;
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as CreateBusinessBody;
        // API 层只强校验 business_name 非空、source 合法、event_type 非空（其余按 registry 缺省）
        const source = assertEventSource(body.source, "source");
        const eventType = requireNonEmptyString(body.event_type, "event_type");
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
        // 首个匹配行的入口配置提前解析（webhook 查重与落库复用同一解析结果）
        const entryConfig =
          body.entry_config === undefined
            ? undefined
            : requirePlainObject(body.entry_config, "entry_config");
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

        const businessId = registry.create(input);
        // 首个匹配行的入口配置：CreateBusinessInput 不含 entry_config（既有契约不改动），
        // 先建后删补 addMatch 落定（同一事务外两步，失败面仅留下无入口配置的匹配行）
        if (entryConfig !== undefined) {
          registry.removeMatch(businessId, source, eventType);
          registry.addMatch(businessId, source, eventType, entryConfig);
        }
        log.info("API 创建业务", {
          operator_id: actor.user_id,
          business_id: businessId,
        });
        sendJson(res, 201, registry.getProfile(businessId));
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
      handler: (req, res) => {
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
        // model/agent_kind 出现且非空 → 校验 ∈ 可选集合（与绑定无关）
        const touchesBinding =
          body.package_asset_id !== undefined ||
          body.entry_program !== undefined ||
          body.tool_asset_ids !== undefined ||
          body.skill_asset_ids !== undefined;
        validateBusinessWrite(deps, actor, {
          binding: touchesBinding
            ? {
                package_asset_id:
                  patch.package_asset_id ?? profile.package_asset_id,
                entry_program: patch.entry_program ?? profile.entry_program,
                tool_asset_ids: patch.tool_asset_ids ?? profile.tool_asset_ids,
                skill_asset_ids:
                  patch.skill_asset_ids ?? profile.skill_asset_ids,
              }
            : undefined,
          model: patch.model,
          agent_kind: patch.agent_kind,
        });

        registry.update(businessId, patch);
        log.info("API 更新业务", {
          operator_id: actor.user_id,
          business_id: businessId,
        });
        sendNoContent(res);
      },
    },
    {
      method: "DELETE",
      pattern: "/api/businesses/:id",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertWritable(registry, businessId, actor);
        registry.remove(businessId);
        log.info("API 删除业务", {
          operator_id: actor.user_id,
          business_id: businessId,
        });
        sendNoContent(res);
      },
    },
    {
      method: "POST",
      pattern: "/api/businesses/:id/matches",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertWritable(registry, businessId, actor);
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as MatchBody;
        const source = assertEventSource(body.source, "source");
        const eventType = requireNonEmptyString(body.event_type, "event_type");
        const entryConfig =
          body.entry_config === undefined
            ? undefined
            : requirePlainObject(body.entry_config, "entry_config");
        // webhook 行端点 path 全平台唯一（含与本业务既有行比对；冲突 → 400）
        if (source === "webhook") {
          assertWebhookPathUnique(registry, entryConfig);
        }
        registry.addMatch(businessId, source, eventType, entryConfig);
        log.info("API 新增匹配行", {
          operator_id: actor.user_id,
          business_id: businessId,
          source,
          event_type: eventType,
        });
        sendJson(res, 201, registry.get(businessId));
      },
    },
    {
      method: "DELETE",
      pattern: "/api/businesses/:id/matches",
      handler: (req, res) => {
        const actor = req.actor as User;
        const businessId = req.params.id;
        assertWritable(registry, businessId, actor);
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as RemoveMatchBody;
        const source = assertEventSource(body.source, "source");
        const eventType = requireNonEmptyString(body.event_type, "event_type");
        registry.removeMatch(businessId, source, eventType);
        log.info("API 删除匹配行", {
          operator_id: actor.user_id,
          business_id: businessId,
          source,
          event_type: eventType,
        });
        sendNoContent(res);
      },
    },
  ];
}
