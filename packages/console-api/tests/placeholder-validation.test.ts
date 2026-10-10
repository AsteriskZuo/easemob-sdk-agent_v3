import { jest } from "@jest/globals";
import type { ApiErrorBody, BusinessProfile } from "../src/index.js";
import {
  api,
  createMemberAndLogin,
  loginToken,
  resetTestLogger,
  startTestServer,
} from "./helpers.js";
import type { TestServer } from "./helpers.js";

jest.setTimeout(30000);

let server: TestServer;
let adminToken: string;
let owner: { user_id: string; token: string };
let businessId: string;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  owner = await createMemberAndLogin(server, adminToken, "owner");
  const res = await api(server, "POST", "/api/businesses", {
    token: owner.token,
    body: {
      business_name: "占位校验业务",
      source: "jira",
      event_type: "issue.created",
    },
  });
  businessId = (res.body as BusinessProfile).business_id;
  // 四桶各置一个键：业务 secrets / 业务 vars / 全局 secrets / 全局 vars
  server.env.set(businessId, "secrets", "BIZ_SECRET", "s3cret");
  server.env.set(businessId, "vars", "BIZ_VAR", "v1");
  server.env.set(null, "secrets", "GLOBAL_SECRET", "g3cret");
  server.env.set(null, "vars", "GLOBAL_VAR", "g1");
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

function errorOf(res: { body: unknown }): { code: string; message: string } {
  return (res.body as ApiErrorBody).error;
}

describe("POST /api/businesses（创建）", () => {
  it("entry_config 占位命中全局 vars、exit_bindings 占位命中全局 secrets → 201", async () => {
    const res = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: {
        business_name: "全局桶命中",
        source: "webhook",
        event_type: "hook.a",
        entry_config: { path: "hook-a", token: "{{GLOBAL_VAR}}" },
        exit_bindings: [
          {
            tool: "wecom-webhook",
            config: { url: "https://x?key={{GLOBAL_SECRET}}" },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
  });

  it("占位 key 缺失 → 400 invalid_input，message 列出缺失 key 与提示；业务已回滚不落库", async () => {
    const before = await api(server, "GET", "/api/businesses", {
      token: owner.token,
    });
    const countBefore = (before.body as BusinessProfile[]).length;

    const res = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: {
        business_name: "缺键业务",
        source: "webhook",
        event_type: "hook.b",
        entry_config: { path: "hook-b", token: "{{NO_SUCH_KEY}}" },
        exit_bindings: [
          { tool: "wecom-webhook", config: { url: "{{NO_SUCH_URL}}" } },
        ],
      },
    });
    expect(res.status).toBe(400);
    const err = errorOf(res);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("NO_SUCH_KEY");
    expect(err.message).toContain("请先在业务/通用环境配置中创建对应键");

    const after = await api(server, "GET", "/api/businesses", {
      token: owner.token,
    });
    expect((after.body as BusinessProfile[]).length).toBe(countBefore);
  });
});

describe("POST /api/businesses/:id/matches（新增匹配行）", () => {
  it("占位命中业务 vars / 业务 secrets → 201", async () => {
    const byVar = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/matches`,
      {
        token: owner.token,
        body: {
          source: "webhook",
          event_type: "hook.var",
          entry_config: { path: "hook-var", token: "{{BIZ_VAR}}" },
        },
      },
    );
    expect(byVar.status).toBe(201);
    const bySecret = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/matches`,
      {
        token: owner.token,
        body: {
          source: "webhook",
          event_type: "hook.secret",
          entry_config: { path: "hook-secret", token: "{{BIZ_SECRET}}" },
        },
      },
    );
    expect(bySecret.status).toBe(201);
  });

  it("多个占位 key 缺失 → 400，message 一次列全（排序）", async () => {
    const res = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/matches`,
      {
        token: owner.token,
        body: {
          source: "webhook",
          event_type: "hook.missing",
          entry_config: {
            path: "hook-missing",
            token: "{{MISSING_B}}",
            extra: "x-{{MISSING_A}}-{{BIZ_VAR}}",
          },
        },
      },
    );
    expect(res.status).toBe(400);
    const err = errorOf(res);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("MISSING_A, MISSING_B");
    expect(err.message).not.toContain("BIZ_VAR");
    expect(err.message).toContain("请先在业务/通用环境配置中创建对应键");
  });

  it("entry_config 无占位 → 不校验，直接放行", async () => {
    const res = await api(
      server,
      "POST",
      `/api/businesses/${businessId}/matches`,
      {
        token: owner.token,
        body: {
          source: "webhook",
          event_type: "hook.plain",
          entry_config: { path: "hook-plain", token: "plain-token" },
        },
      },
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /api/businesses 随建环境配置（env 字段）", () => {
  it("env vars+secrets 随建 → 键落该业务两桶；entry_config 占位命中新键 → 201", async () => {
    const res = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: {
        business_name: "随建环境配置",
        source: "webhook",
        entry_config: {
          path: "hook-env",
          session_id_key: "id",
          token: "{{hook_token}}",
          note: "{{hook_note}}",
        },
        env: {
          vars: { hook_note: "n1" },
          secrets: { hook_token: "t1" },
        },
      },
    });
    expect(res.status).toBe(201);
    const id = (res.body as BusinessProfile).business_id;
    const listing = server.env.list(id);
    expect(listing.vars).toEqual({ hook_note: "n1" });
    expect(listing.secret_keys).toEqual(["hook_token"]);
  });

  it("env 形状非法（非 object / 值非字符串 / 空键）→ 400，不落库", async () => {
    const before = (
      (await api(server, "GET", "/api/businesses", { token: owner.token }))
        .body as BusinessProfile[]
    ).length;
    for (const env of [
      "not-object",
      { vars: { k: 1 } },
      { vars: { "": "v" } },
    ]) {
      const res = await api(server, "POST", "/api/businesses", {
        token: owner.token,
        body: {
          business_name: "非法 env",
          source: "webhook",
          event_type: "hook.bad-env",
          env,
        },
      });
      expect(res.status).toBe(400);
    }
    const after = (
      (await api(server, "GET", "/api/businesses", { token: owner.token }))
        .body as BusinessProfile[]
    ).length;
    expect(after).toBe(before);
  });

  it("占位 key 缺失 → 400；业务与本次写入的 env 键都回滚", async () => {
    const countBefore = (
      (await api(server, "GET", "/api/businesses", { token: owner.token }))
        .body as BusinessProfile[]
    ).length;
    const envRowsBefore = server.db.all<{ scope: string }>(
      "SELECT scope FROM env_entries",
    ).length;

    const res = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: {
        business_name: "回滚业务",
        source: "webhook",
        entry_config: {
          path: "hook-rollback",
          session_id_key: "id",
          token: "{{GHOST_ENV_KEY}}",
        },
        env: {
          vars: { hook_note: "n1" },
          secrets: { hook_token: "t1" },
        },
      },
    });
    expect(res.status).toBe(400);
    const err = errorOf(res);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("GHOST_ENV_KEY");

    // 业务回滚：计数不变；env 键回滚：env_entries 行数不变
    const countAfter = (
      (await api(server, "GET", "/api/businesses", { token: owner.token }))
        .body as BusinessProfile[]
    ).length;
    expect(countAfter).toBe(countBefore);
    const envRowsAfter = server.db.all<{ scope: string }>(
      "SELECT scope FROM env_entries",
    ).length;
    expect(envRowsAfter).toBe(envRowsBefore);
  });
});

describe("PATCH /api/businesses/:id（更新 exit_bindings）", () => {
  it("绑定 config 占位命中业务 secrets → 204", async () => {
    const res = await api(server, "PATCH", `/api/businesses/${businessId}`, {
      token: owner.token,
      body: {
        exit_bindings: [
          {
            tool: "wecom-webhook",
            config: { url: "https://x?key={{BIZ_SECRET}}" },
          },
        ],
      },
    });
    expect(res.status).toBe(204);
  });

  it("绑定 config 占位缺失 → 400，既有绑定不被覆盖", async () => {
    const res = await api(server, "PATCH", `/api/businesses/${businessId}`, {
      token: owner.token,
      body: {
        exit_bindings: [
          { tool: "wecom-webhook", config: { url: "{{GHOST_KEY}}" } },
        ],
      },
    });
    expect(res.status).toBe(400);
    const err = errorOf(res);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("GHOST_KEY");

    const detail = await api(server, "GET", `/api/businesses/${businessId}`, {
      token: owner.token,
    });
    const body = detail.body as {
      exit_bindings: Array<{ config: Record<string, string> }>;
    };
    expect(body.exit_bindings[0]?.config.url).toBe(
      "https://x?key={{BIZ_SECRET}}",
    );
  });
});
