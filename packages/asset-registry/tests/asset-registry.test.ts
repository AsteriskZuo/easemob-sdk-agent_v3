import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";
import { createAssetRegistry } from "../src/index.js";
import type { AssetInput, AssetRegistry } from "../src/index.js";

jest.setTimeout(60000);

let tmpDir: string;
let db: Database;
let registry: AssetRegistry;
let cacheRoot: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "asset-registry-test-"));
  cacheRoot = join(tmpDir, "cache");
  db = openDatabase(":memory:");
  registry = createAssetRegistry(db, { cache_root: cacheRoot });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 本地 git 命令封装：显式带 user 配置，不依赖全局 git config */
function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@test", "-c", "user.name=test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** 造一个本地 git 仓库：写入 files（相对路径 → 内容）并提交，返回目录与 commit */
function makeRepo(files: Record<string, string>): {
  dir: string;
  commit: string;
} {
  const dir = mkdtempSync(join(tmpDir, "repo-"));
  git(["init"], dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return { dir, commit: git(["rev-parse", "HEAD"], dir) };
}

/** 合法 package/tool 仓库的清单文件集合 */
const PKG_FILES: Record<string, string> = {
  "agent-package.json": JSON.stringify({
    name: "demo",
    version: "1.0.0",
    programs: { main: "src/main.js" },
  }),
  "src/main.js": "console.log('hi');",
};

function pkgInput(
  dir: string,
  overrides: Partial<AssetInput> = {},
): AssetInput {
  return {
    kind: "package",
    url: dir,
    ref: "HEAD",
    owner_id: "alice",
    ...overrides,
  };
}

describe("register 基础", () => {
  it("register package → meta 字段一致，asset_id 形如 ast_ + 16 hex", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    expect(meta.asset_id).toMatch(/^ast_[0-9a-f]{16}$/);
    expect(meta.kind).toBe("package");
    expect(meta.owner_id).toBe("alice");
    expect(meta.shared).toBe(false);
    expect(meta.is_private).toBe(false);
    expect(meta.credential_key).toBeUndefined();
    expect(meta.created_at).toBe(meta.modified_at);
    // ref 解析为 commit 存定
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(repo.commit);
  });
});

describe("ref 解析", () => {
  it("给分支名 → 存定为该分支的 commit", () => {
    const repo = makeRepo(PKG_FILES);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo.dir);
    const meta = registry.register(pkgInput(repo.dir, { ref: branch }));
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(repo.commit);
  });

  it("给注解 tag → 存定为剥离后的 commit", () => {
    const repo = makeRepo(PKG_FILES);
    git(["tag", "-a", "v1", "-m", "release"], repo.dir);
    const meta = registry.register(pkgInput(repo.dir, { ref: "v1" }));
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(git(["rev-parse", "v1^{}"], repo.dir));
    expect(row?.commit).toBe(repo.commit);
  });

  it("给轻量 tag → 存定为 commit", () => {
    const repo = makeRepo(PKG_FILES);
    git(["tag", "v1l"], repo.dir);
    const meta = registry.register(pkgInput(repo.dir, { ref: "v1l" }));
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(repo.commit);
  });

  it("给 40 位 commit → 原样存定", () => {
    const repo = makeRepo(PKG_FILES);
    const fakeCommit = "a".repeat(40);
    const meta = registry.register(pkgInput(repo.dir, { ref: fakeCommit }));
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(fakeCommit);
  });

  it("不存在的 ref → ref_not_found", () => {
    const repo = makeRepo(PKG_FILES);
    expect(() =>
      registry.register(pkgInput(repo.dir, { ref: "no-such-ref" })),
    ).toThrow(/^ref_not_found: no-such-ref$/);
  });

  it("分支与 tag 同名 → ref_ambiguous", () => {
    const repo = makeRepo(PKG_FILES);
    git(["branch", "dup"], repo.dir);
    git(["tag", "dup"], repo.dir);
    expect(() => registry.register(pkgInput(repo.dir, { ref: "dup" }))).toThrow(
      /ref_ambiguous: dup/,
    );
  });
});

describe("幂等与唯一性", () => {
  it("同（属主+三元组）重复 register → 幂等同 id，list 行数不增", () => {
    const repo = makeRepo(PKG_FILES);
    const m1 = registry.register(pkgInput(repo.dir));
    const m2 = registry.register(pkgInput(repo.dir));
    expect(m2.asset_id).toBe(m1.asset_id);
    expect(registry.list({})).toHaveLength(1);
  });

  it("同三元组不同属主 → 不同 asset_id 两行", () => {
    const repo = makeRepo(PKG_FILES);
    const m1 = registry.register(pkgInput(repo.dir, { owner_id: "alice" }));
    const m2 = registry.register(pkgInput(repo.dir, { owner_id: "bob" }));
    expect(m1.asset_id).not.toBe(m2.asset_id);
    expect(registry.list({})).toHaveLength(2);
  });

  it("不同 commit → 不同 asset_id", () => {
    const repo = makeRepo(PKG_FILES);
    const first = repo.commit;
    writeFileSync(join(repo.dir, "second.txt"), "more");
    git(["add", "-A"], repo.dir);
    git(["commit", "-m", "second"], repo.dir);
    const second = git(["rev-parse", "HEAD"], repo.dir);
    const m1 = registry.register(pkgInput(repo.dir, { ref: first }));
    const m2 = registry.register(pkgInput(repo.dir, { ref: second }));
    expect(m1.asset_id).not.toBe(m2.asset_id);
  });

  it("不同 subpath → 不同 asset_id", () => {
    const repo = makeRepo({ ...PKG_FILES });
    const m1 = registry.register(pkgInput(repo.dir));
    const m2 = registry.register(pkgInput(repo.dir, { subpath: "sub" }));
    expect(m1.asset_id).not.toBe(m2.asset_id);
  });
});

describe("入参校验", () => {
  it("kind='package' 且 shared: true → invalid_input", () => {
    const repo = makeRepo(PKG_FILES);
    expect(() =>
      registry.register(pkgInput(repo.dir, { shared: true })),
    ).toThrow(/invalid_input/);
  });

  it("is_private: true 缺 credential_key → invalid_input", () => {
    const repo = makeRepo(PKG_FILES);
    expect(() =>
      registry.register(pkgInput(repo.dir, { is_private: true })),
    ).toThrow(/invalid_input: is_private 需要 credential_key/);
  });

  it("非私有资产传 credential_key → 入库行 credential_key 为 NULL", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(
      pkgInput(repo.dir, { credential_key: "k1" }),
    );
    const row = db.get<{ credential_key: string | null }>(
      "SELECT credential_key FROM assets WHERE asset_id = ?",
      [meta.asset_id],
    );
    expect(row?.credential_key).toBeNull();
  });
});

describe("私有资产凭据流程", () => {
  const SECRET = "SECRET_TOKEN_xyz";

  it("is_private 登记未传 credential → credential_required", () => {
    const repo = makeRepo(PKG_FILES);
    expect(() =>
      registry.register(
        pkgInput(repo.dir, { is_private: true, credential_key: "my-key" }),
      ),
    ).toThrow(/^credential_required: my-key$/);
  });

  it("传 credential 后 register 成功（本地路径无需认证，注入不破坏正常流程）", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(
      pkgInput(repo.dir, { is_private: true, credential_key: "my-key" }),
      { credential: SECRET },
    );
    expect(meta.is_private).toBe(true);
    expect(meta.credential_key).toBe("my-key");
  });

  it("materialize 缓存缺失未传 credential → credential_required；传 credential 后成功；marker 存在后不传幂等返回", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(
      pkgInput(repo.dir, { is_private: true, credential_key: "my-key" }),
      { credential: SECRET },
    );
    expect(() => registry.materialize(meta.asset_id)).toThrow(
      /^credential_required: my-key$/,
    );
    const root = registry.materialize(meta.asset_id, { credential: SECRET });
    expect(existsSync(join(root, "agent-package.json"))).toBe(true);
    // marker 已存在 → 不再需要 credential
    expect(registry.materialize(meta.asset_id)).toBe(root);
  });

  it("ssh 形式 url + is_private + credential → credential_unsupported", () => {
    expect(() =>
      registry.register(
        pkgInput("git@host:org/repo.git", {
          is_private: true,
          credential_key: "my-key",
        }),
        { credential: SECRET },
      ),
    ).toThrow(/^credential_unsupported/);
  });

  it("脱敏：带 credential 对不可达 url 物化 → materialize_failed 且不含凭据原文", () => {
    // 40 位 commit 跳过 ls-remote，登记无需可达仓库
    const meta = registry.register(
      pkgInput("https://127.0.0.1:1/repo.git", {
        ref: "b".repeat(40),
        is_private: true,
        credential_key: "my-key",
      }),
      { credential: SECRET },
    );
    let message = "";
    try {
      registry.materialize(meta.asset_id, { credential: SECRET });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^materialize_failed/);
    expect(message).not.toContain(SECRET);
  });
});

describe("list", () => {
  it("无过滤返回全部；按 kind / owner_id / shared 各自过滤", () => {
    const repoPkg = makeRepo(PKG_FILES);
    const repoTool = makeRepo({
      "agent-package.json": JSON.stringify({ name: "tool-a" }),
    });
    const repoSkill = makeRepo({ "s1/SKILL.md": "# s1" });
    registry.register(pkgInput(repoPkg.dir, { owner_id: "alice" }));
    registry.register(
      pkgInput(repoTool.dir, { kind: "tool", owner_id: "bob", shared: true }),
    );
    registry.register(
      pkgInput(repoSkill.dir, { kind: "skill", owner_id: "bob" }),
    );

    expect(registry.list({})).toHaveLength(3);
    expect(registry.list({ kind: "tool" })).toHaveLength(1);
    expect(registry.list({ owner_id: "bob" })).toHaveLength(2);
    expect(registry.list({ shared: true })).toHaveLength(1);
    expect(registry.list({ shared: false })).toHaveLength(2);
    expect(registry.list({ kind: "skill", owner_id: "bob" })).toHaveLength(1);
  });
});

describe("get", () => {
  it("get package → manifest 解析正确", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    const obj = registry.get(meta.asset_id);
    expect(obj.meta.asset_id).toBe(meta.asset_id);
    expect(obj.manifest).toEqual({
      kind: "package",
      name: "demo",
      version: "1.0.0",
      programs: { main: "src/main.js" },
      requires: { tools: [], skills: [] },
    });
  });

  it("get tool → programs/requires 缺省归一", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({ name: "bare-tool" }),
    });
    const meta = registry.register(pkgInput(repo.dir, { kind: "tool" }));
    const obj = registry.get(meta.asset_id);
    expect(obj.manifest).toEqual({
      kind: "tool",
      name: "bare-tool",
      programs: {},
      requires: { tools: [], skills: [] },
    });
  });

  it("get skill → skills 为集合扫描结果（字典序）", () => {
    const repo = makeRepo({
      "beta/SKILL.md": "# beta",
      "alpha/SKILL.md": "# alpha",
      "gamma/readme.md": "no skill md",
      "root-file.txt": "x",
    });
    const meta = registry.register(pkgInput(repo.dir, { kind: "skill" }));
    const obj = registry.get(meta.asset_id);
    expect(obj.manifest).toEqual({ kind: "skill", skills: ["alpha", "beta"] });
  });

  it("未登记 asset_id → asset_not_found", () => {
    expect(() => registry.get("ast_0000000000000000")).toThrow(
      /^asset_not_found: ast_0000000000000000$/,
    );
  });
});

describe("materialize", () => {
  it("clone 成功、返回路径正确、.git 已删除、marker 存在；二次调用幂等（删掉源仓库仍返回）", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    const root = registry.materialize(meta.asset_id);
    expect(root).toBe(join(cacheRoot, meta.asset_id));
    expect(existsSync(join(root, "agent-package.json"))).toBe(true);
    expect(existsSync(join(cacheRoot, meta.asset_id, ".git"))).toBe(false);
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      true,
    );

    // 删掉源仓库，二次调用仍返回 → 命中缓存未重拉
    rmSync(repo.dir, { recursive: true, force: true });
    expect(registry.materialize(meta.asset_id)).toBe(root);
  });

  it("带 subpath 时返回子路径", () => {
    const repo = makeRepo({
      "sub/agent-package.json": JSON.stringify({ name: "sub-pkg" }),
      "readme.md": "root",
    });
    const meta = registry.register(pkgInput(repo.dir, { subpath: "sub" }));
    const root = registry.materialize(meta.asset_id);
    expect(root).toBe(join(cacheRoot, meta.asset_id, "sub"));
    expect(existsSync(join(root, "agent-package.json"))).toBe(true);
  });

  it("package 清单缺失 → validation_failed，target 无 marker", () => {
    const repo = makeRepo({ "readme.md": "no manifest" });
    const meta = registry.register(pkgInput(repo.dir));
    expect(() => registry.materialize(meta.asset_id)).toThrow(
      /^validation_failed/,
    );
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      false,
    );
  });

  it("programs 路径不存在 → validation_failed", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "broken",
        programs: { main: "nope.js" },
      }),
    });
    const meta = registry.register(pkgInput(repo.dir));
    expect(() => registry.materialize(meta.asset_id)).toThrow(
      /^validation_failed/,
    );
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      false,
    );
  });

  it("programs 路径含 .. 段 → validation_failed", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "evil",
        programs: { main: "../outside.js" },
      }),
    });
    const meta = registry.register(pkgInput(repo.dir));
    expect(() => registry.materialize(meta.asset_id)).toThrow(
      /^validation_failed/,
    );
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      false,
    );
  });

  it("skill 仓库无任何 SKILL.md → validation_failed: no skill found", () => {
    const repo = makeRepo({ "a/readme.md": "nothing" });
    const meta = registry.register(pkgInput(repo.dir, { kind: "skill" }));
    expect(() => registry.materialize(meta.asset_id)).toThrow(
      /^validation_failed: no skill found$/,
    );
  });

  it("url 不存在 → materialize_failed", () => {
    const meta = registry.register(
      pkgInput(join(tmpDir, "no-such-repo"), { ref: "c".repeat(40) }),
    );
    expect(() => registry.materialize(meta.asset_id)).toThrow(
      /^materialize_failed/,
    );
  });

  it("物化缓存目录被人为删除 → 自动补拉成功", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    registry.materialize(meta.asset_id);
    rmSync(join(cacheRoot, meta.asset_id), { recursive: true, force: true });
    const root = registry.materialize(meta.asset_id);
    expect(existsSync(join(root, "agent-package.json"))).toBe(true);
  });
});

describe("持久化", () => {
  it("register 后 close 数据库重开 → 新实例 list/get 结果一致", () => {
    const dbPath = join(tmpDir, "persist.db");
    const db1 = openDatabase(dbPath);
    const registry1 = createAssetRegistry(db1, { cache_root: cacheRoot });
    const repo = makeRepo(PKG_FILES);
    const meta = registry1.register(pkgInput(repo.dir));
    db1.close();

    const db2 = openDatabase(dbPath);
    const registry2 = createAssetRegistry(db2, { cache_root: cacheRoot });
    expect(registry2.list({})).toEqual([meta]);
    const obj = registry2.get(meta.asset_id);
    expect(obj.meta).toEqual(meta);
    expect(obj.manifest.kind).toBe("package");
    db2.close();
  });
});
