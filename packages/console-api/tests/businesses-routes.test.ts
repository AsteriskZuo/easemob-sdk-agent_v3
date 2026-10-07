import { jest } from "@jest/globals";
import type {
  BusinessDetail,
  BusinessMatch,
  BusinessProfile,
} from "../src/index.js";
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
let other: { user_id: string; token: string };

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  owner = await createMemberAndLogin(server, adminToken, "owner");
  other = await createMemberAndLogin(server, adminToken, "other");
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

async function createBusiness(
  token: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<BusinessProfile> {
  const res = await api(server, "POST", "/api/businesses", {
    token,
    body: {
      business_name: name,
      source: "jira",
      event_type: "issue.created",
      ...extra,
    },
  });
  expect(res.status).toBe(201);
  return res.body as BusinessProfile;
}

describe("POST /api/businesses", () => {
  it("创建 → 201 返回 profile（creator_id = 操作者）；entry_config 透传到首个匹配行", async () => {
    const profile = await createBusiness(owner.token, "审查工单", {
      prompt: "总纲",
      entry_config: { filter: { level: "p1" } },
      exit_bindings: [{ tool: "webhook", config: { url: "https://x" } }],
    });
    expect(profile.business_id).toMatch(/^b/);
    expect(profile.creator_id).toBe(owner.user_id);
    expect(profile.prompt).toBe("总纲");
    expect(profile.model).toBe("");
    expect(profile.agent_kind).toBe("pi");

    const detail = await api(
      server,
      "GET",
      `/api/businesses/${profile.business_id}`,
      { token: other.token },
    );
    expect(detail.status).toBe(200);
    const body = detail.body as BusinessDetail;
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].entry_config).toEqual({ filter: { level: "p1" } });
    expect(body.exit_bindings).toEqual([
      {
        business_id: profile.business_id,
        tool: "webhook",
        config: { url: "https://x" },
      },
    ]);
  });

  it("business_name 空 / source 非法 / event_type 空 → 400", async () => {
    const noName = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: { business_name: "", source: "jira", event_type: "x" },
    });
    expect(noName.status).toBe(400);
    const badSource = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: { business_name: "x", source: "telegram", event_type: "x" },
    });
    expect(badSource.status).toBe(400);
    const noType = await api(server, "POST", "/api/businesses", {
      token: owner.token,
      body: { business_name: "x", source: "jira", event_type: "" },
    });
    expect(noType.status).toBe(400);
  });
});

describe("GET /api/businesses + GET /api/businesses/:id", () => {
  it("列表返回全部业务 profile；详情 = profile + matches + exit_bindings；不存在 → 404", async () => {
    const a = await createBusiness(owner.token, "业务A");
    const b = await createBusiness(other.token, "业务B");
    const list = await api(server, "GET", "/api/businesses", {
      token: other.token,
    });
    expect(list.status).toBe(200);
    const ids = (list.body as BusinessProfile[]).map((p) => p.business_id);
    expect(ids).toContain(a.business_id);
    expect(ids).toContain(b.business_id);

    const detail = await api(
      server,
      "GET",
      `/api/businesses/${a.business_id}`,
      {
        token: other.token,
      },
    );
    expect(detail.status).toBe(200);
    expect((detail.body as BusinessDetail).profile.business_id).toBe(
      a.business_id,
    );

    const missing = await api(server, "GET", "/api/businesses/b_nope", {
      token: owner.token,
    });
    expect(missing.status).toBe(404);
  });
});

describe("PATCH /api/businesses/:id", () => {
  it("creator 可改；他人 member 403；admin 可改；quota null 清除覆盖", async () => {
    const profile = await createBusiness(owner.token, "待更新", {
      timeout_minutes: 30,
    });
    const url = `/api/businesses/${profile.business_id}`;

    const byOther = await api(server, "PATCH", url, {
      token: other.token,
      body: { business_name: "越权改名" },
    });
    expect(byOther.status).toBe(403);

    const byOwner = await api(server, "PATCH", url, {
      token: owner.token,
      body: { business_name: "新名", prompt: "新总纲" },
    });
    expect(byOwner.status).toBe(204);
    let detail = (
      (await api(server, "GET", url, { token: owner.token }))
        .body as BusinessDetail
    ).profile;
    expect(detail.business_name).toBe("新名");
    expect(detail.prompt).toBe("新总纲");
    expect(detail.timeout_minutes).toBe(30);

    const byAdmin = await api(server, "PATCH", url, {
      token: adminToken,
      body: { timeout_minutes: null, max_agent_calls: 5 },
    });
    expect(byAdmin.status).toBe(204);
    detail = (
      (await api(server, "GET", url, { token: owner.token }))
        .body as BusinessDetail
    ).profile;
    expect(detail.timeout_minutes).toBeUndefined();
    expect(detail.max_agent_calls).toBe(5);
  });

  it("白名单外字段 → 400；exit_bindings 全量替换", async () => {
    const profile = await createBusiness(owner.token, "白名单", {
      exit_bindings: [{ tool: "webhook", config: { url: "https://a" } }],
    });
    const url = `/api/businesses/${profile.business_id}`;
    const unknown = await api(server, "PATCH", url, {
      token: owner.token,
      body: { creator_id: "usr_hack" },
    });
    expect(unknown.status).toBe(400);

    const replace = await api(server, "PATCH", url, {
      token: owner.token,
      body: { exit_bindings: [{ tool: "mail", config: { to: "a@b.c" } }] },
    });
    expect(replace.status).toBe(204);
    const detail = (await api(server, "GET", url, { token: owner.token }))
      .body as BusinessDetail;
    expect(detail.exit_bindings).toEqual([
      {
        business_id: profile.business_id,
        tool: "mail",
        config: { to: "a@b.c" },
      },
    ]);
  });
});

describe("匹配行增删", () => {
  it("POST matches → 201；重复添加幂等；DELETE matches → 204 且再删幂等", async () => {
    const profile = await createBusiness(owner.token, "多入口");
    const url = `/api/businesses/${profile.business_id}`;

    const add = await api(server, "POST", `${url}/matches`, {
      token: owner.token,
      body: { source: "webhook", event_type: "alert", entry_config: { k: 1 } },
    });
    expect(add.status).toBe(201);
    expect(add.body as BusinessMatch[]).toHaveLength(2);

    // 重复添加幂等（行数不增）
    const dup = await api(server, "POST", `${url}/matches`, {
      token: owner.token,
      body: { source: "webhook", event_type: "alert" },
    });
    expect(dup.status).toBe(201);
    expect(dup.body as BusinessMatch[]).toHaveLength(2);

    const del = await api(server, "DELETE", `${url}/matches`, {
      token: owner.token,
      body: { source: "webhook", event_type: "alert" },
    });
    expect(del.status).toBe(204);
    const again = await api(server, "DELETE", `${url}/matches`, {
      token: owner.token,
      body: { source: "webhook", event_type: "alert" },
    });
    expect(again.status).toBe(204);

    // 他人 member 增删匹配行 → 403
    const forbidden = await api(server, "POST", `${url}/matches`, {
      token: other.token,
      body: { source: "cron", event_type: "tick" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("不存在业务的匹配行增删 → 404", async () => {
    const res = await api(server, "POST", "/api/businesses/b_nope/matches", {
      token: owner.token,
      body: { source: "cron", event_type: "tick" },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/businesses/:id", () => {
  it("creator 删除 → 204；删后 GET → 404；他人删除 → 403", async () => {
    const mine = await createBusiness(owner.token, "删我");
    const byOther = await api(
      server,
      "DELETE",
      `/api/businesses/${mine.business_id}`,
      { token: other.token },
    );
    expect(byOther.status).toBe(403);

    const del = await api(
      server,
      "DELETE",
      `/api/businesses/${mine.business_id}`,
      { token: owner.token },
    );
    expect(del.status).toBe(204);
    const after = await api(
      server,
      "GET",
      `/api/businesses/${mine.business_id}`,
      { token: owner.token },
    );
    expect(after.status).toBe(404);
  });
});
