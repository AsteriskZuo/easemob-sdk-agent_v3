import type {
  AssetInput,
  AssetKind,
  AssetMeta,
  AssetRegistry,
} from "@asterisk/agent-asset-registry";
import { logger } from "@asterisk/agent-logger";
import type { EnvProvider } from "@asterisk/agent-runtime";
import type { User } from "./accounts.js";
import { ApiError } from "./errors.js";
import type { RegisterAssetBody } from "./dto.js";
import {
  requireNonEmptyString,
  requirePlainObject,
  sendJson,
  sendNoContent,
} from "./http.js";
import type { Route } from "./router.js";

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

/** 资产路由：读 = 登录用户；写（登记/下架）= 仅 member（admin 不持有资产），下架仅限属主本人 */
export function assetRoutes(deps: {
  assets: AssetRegistry;
  env: EnvProvider;
}): Route[] {
  const { assets, env } = deps;
  const log = logger.for({ module: "console-api" });

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
        let metas: AssetMeta[];
        if (scope === "mine") {
          metas = assets.list({ ...filter, owner_id: actor.user_id });
        } else if (scope === "shared") {
          metas = assets.list({ ...filter, shared: true });
        } else if (actor.role === "admin") {
          // admin 缺省/显式 all = 全量（admin 只读，不持有资产）
          metas = assets.list(filter);
        } else {
          // member 缺省 = 自己的 + 共享的（两个查询合并，按 asset_id 去重——
          // 自己的共享资产两边都命中）；member 的 scope=all 语义 = 其可见全集，同样合并
          const byId = new Map<string, AssetMeta>();
          for (const meta of assets.list({
            ...filter,
            owner_id: actor.user_id,
          })) {
            byId.set(meta.asset_id, meta);
          }
          for (const meta of assets.list({ ...filter, shared: true })) {
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
      handler: (req, res) => {
        const actor = req.actor as User;
        if (actor.role !== "member") {
          throw new ApiError(
            "forbidden",
            "admin 不持有资产，登记/下架仅 member",
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

        let credential: string | undefined;
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
          credential = resolveCredential(env, input.credential_key);
        }
        const meta = assets.register(input, { credential });
        log.info("API 登记资产", {
          operator_id: actor.user_id,
          asset_id: meta.asset_id,
          kind: meta.kind,
        });
        sendJson(res, 201, meta);
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
      handler: (req, res) => {
        const actor = req.actor as User;
        const assetId = req.params.id;
        const meta = findMeta(assets, assetId);
        if (meta === undefined) {
          throw new ApiError("not_found", `资产不存在: ${assetId}`);
        }
        if (meta.owner_id !== actor.user_id) {
          throw new ApiError("forbidden", "仅属主本人可下架");
        }
        assets.remove(assetId);
        log.info("API 下架资产", {
          operator_id: actor.user_id,
          asset_id: assetId,
        });
        sendNoContent(res);
      },
    },
  ];
}
