import { jest } from "@jest/globals";
import type { AssetManifest, AssetMeta, AssetObject } from "../src/index.js";
import {
  PKG_FILES,
  api,
  createMemberAndLogin,
  loginToken,
  makeRepo,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(60000);

let server: TestServer;
let adminToken: string;
let alice: { user_id: string; token: string };
let bob: { user_id: string; token: string };
let repoDir: string;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  alice = await createMemberAndLogin(server, adminToken, "alice");
  bob = await createMemberAndLogin(server, adminToken, "bob");
  repoDir = makeRepo(server.tmpDir, PKG_FILES);
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

async function registerAsset(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; meta: AssetMeta }> {
  const res = await api(server, "POST", "/api/assets", {
    token,
    body: { kind: "package", url: repoDir, ref: "HEAD", ...overrides },
  });
  return { status: res.status, meta: res.body as AssetMeta };
}

describe("POST /api/assets 登记", () => {
  it("member 登记 → 201 AssetMeta（owner_id = 操作者）", async () => {
    const { status, meta } = await registerAsset(alice.token);
    expect(status).toBe(201);
    expect(meta.asset_id).toMatch(/^ast_[0-9a-f]{16}$/);
    expect(meta.owner_id).toBe(alice.user_id);
    expect(meta.kind).toBe("package");
  });

  it("admin 登记 → 403（admin 不持有资产）", async () => {
    const { status } = await registerAsset(adminToken);
    expect(status).toBe(403);
  });

  it("is_private 无 credential_key → 400", async () => {
    const res = await api(server, "POST", "/api/assets", {
      token: alice.token,
      body: { kind: "package", url: repoDir, ref: "HEAD", is_private: true },
    });
    expect(res.status).toBe(400);
  });

  it("is_private credential_key 未在通用安全桶登记 → 400；登记凭据后 → 201", async () => {
    // subpath 区分 asset_id（asset_id 由 属主+url+commit+subpath 决定，与公开登记互不幂等）
    const missing = await api(server, "POST", "/api/assets", {
      token: alice.token,
      body: {
        kind: "package",
        url: repoDir,
        ref: "HEAD",
        subpath: "src",
        is_private: true,
        credential_key: "my-git-token",
      },
    });
    expect(missing.status).toBe(400);
    expect(
      (missing.body as { error: { message: string } }).error.message,
    ).toContain("my-git-token");

    // 通用层安全桶登记凭据（admin 写 global secrets）
    const setSecret = await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "secrets", key: "my-git-token", value: "SECRET_VALUE" },
    });
    expect(setSecret.status).toBe(204);

    const res = await api(server, "POST", "/api/assets", {
      token: alice.token,
      body: {
        kind: "package",
        url: repoDir,
        ref: "HEAD",
        subpath: "src",
        is_private: true,
        credential_key: "my-git-token",
      },
    });
    expect(res.status).toBe(201);
    const meta = res.body as AssetMeta;
    expect(meta.is_private).toBe(true);
    expect(meta.credential_key).toBe("my-git-token");
  });
});

describe("GET /api/assets 列表可见性", () => {
  it("member = 自己的 + 共享的（去重）；admin = 全部；scope=mine/shared 过滤", async () => {
    // alice 私有 package（上文已登记同三元组 → 幂等同 id）；bob 共享 tool；bob 非共享 tool
    const toolRepo = makeRepo(server.tmpDir, {
      "agent-package.json": JSON.stringify({ name: "tool-x" }),
    });
    await api(server, "POST", "/api/assets", {
      token: bob.token,
      body: { kind: "tool", url: toolRepo, ref: "HEAD", shared: true },
    });
    await api(server, "POST", "/api/assets", {
      token: bob.token,
      body: {
        kind: "tool",
        url: makeRepo(server.tmpDir, {
          "agent-package.json": JSON.stringify({ name: "tool-y" }),
        }),
        ref: "HEAD",
      },
    });

    const aliceList = (
      (await api(server, "GET", "/api/assets", { token: alice.token }))
        .body as AssetMeta[]
    ).map((m) => m.asset_id);
    const bobShared = (
      (
        await api(server, "GET", "/api/assets?scope=shared", {
          token: bob.token,
        })
      ).body as AssetMeta[]
    ).map((m) => m.asset_id);
    const bobMine = (
      (await api(server, "GET", "/api/assets?scope=mine", { token: bob.token }))
        .body as AssetMeta[]
    ).map((m) => m.asset_id);
    const adminAll = (
      (await api(server, "GET", "/api/assets", { token: adminToken }))
        .body as AssetMeta[]
    ).map((m) => m.asset_id);

    // alice 可见 = 自己的（package ×2：普通 + 私有）+ bob 的共享 tool；看不到 bob 的非共享 tool
    const bobPrivateTool = bobMine.filter((id) => !bobShared.includes(id));
    expect(bobPrivateTool.length).toBeGreaterThan(0);
    for (const id of bobPrivateTool) {
      expect(aliceList).not.toContain(id);
    }
    for (const id of bobShared) {
      expect(aliceList).toContain(id);
    }
    // admin 全部 = alice 可见 + bob 非共享
    expect(adminAll.length).toBe(
      new Set([...aliceList, ...bobPrivateTool]).size,
    );
    // scope=mine 只有自己的
    for (const id of bobMine) {
      expect(bobMine).toContain(id);
    }
    const aliceMine = (
      (
        await api(server, "GET", "/api/assets?scope=mine", {
          token: alice.token,
        })
      ).body as AssetMeta[]
    ).every((m) => m.owner_id === alice.user_id);
    expect(aliceMine).toBe(true);
  });

  it("kind/scope 非法 → 400", async () => {
    const badKind = await api(server, "GET", "/api/assets?kind=widget", {
      token: alice.token,
    });
    expect(badKind.status).toBe(400);
    const badScope = await api(server, "GET", "/api/assets?scope=everything", {
      token: alice.token,
    });
    expect(badScope.status).toBe(400);
  });
});

describe("GET /api/assets/:id 详情", () => {
  it("详情触发物化 → meta + manifest；不存在 → 404", async () => {
    const { meta } = await registerAsset(alice.token);
    const res = await api(server, "GET", `/api/assets/${meta.asset_id}`, {
      token: bob.token, // 读不设限：登录即可
    });
    expect(res.status).toBe(200);
    const obj = res.body as AssetObject;
    expect(obj.meta.asset_id).toBe(meta.asset_id);
    expect((obj.manifest as AssetManifest & { name: string }).name).toBe(
      "demo",
    );

    const missing = await api(
      server,
      "GET",
      "/api/assets/ast_0000000000000000",
      {
        token: alice.token,
      },
    );
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /api/assets/:id 下架", () => {
  it("属主下架 → 204；再登记同三元组 → 同 asset_id", async () => {
    const { meta } = await registerAsset(alice.token);
    const del = await api(server, "DELETE", `/api/assets/${meta.asset_id}`, {
      token: alice.token,
    });
    expect(del.status).toBe(204);
    const after = await api(server, "GET", `/api/assets/${meta.asset_id}`, {
      token: alice.token,
    });
    expect(after.status).toBe(404);

    const again = await registerAsset(alice.token);
    expect(again.meta.asset_id).toBe(meta.asset_id);
  });

  it("非属主下架 → 403（member 他人与 admin 都非属主）", async () => {
    const { meta } = await registerAsset(alice.token);
    const byBob = await api(server, "DELETE", `/api/assets/${meta.asset_id}`, {
      token: bob.token,
    });
    expect(byBob.status).toBe(403);
    const byAdmin = await api(
      server,
      "DELETE",
      `/api/assets/${meta.asset_id}`,
      { token: adminToken },
    );
    expect(byAdmin.status).toBe(403);
    // 清理
    await api(server, "DELETE", `/api/assets/${meta.asset_id}`, {
      token: alice.token,
    });
  });
});
