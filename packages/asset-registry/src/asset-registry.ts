import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { migrate } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import { computeAssetId } from "./asset-id.js";
import { resolveRef } from "./git.js";
import { materializeFromGit } from "./materialize.js";
import { validateAsset } from "./validate.js";
import type { AssetKind, AssetManifest } from "./validate.js";

export type { AssetKind, AssetManifest } from "./validate.js";

/** 登记输入 */
export interface AssetInput {
  kind: AssetKind;
  /** git 仓库地址（本地路径亦可，git clone 支持） */
  url: string;
  /** 分支/tag/commit；登记时解析成 commit 存定（§5.3） */
  ref: string;
  /** 资产根在仓库内的子路径（相对路径；缺省 = 仓库根） */
  subpath?: string;
  /** 仅 kind 为 tool/skill 有意义（package 传入 true → invalid_input），缺省 false */
  shared?: boolean;
  /** 属主账号 id */
  owner_id: string;
  /** 私有仓库标记，缺省 false；true 时 credential_key 必填（§5.6） */
  is_private?: boolean;
  /** 凭据 key 的名字（指向操作者安全桶）；本包只存名字不存值 */
  credential_key?: string;
}

/** 登记元数据（库行） */
export interface AssetMeta {
  /** `ast_` + sha256 前 16 hex（§5.2） */
  asset_id: string;
  kind: AssetKind;
  owner_id: string;
  shared: boolean;
  is_private: boolean;
  /** 仅 is_private 时有值 */
  credential_key?: string;
  /** ISO 时间戳 */
  created_at: string;
  /** 本版无修改操作，恒等于 created_at */
  modified_at: string;
}

/** 取用结果：登记元数据 + 清单解析结果 */
export interface AssetObject {
  meta: AssetMeta;
  manifest: AssetManifest;
}

export interface AssetRegistry {
  /** 登记：解析 ref→commit（需网络/可达 git 仓库）→ 算 asset_id → 幂等或插行。不下载内容。
   *  opts.credential：调用方从操作者安全桶解析出的凭据值（is_private 资产的 ls-remote 需要，见 §5.3/§5.6） */
  register(input: AssetInput, opts?: { credential?: string }): AssetMeta;

  /** 列表：按 kind / owner_id / shared 过滤（均可缺省 = 不过滤）；权限过滤归调用方 */
  list(filter: {
    kind?: AssetKind;
    owner_id?: string;
    shared?: boolean;
  }): AssetMeta[];

  /** 取用：内部先 materialize 再按 kind 校验解析；未登记抛 asset_not_found */
  get(asset_id: string, opts?: { credential?: string }): AssetObject;

  /** 物化：确保资产内容在本地可用，返回资产根绝对路径（幂等；缓存缺失自动补拉）。
   *  package/tool 资产补拉时走固定构建流程（clone → 清单形状校验 → npm ci → 业务初始化脚本
   *  agent.materialize.mjs → 产物校验），skill 资产不构建；实现与独立 CLI（materialize-cli.js）共用。
   *  opts.credential 同 register（仅缓存缺失、需要真正 clone 时需要，见 §5.7） */
  materialize(asset_id: string, opts?: { credential?: string }): string;

  /** 下架：删登记行 + 清物化缓存目录；不存在幂等不报错。
   *  不校验在役引用——业务绑定着已下架资产时，运行时取用在 ContextLoader 处抛 asset_not_found，
   *  属配置错误，由控制台操作者负责（console UI 可在删除前提示在役业务，非本包职责） */
  remove(asset_id: string): void;

  /** 清空物化缓存根目录下全部内容（登记行不动）；cacheRoot 不存在时不报错（幂等）。
   *  清理后已登记资产下次 get/materialize 触发重新物化构建（懒重建，可能耗时分钟级） */
  clearCache(): void;
}

/** 存储迁移（spec §5.5）：下标即版本号，v1 建 assets 表 */
const MIGRATIONS = [
  // commit 是 SQLite 保留字，列名须加双引号（列名仍为 commit，与 spec §5.5 一致）
  `CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  "commit" TEXT NOT NULL,
  subpath TEXT,
  shared INTEGER NOT NULL,
  is_private INTEGER NOT NULL,
  credential_key TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
)`,
];

/** assets 表行形态（snake_case 原样） */
interface AssetRow {
  asset_id: string;
  kind: string;
  url: string;
  commit: string;
  subpath: string | null;
  shared: number;
  is_private: number;
  credential_key: string | null;
  owner_id: string;
  created_at: string;
  modified_at: string;
}

function rowToMeta(row: AssetRow): AssetMeta {
  return {
    asset_id: row.asset_id,
    kind: row.kind as AssetKind,
    owner_id: row.owner_id,
    shared: row.shared === 1,
    is_private: row.is_private === 1,
    ...(row.credential_key !== null
      ? { credential_key: row.credential_key }
      : {}),
    created_at: row.created_at,
    modified_at: row.modified_at,
  };
}

function invalid(reason: string): never {
  throw new Error(`invalid_input: ${reason}`);
}

/** 校验相对路径形态（登记入参 subpath / 物化拼路径共用）：相对、不含 .. 段 */
function isInnerRelativePath(p: string): boolean {
  return !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..");
}

class AssetRegistryImpl implements AssetRegistry {
  constructor(
    private readonly db: Database,
    private readonly cacheRoot: string,
    /** npm registry 地址（物化 npm ci / 初始化脚本子进程的 NPM_CONFIG_REGISTRY；装配方注入，见 server AGENT_NPM_REGISTRY） */
    private readonly npmRegistry?: string,
  ) {
    migrate(db, "asset-registry", MIGRATIONS);
  }

  register(input: AssetInput, opts?: { credential?: string }): AssetMeta {
    if (
      input.kind !== "package" &&
      input.kind !== "tool" &&
      input.kind !== "skill"
    ) {
      invalid(`kind 非法: ${String(input.kind)}`);
    }
    if (typeof input.url !== "string" || input.url.length === 0) {
      invalid("url 不能为空");
    }
    if (typeof input.ref !== "string" || input.ref.length === 0) {
      invalid("ref 不能为空");
    }
    if (typeof input.owner_id !== "string" || input.owner_id.length === 0) {
      invalid("owner_id 不能为空");
    }
    if (input.subpath !== undefined && !isInnerRelativePath(input.subpath)) {
      invalid(`subpath 必须是相对路径且不含 .. 段: ${input.subpath}`);
    }
    if (input.kind === "package" && input.shared === true) {
      invalid("package 不支持 shared");
    }
    const isPrivate = input.is_private === true;
    if (isPrivate && !input.credential_key) {
      invalid("is_private 需要 credential_key");
    }
    // 非私有资产不存 credential_key（传入也归一为 undefined）
    const credentialKey = isPrivate ? input.credential_key : undefined;
    if (isPrivate && !opts?.credential) {
      // ls-remote 需要认证，fail-fast 在发请求前
      throw new Error(`credential_required: ${credentialKey}`);
    }

    const commit = resolveRef(input.url, input.ref, opts?.credential);
    const assetId = computeAssetId(
      input.owner_id,
      input.url,
      commit,
      input.subpath,
    );

    const existing = this.getRow(assetId);
    if (existing) {
      return rowToMeta(existing);
    }
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO assets
       (asset_id, kind, url, "commit", subpath, shared, is_private, credential_key, owner_id, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        input.kind,
        input.url,
        commit,
        input.subpath ?? null,
        input.shared === true ? 1 : 0,
        isPrivate ? 1 : 0,
        credentialKey ?? null,
        input.owner_id,
        now,
        now,
      ],
    );
    return rowToMeta(this.getRow(assetId) as AssetRow);
  }

  list(filter: {
    kind?: AssetKind;
    owner_id?: string;
    shared?: boolean;
  }): AssetMeta[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.kind !== undefined) {
      conds.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.owner_id !== undefined) {
      conds.push("owner_id = ?");
      params.push(filter.owner_id);
    }
    if (filter.shared !== undefined) {
      conds.push("shared = ?");
      params.push(filter.shared ? 1 : 0);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
    return this.db
      .all<AssetRow>(
        `SELECT * FROM assets${where} ORDER BY created_at, asset_id`,
        params,
      )
      .map(rowToMeta);
  }

  get(asset_id: string, opts?: { credential?: string }): AssetObject {
    const row = this.getRow(asset_id);
    if (!row) {
      throw new Error(`asset_not_found: ${asset_id}`);
    }
    const root = this.materialize(asset_id, opts);
    const manifest = validateAsset(root, row.kind as AssetKind);
    return { meta: rowToMeta(row), manifest };
  }

  materialize(asset_id: string, opts?: { credential?: string }): string {
    const row = this.getRow(asset_id);
    if (!row) {
      throw new Error(`asset_not_found: ${asset_id}`);
    }
    const subpath = row.subpath ?? "";
    const target = path.join(this.cacheRoot, asset_id);
    const marker = path.join(target, ".materialized-ok");
    if (existsSync(marker)) {
      // 命中缓存：直接返回，不需要 credential
      return path.join(target, subpath);
    }
    if (row.is_private === 1 && !opts?.credential) {
      throw new Error(`credential_required: ${row.credential_key}`);
    }

    // 固定物化流程（clone → 形状校验 → npm ci → 业务初始化脚本 → 产物校验 → marker → rename）
    // 与独立 CLI（materialize-cli.js）共用同一实现，资产 kind 取自登记行
    return materializeFromGit({
      url: row.url,
      commit: row.commit,
      ...(row.subpath !== null ? { subpath: row.subpath } : {}),
      target,
      credential: opts?.credential,
      kind: row.kind as AssetKind,
      npmRegistry: this.npmRegistry,
    });
  }

  remove(asset_id: string): void {
    this.db.run("DELETE FROM assets WHERE asset_id = ?", [asset_id]);
    rmSync(path.join(this.cacheRoot, asset_id), {
      recursive: true,
      force: true,
    });
  }

  clearCache(): void {
    if (!existsSync(this.cacheRoot)) return;
    // 逐项删除保 cacheRoot 目录本身（后续物化直接以它为父目录）
    for (const entry of readdirSync(this.cacheRoot)) {
      rmSync(path.join(this.cacheRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  }

  private getRow(assetId: string): AssetRow | undefined {
    return this.db.get<AssetRow>("SELECT * FROM assets WHERE asset_id = ?", [
      assetId,
    ]);
  }
}

/** 工厂：db 为全平台唯一数据访问口；cache_root 为物化根（由装配方给，如 {workspace}/cache/assets）；
 *  npm_registry 可选（物化 npm ci / 初始化脚本子进程的 NPM_CONFIG_REGISTRY，装配方从 AGENT_NPM_REGISTRY 注入） */
export function createAssetRegistry(
  db: Database,
  paths: { cache_root: string; npm_registry?: string },
): AssetRegistry {
  return new AssetRegistryImpl(db, paths.cache_root, paths.npm_registry);
}
