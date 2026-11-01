import type {
  AssetInput,
  AssetKind,
  AssetMeta,
  AssetRegistry,
} from "@asteriskzuo/agent-asset-registry";
import { computeAssetId, resolveRef } from "@asteriskzuo/agent-asset-registry";
import { logger } from "@asteriskzuo/agent-logger";
import type { BusinessRegistry } from "@asteriskzuo/agent-registry";
import { findAssetReferencers } from "@asteriskzuo/agent-registry";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import type { User } from "./accounts.js";
import { ApiError } from "./errors.js";
import type { RegisterAssetBody, UpdateAssetBody } from "./dto.js";
import {
  requireNonEmptyString,
  requirePlainObject,
  sendJson,
  sendNoContent,
} from "./http.js";
import type { Route } from "./router.js";
import type { UpdateSubmission, UpdateSubmitter } from "./updates.js";

const ASSET_KINDS: readonly AssetKind[] = ["package", "tool", "skill"];

function assertAssetKind(value: unknown): AssetKind {
  if (
    typeof value !== "string" ||
    !(ASSET_KINDS as readonly string[]).includes(value)
  ) {
    throw new ApiError(
      "invalid_input",
      `kind 非法: ${String(value)}（允许: ${ASSET_KINDS.join("/")}）`,
    );
  }
  return value as AssetKind;
}

/** asset-registry 无「按 id 取 meta」读口，控制台规模下 list({}) 全量查找可接受 */
function findMeta(
  assets: AssetRegistry,
  assetId: string,
): AssetMeta | undefined {
  return assets.list({}).find((meta) => meta.asset_id === assetId);
}

/** 私有资产凭据解析约定：凭据值从通用层安全桶取（env.getFor("") 只取通用层）；
 *  取不到 → invalid_input（提示先在通用配置安全桶登记该 credential_key） */
function resolveCredential(env: EnvProvider, credentialKey: string): string {
  const value = env.getFor("").secrets[credentialKey];
  if (value === undefined) {
    throw new ApiError(
      "invalid_input",
      `凭据 key 未在通用配置安全桶登记: ${credentialKey}`,
    );
  }
  return value;
}

function optionalField<T>(
  value: unknown,
  field: string,
  check: (v: unknown) => boolean,
): T | undefined {
  if (value === undefined) return undefined;
  if (!check(value)) {
    throw new ApiError("invalid_input", `${field} 类型不符`);
  }
  return value as T;
}

/** 统一响应：已应用 = 现有同步语义（201/200 + meta）；已接受排队 = 202 { accepted: true } */
function respondMeta<T>(
  res: Parameters<typeof sendJson>[0],
  submission: UpdateSubmission<T>,
  appliedStatus: number,
): void {
  if (submission.outcome === "applied") {
    sendJson(res, appliedStatus, submission.result);
  } else {
    sendJson(res, 202, { accepted: true });
  }
}

/** 资产路由：读 = 登录用户；写（登记/更新/上下架/删除）= 仅 member（admin 不持有资产），更新/上下架/删除仅限属主本人；
 *  共享资产（tool/skill shared=true）禁止版本更新（asset-registry shared_immutable → 409）。
 *  写操作一律经统一更新队列：登记/删除按提交时引用方（通常空），更新/上下架 = 全部引用方屏障 */
export function assetRoutes(deps: {
  assets: AssetRegistry;
  env: EnvProvider;
  registry: BusinessRegistry;
  updates: UpdateSubmitter;
}): Route[] {
  const { assets, env, registry, updates } = deps;
  const log = logger.for({ module: "console-api" });

  function assertMemberWritable(
    actor: User,
    assetId: string,
    action: string,
  ): AssetMeta {
    if (actor.role !== "member") {
      throw new ApiError("forbidden", `admin 不持有资产，${action}仅 member`);
    }
    const meta = findMeta(assets, assetId);
    if (meta === undefined) {
      throw new ApiError("not_found", `资产不存在: ${assetId}`);
    }
    if (meta.owner_id !== actor.user_id) {
      throw new ApiError("forbidden", `仅属主本人可${action}`);
    }
    return meta;
  }

  function listFilter(req: { query: URLSearchParams }): { kind?: AssetKind } {
    const kind = req.query.get("kind");
    if (kind === null) return {};
    return { kind: assertAssetKind(kind) };
  }

  return [
    {
      method: "GET",
      pattern: "/api/assets",
      handler: (req, res) => {
        const actor = req.actor as User;
        const filter = listFilter(req);
        const scope = req.query.get("scope");
        if (scope !== null && !["mine", "shared", "all"].includes(scope)) {
          throw new ApiError(
            "invalid_input",
            `scope 非法: ${scope}（允许: mine/shared/all）`,
          );
        }
        // enabled 过滤（可选）：选择器用 enabled=true 只看可用资产；缺省返回全部（含已下架）
        const enabledParam = req.query.get("enabled");
        const enabledFilter =
          enabledParam === "true"
            ? { enabled: true }
            : enabledParam === "false"
              ? { enabled: false }
              : {};
        const fullFilter = { ...filter, ...enabledFilter };
        let metas: AssetMeta[];
        if (scope === "mine") {
          metas = assets.list({ ...fullFilter, owner_id: actor.user_id });
        } else if (scope === "shared") {
          metas = assets.list({ ...fullFilter, shared: true });
        } else if (actor.role === "admin") {
          // admin 缺省/显式 all = 全量（admin 只读，不持有资产）
          metas = assets.list(fullFilter);
        } else {
          // member 缺省 = 自己的 + 共享的（两个查询合并，按 asset_id 去重——
          // 自己的共享资产两边都命中）；member 的 scope=all 语义 = 其可见全集，同样合并
          const byId = new Map<string, AssetMeta>();
          for (const meta of assets.list({
            ...fullFilter,
            owner_id: actor.user_id,
          })) {
            byId.set(meta.asset_id, meta);
          }
          for (const meta of assets.list({ ...fullFilter, shared: true })) {
            byId.set(meta.asset_id, meta);
          }
          metas = [...byId.values()];
        }
        sendJson(res, 200, metas);
      },
    },
    {
      method: "POST",
      pattern: "/api/assets",
      handler: async (req, res) => {
        const actor = req.actor as User;
        if (actor.role !== "member") {
          throw new ApiError(
            "forbidden",
            "admin 不持有资产，资产写操作仅 member",
          );
        }
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as RegisterAssetBody;
        const input: AssetInput = {
          kind: assertAssetKind(body.kind),
          url: requireNonEmptyString(body.url, "url"),
          ref: requireNonEmptyString(body.ref, "ref"),
          owner_id: actor.user_id,
        };
        const subpath = optionalField<string>(
          body.subpath,
          "subpath",
          (v) => typeof v === "string",
        );
        if (subpath !== undefined) input.subpath = subpath;
        const shared = optionalField<boolean>(
          body.shared,
          "shared",
          (v) => typeof v === "boolean",
        );
        if (shared !== undefined) input.shared = shared;
        const isPrivate = optionalField<boolean>(
          body.is_private,
          "is_private",
          (v) => typeof v === "boolean",
        );
        if (isPrivate !== undefined) input.is_private = isPrivate;
        const credentialKey = optionalField<string>(
          body.credential_key,
          "credential_key",
          (v) => typeof v === "string",
        );
        if (credentialKey !== undefined) input.credential_key = credentialKey;

        if (input.is_private === true) {
          if (
            input.credential_key === undefined ||
            input.credential_key === ""
          ) {
            throw new ApiError(
              "invalid_input",
              "is_private 需要 credential_key",
            );
          }
        }
        // 提交时固定版本（ref → 40 位 commit）：排队期间分支移动不影响实际应用版本。
        // 私有资产 ls-remote 需要凭据真值（仅本次解析用，不进入队列 payload——payload 只存键名）
        const credential =
          input.is_private === true
            ? resolveCredential(env, input.credential_key as string)
            : undefined;
        const fixedCommit = resolveRef(input.url, input.ref, credential);
        const fixedInput: AssetInput = { ...input, ref: fixedCommit };
        // 同 id 已存在 = 幂等返回既有 meta（register 语义）；有在役引用时仍需排队等待
        const assetId = computeAssetId(
          input.owner_id,
          input.url,
          input.kind,
          input.subpath,
        );
        const referencers = findAssetReferencers(registry, assetId);
        const submission = await updates.submit<AssetMeta>({
          kind: "asset.register",
          payload: { input: fixedInput },
          business_ids: referencers,
          requested_by: actor.user_id,
        });
        log.info("API 登记资产", {
          operator_id: actor.user_id,
          asset_id: assetId,
          update_id: submission.update_id,
        });
        respondMeta(res, submission, 201);
      },
    },
    {
      method: "PUT",
      pattern: "/api/assets/:id",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const assetId = req.params.id;
        const meta = assertMemberWritable(actor, assetId, "更新");
        const body = requirePlainObject(
          req.body,
          "body",
        ) as unknown as UpdateAssetBody;
        const ref = requireNonEmptyString(body.ref, "ref");
        let credential: string | undefined;
        if (meta.is_private && meta.credential_key !== undefined) {
          credential = resolveCredential(env, meta.credential_key);
        }
        // 只读预解析：固定 commit；与现版本相同 → 幂等直接返回，不入队
        const resolved = assets.resolveUpdateRef(assetId, ref, { credential });
        if (!resolved.changed) {
          sendJson(res, 200, findMeta(assets, assetId));
          return;
        }
        const submission = await updates.submit<AssetMeta>({
          kind: "asset.update",
          payload: {
            asset_id: assetId,
            commit: resolved.commit,
            ...(meta.credential_key !== undefined
              ? { credential_key: meta.credential_key }
              : {}),
          },
          business_ids: findAssetReferencers(registry, assetId),
          requested_by: actor.user_id,
        });
        log.info("API 更新资产版本", {
          operator_id: actor.user_id,
          asset_id: assetId,
          update_id: submission.update_id,
        });
        respondMeta(res, submission, 200);
      },
    },
    {
      method: "PUT",
      pattern: "/api/assets/:id/status",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const assetId = req.params.id;
        assertMemberWritable(actor, assetId, "上下架");
        const body = requirePlainObject(req.body, "body");
        if (typeof body.enabled !== "boolean") {
          throw new ApiError("invalid_input", "enabled 必须是布尔值");
        }
        const enabled = body.enabled;
        const submission = await updates.submit<AssetMeta>({
          kind: "asset.enabled.set",
          payload: { asset_id: assetId, enabled },
          business_ids: findAssetReferencers(registry, assetId),
          requested_by: actor.user_id,
        });
        log.info("API 上下架资产", {
          operator_id: actor.user_id,
          asset_id: assetId,
          enabled,
          update_id: submission.update_id,
        });
        respondMeta(res, submission, 200);
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/:id",
      handler: (req, res) => {
        const assetId = req.params.id;
        const meta = findMeta(assets, assetId);
        if (meta === undefined) {
          throw new ApiError("not_found", `资产不存在: ${assetId}`);
        }
        // 详情会触发物化（首次可能 git clone，慢——不另设超时，由 node:http 默认行为承载）；
        // 私有资产缓存缺失时需要凭据（命中缓存则不需要，asset-registry 内部判定）
        let credential: string | undefined;
        if (meta.is_private && meta.credential_key !== undefined) {
          credential = resolveCredential(env, meta.credential_key);
        }
        sendJson(res, 200, assets.get(assetId, { credential }));
      },
    },
    {
      method: "DELETE",
      pattern: "/api/assets/:id",
      handler: async (req, res) => {
        const actor = req.actor as User;
        const assetId = req.params.id;
        assertMemberWritable(actor, assetId, "删除");
        // 删除是物理删除：仍有业务绑定时拒绝（提示先解绑或改用下架开关），不制造悬空绑定
        const referencers = findAssetReferencers(registry, assetId);
        if (referencers.length > 0) {
          throw new ApiError(
            "conflict",
            `资产仍被业务绑定，不能删除: ${assetId}（引用方: ${referencers.join(", ")}；请先解除绑定，或改用下架开关）`,
          );
        }
        const submission = await updates.submit({
          kind: "asset.remove",
          payload: { asset_id: assetId },
          business_ids: [],
          requested_by: actor.user_id,
        });
        log.info("API 删除资产", {
          operator_id: actor.user_id,
          asset_id: assetId,
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
