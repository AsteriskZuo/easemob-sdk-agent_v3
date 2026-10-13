import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
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

/** 物化构建用的零依赖业务初始化脚本 fixture：产物已随仓库提交时用它（纯注释，node 跑即过） */
const NOOP_MATERIALIZE_SCRIPT =
  "// 测试 fixture：产物已随仓库提交，无需构建（物化纪律：package/tool 必带 agent.materialize.mjs）\n";

/** 合法 package/tool 仓库的清单文件集合 */
const PKG_FILES: Record<string, string> = {
  "agent-package.json": JSON.stringify({
    name: "demo",
    version: "1.0.0",
    programs: { main: "src/main.js" },
  }),
  "src/main.js": "console.log('hi');",
  "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
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
    // 真实第二个 commit（40 位 hex）：ref 原样存定、跳过 ls-remote
    writeFileSync(join(repo.dir, "second.txt"), "more");
    git(["add", "-A"], repo.dir);
    git(["commit", "-m", "second"], repo.dir);
    const second = git(["rev-parse", "HEAD"], repo.dir);
    const meta = registry.register(pkgInput(repo.dir, { ref: second }));
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(second);
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

  it("不同 ref 重复 register → 幂等返回既有资产（版本不切换；升级走 updateRef）", () => {
    const repo = makeRepo(PKG_FILES);
    const first = repo.commit;
    writeFileSync(join(repo.dir, "second.txt"), "more");
    git(["add", "-A"], repo.dir);
    git(["commit", "-m", "second"], repo.dir);
    const second = git(["rev-parse", "HEAD"], repo.dir);
    const m1 = registry.register(pkgInput(repo.dir, { ref: first }));
    const m2 = registry.register(pkgInput(repo.dir, { ref: second }));
    expect(m2.asset_id).toBe(m1.asset_id);
    expect(registry.list({})).toHaveLength(1);
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [m1.asset_id],
    );
    expect(row?.commit).toBe(first);
  });

  it("不同 subpath → 不同 asset_id", () => {
    const repo = makeRepo({
      ...Object.fromEntries(
        Object.entries(PKG_FILES).map(([k, v]) => [`sub/${k}`, v]),
      ),
      ...PKG_FILES,
    });
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
    // 登记即物化（缓存已热），先清缓存模拟缓存缺失场景
    const meta = registry.register(
      pkgInput(repo.dir, { is_private: true, credential_key: "my-key" }),
      { credential: SECRET },
    );
    registry.clearCache();
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

  it("脱敏：带 credential 对不可达 url 登记 → materialize_failed 且不含凭据原文/url编码/base64 形态", () => {
    // 40 位 commit 跳过 ls-remote；登记即物化 → clone 不可达地址在登记时失败
    let message = "";
    try {
      registry.register(
        pkgInput("https://127.0.0.1:1/repo.git", {
          ref: "b".repeat(40),
          is_private: true,
          credential_key: "my-key",
        }),
        { credential: SECRET },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^materialize_failed/);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(encodeURIComponent(SECRET));
    expect(message).not.toContain(
      Buffer.from(`oauth2:${SECRET}`).toString("base64"),
    );
  });

  it("ssh:// 形式 url + credential → credential_unsupported", () => {
    expect(() =>
      registry.register(
        pkgInput("ssh://git@host/org/repo.git", {
          is_private: true,
          credential_key: "my-key",
        }),
        { credential: SECRET },
      ),
    ).toThrow(/^credential_unsupported/);
  });

  it("凭据不落盘：登记+物化后缓存目录任何文件不含凭据原文", () => {
    const repo = makeRepo(PKG_FILES);
    registry.register(
      pkgInput(repo.dir, { is_private: true, credential_key: "my-key" }),
      { credential: SECRET },
    );
    // 递归扫描缓存目录全部文件（含隐藏文件），断言凭据零残留
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(cacheRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(f, "utf8")).not.toContain(SECRET);
    }
  });
});

describe("登记即校验（fail fast）", () => {
  it("subpath 指向无清单目录 → register 抛 validation_failed，登记行回滚、缓存清理", () => {
    const repo = makeRepo({ "sub/readme.md": "no manifest here" });
    expect(() =>
      registry.register(pkgInput(repo.dir, { subpath: "sub" })),
    ).toThrow(/validation_failed: agent-package\.json 不存在或不可读/);
    expect(registry.list({})).toHaveLength(0);
    expect(readdirSync(cacheRoot)).toHaveLength(0);
  });

  it("register 成功 → 物化已完成（marker 存在，缓存即热）", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      true,
    );
  });
});

describe("updateRef", () => {
  /** 在既有仓库上再提交一次，返回新 commit */
  function commitMore(dir: string, files: Record<string, string>): string {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    git(["add", "-A"], dir);
    git(["commit", "-m", "more"], dir);
    return git(["rev-parse", "HEAD"], dir);
  }

  it("package 更新到新 commit → asset_id 不变、库行 commit 更新、modified_at 刷新、缓存重建为新内容", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    const second = commitMore(repo.dir, { "src/extra.js": "// v2" });

    const updated = registry.updateRef(meta.asset_id, second);

    expect(updated.asset_id).toBe(meta.asset_id);
    expect(updated.modified_at > meta.created_at).toBe(true);
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(second);
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      true,
    );
    expect(existsSync(join(cacheRoot, meta.asset_id, "src/extra.js"))).toBe(
      true,
    );
  });

  it("同 commit 更新 → 幂等返回，modified_at 不变", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));

    const updated = registry.updateRef(meta.asset_id, "HEAD");

    expect(updated.modified_at).toBe(meta.created_at);
  });

  it("共享 tool 更新 → shared_immutable，库行不动", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({ name: "tool-a" }),
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
    });
    const meta = registry.register(
      pkgInput(repo.dir, { kind: "tool", shared: true }),
    );
    const second = commitMore(repo.dir, { "v2.txt": "x" });

    expect(() => registry.updateRef(meta.asset_id, second)).toThrow(
      /^shared_immutable:/,
    );
    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(repo.commit);
  });

  it("共享 skill 更新 → shared_immutable", () => {
    const repo = makeRepo({ "s1/SKILL.md": "# s1" });
    const meta = registry.register(
      pkgInput(repo.dir, { kind: "skill", shared: true }),
    );
    expect(() => registry.updateRef(meta.asset_id, "HEAD")).toThrow(
      /^shared_immutable:/,
    );
  });

  it("未登记 asset_id → asset_not_found；空 ref → invalid_input", () => {
    expect(() => registry.updateRef("ast_0000000000000000", "HEAD")).toThrow(
      /^asset_not_found:/,
    );
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    expect(() => registry.updateRef(meta.asset_id, "")).toThrow(
      /invalid_input/,
    );
  });

  it("新版本物化失败 → 抛错且 commit 回滚旧值", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    // 新 commit 删掉物化脚本 → 物化流程必失败
    git(["rm", "-q", "agent.materialize.mjs"], repo.dir);
    git(["commit", "-m", "break"], repo.dir);
    const broken = git(["rev-parse", "HEAD"], repo.dir);

    expect(() => registry.updateRef(meta.asset_id, broken)).toThrow();

    const row = db.get<{ commit: string }>(
      'SELECT "commit" FROM assets WHERE asset_id = ?',
      [meta.asset_id],
    );
    expect(row?.commit).toBe(repo.commit);
  });
});

describe("list", () => {
  it("无过滤返回全部；按 kind / owner_id / shared 各自过滤", () => {
    const repoPkg = makeRepo(PKG_FILES);
    const repoTool = makeRepo({
      "agent-package.json": JSON.stringify({ name: "tool-a" }),
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
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

  it("get tool → programs 缺省归一（manifest 无 requires）", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({ name: "bare-tool" }),
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
    });
    const meta = registry.register(pkgInput(repo.dir, { kind: "tool" }));
    const obj = registry.get(meta.asset_id);
    expect(obj.manifest).toEqual({
      kind: "tool",
      name: "bare-tool",
      programs: {},
    });
  });

  it("tool 清单含 requires → 登记即失败 validation_failed（requires 是 package 专属字段），行回滚", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "bad-tool",
        requires: { tools: ["x"] },
      }),
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
    });
    expect(() =>
      registry.register(pkgInput(repo.dir, { kind: "tool" })),
    ).toThrow(/validation_failed/);
    expect(registry.list({})).toHaveLength(0);
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
      "sub/agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
      "readme.md": "root",
    });
    const meta = registry.register(pkgInput(repo.dir, { subpath: "sub" }));
    const root = registry.materialize(meta.asset_id);
    expect(root).toBe(join(cacheRoot, meta.asset_id, "sub"));
    expect(existsSync(join(root, "agent-package.json"))).toBe(true);
  });

  it("package 清单缺失 → 登记即失败 validation_failed，行回滚不落缓存", () => {
    const repo = makeRepo({ "readme.md": "no manifest" });
    expect(() => registry.register(pkgInput(repo.dir))).toThrow(
      /^validation_failed/,
    );
    expect(registry.list({})).toHaveLength(0);
  });

  it("programs 路径不存在（初始化脚本未产出）→ 登记即失败 validation_failed 且消息列出缺失清单", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "broken",
        programs: { main: "nope.js", other: "absent/x.js" },
      }),
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
    });
    let message = "";
    try {
      registry.register(pkgInput(repo.dir));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^validation_failed: 产物校验失败/);
    // 缺失清单全量列出
    expect(message).toContain("nope.js");
    expect(message).toContain("absent/x.js");
    expect(registry.list({})).toHaveLength(0);
  });

  it("programs 路径非 .js → 登记即失败 validation_failed（形状校验，构建前即失败）", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "ts-entry",
        programs: { main: "src/main.ts" },
      }),
      "src/main.ts": "console.log('hi');",
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
    });
    expect(() => registry.register(pkgInput(repo.dir))).toThrow(
      /^validation_failed: programs 路径必须是 \.js 产物/,
    );
  });

  it("programs 路径含 .. 段 → 登记即失败 validation_failed", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "evil",
        programs: { main: "../outside.js" },
      }),
    });
    expect(() => registry.register(pkgInput(repo.dir))).toThrow(
      /^validation_failed/,
    );
  });

  it("skill 仓库无任何 SKILL.md → 登记即失败 validation_failed: no skill found", () => {
    const repo = makeRepo({ "a/readme.md": "nothing" });
    expect(() =>
      registry.register(pkgInput(repo.dir, { kind: "skill" })),
    ).toThrow(/^validation_failed: no skill found$/);
  });

  it("url 不存在 → 登记即失败 materialize_failed", () => {
    expect(() =>
      registry.register(
        pkgInput(join(tmpDir, "no-such-repo"), { ref: "c".repeat(40) }),
      ),
    ).toThrow(/^materialize_failed/);
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

describe("物化构建链路（npm ci + 业务初始化脚本 + 产物校验）", () => {
  /** 零依赖 package.json + 手写最小 lock（npm ci 零依赖不触网） */
  const NPM_ZERO_DEP_FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture-pkg", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({
      name: "fixture-pkg",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "fixture-pkg", version: "1.0.0" } },
    }),
  };

  /** 纯 node 初始化脚本：造 dist 产物（不依赖 esbuild） */
  const BUILD_SCRIPT = `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist/programs", { recursive: true });
writeFileSync("dist/programs/main.js", "console.log('built');\\n");
`;

  it("package 资产全链路：npm ci 跑过 + 初始化脚本产出 dist + 产物校验通过", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({
        name: "build-me",
        programs: { main: "dist/programs/main.js" },
      }),
      ...NPM_ZERO_DEP_FILES,
      "agent.materialize.mjs": BUILD_SCRIPT,
    });
    const meta = registry.register(pkgInput(repo.dir));
    const root = registry.materialize(meta.asset_id);
    // 初始化脚本产物就位（清单 programs 指向的 dist 产物由脚本构建出来，非仓库提交）
    expect(existsSync(join(root, "dist", "programs", "main.js"))).toBe(true);
    expect(existsSync(join(cacheRoot, meta.asset_id, ".materialized-ok"))).toBe(
      true,
    );
  });

  it("资产根含 package.json 但缺 package-lock.json → 登记即失败 materialize_failed 明确提示", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({ name: "no-lock" }),
      "package.json": JSON.stringify({ name: "no-lock", version: "1.0.0" }),
      "agent.materialize.mjs": NOOP_MATERIALIZE_SCRIPT,
    });
    expect(() => registry.register(pkgInput(repo.dir))).toThrow(
      /materialize_failed: npm ci: .*package-lock\.json（v1 只支持 npm \+ package-lock\.json）/,
    );
  });

  it.each(["package", "tool"] as const)(
    "%s 资产缺 agent.materialize.mjs → 登记即失败 materialize_failed 提示缺该文件",
    (kind) => {
      const repo = makeRepo({
        "agent-package.json": JSON.stringify({ name: `no-script-${kind}` }),
      });
      expect(() => registry.register(pkgInput(repo.dir, { kind }))).toThrow(
        /materialize_failed: 业务初始化脚本缺失: .*agent\.materialize\.mjs/,
      );
    },
  );

  it("初始化脚本 exit≠0 → 登记即失败 materialize_failed 含阶段名与 stderr 尾部（只保留最后 30 行）", () => {
    const failScript = `
for (let i = 1; i <= 40; i++) {
  console.error("errline-" + String(i).padStart(2, "0"));
}
process.exit(1);
`;
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({ name: "fail-script" }),
      "agent.materialize.mjs": failScript,
    });
    let message = "";
    try {
      registry.register(pkgInput(repo.dir));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^materialize_failed: agent\.materialize\.mjs: /);
    // 尾部 30 行 = errline-11..40：尾部在、头部被截掉
    expect(message).toContain("errline-40");
    expect(message).toContain("errline-11");
    expect(message).not.toContain("errline-10");
  });

  it("skill 资产不要求初始化脚本、不构建（含 package.json 无 lock 也照样过）", () => {
    const repo = makeRepo({
      "s1/SKILL.md": "# s1",
      // 干扰项：skill 是纯文档，即使仓里混了 package.json（无 lock）也不走 npm ci
      "package.json": JSON.stringify({ name: "skill-doc", version: "1.0.0" }),
    });
    const meta = registry.register(pkgInput(repo.dir, { kind: "skill" }));
    const root = registry.materialize(meta.asset_id);
    expect(existsSync(join(root, "s1", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });
});

describe("materialize-cli 独立执行", () => {
  const CLI_PATH = fileURLToPath(
    new URL("../src/materialize-cli.js", import.meta.url),
  );

  /** spawn CLI 子进程，返回 {code, stdout, stderr}（不继承 AGENT_ASSET_CREDENTIAL） */
  function runCli(args: string[]): {
    code: number;
    stdout: string;
    stderr: string;
  } {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        code: e.status ?? -1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  }

  it("同 fixture 手动跑通：--url --commit --target 物化成功并打出资产根路径", () => {
    const repo = makeRepo(PKG_FILES);
    const target = join(tmpDir, "cli-target");
    const r = runCli([
      "--url",
      repo.dir,
      "--commit",
      repo.commit,
      "--target",
      target,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(target);
    expect(existsSync(join(target, "agent-package.json"))).toBe(true);
    expect(existsSync(join(target, ".materialized-ok"))).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(false);
  });

  it("缺必填参数 → exit 1 且 stderr 含用法", () => {
    const r = runCli(["--url", "/tmp/whatever"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--commit");
  });

  it("物化失败（缺初始化脚本）→ exit 1 且 stderr 含阶段错误", () => {
    const repo = makeRepo({
      "agent-package.json": JSON.stringify({ name: "cli-no-script" }),
    });
    const r = runCli([
      "--url",
      repo.dir,
      "--commit",
      repo.commit,
      "--target",
      join(tmpDir, "cli-fail-target"),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("materialize_failed: 业务初始化脚本缺失");
  });
});

describe("remove", () => {
  it("下架已物化资产 → 登记行删除 + 缓存目录清理；get 抛 asset_not_found", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    registry.materialize(meta.asset_id);
    expect(existsSync(join(cacheRoot, meta.asset_id))).toBe(true);

    registry.remove(meta.asset_id);
    expect(registry.list({})).toHaveLength(0);
    expect(existsSync(join(cacheRoot, meta.asset_id))).toBe(false);
    expect(() => registry.get(meta.asset_id)).toThrow(/^asset_not_found:/);
  });

  it("下架未物化资产 → 登记行删除（无缓存也不报错）", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    registry.remove(meta.asset_id);
    expect(registry.list({})).toHaveLength(0);
  });

  it("下架不存在的 asset_id → 幂等不报错", () => {
    expect(() => registry.remove("ast_0000000000000000")).not.toThrow();
  });

  it("删后可重新登记同三元组 → 得到同 asset_id", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    registry.remove(meta.asset_id);
    const again = registry.register(pkgInput(repo.dir));
    expect(again.asset_id).toBe(meta.asset_id);
    expect(registry.list({})).toHaveLength(1);
  });
});

describe("clearCache", () => {
  it("清空 cacheRoot 下全部内容（登记行不动；再次取用触发重新物化）", () => {
    const repo = makeRepo(PKG_FILES);
    const meta = registry.register(pkgInput(repo.dir));
    registry.materialize(meta.asset_id);
    expect(existsSync(join(cacheRoot, meta.asset_id))).toBe(true);

    registry.clearCache();
    expect(existsSync(join(cacheRoot, meta.asset_id))).toBe(false);
    // 登记行保留，list 不受影响
    expect(registry.list({})).toHaveLength(1);
    // 缓存缺失 → 重新物化（懒重建）
    registry.materialize(meta.asset_id);
    expect(existsSync(join(cacheRoot, meta.asset_id))).toBe(true);
  });

  it("cacheRoot 不存在时幂等不报错", () => {
    expect(existsSync(cacheRoot)).toBe(false);
    expect(() => registry.clearCache()).not.toThrow();
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
