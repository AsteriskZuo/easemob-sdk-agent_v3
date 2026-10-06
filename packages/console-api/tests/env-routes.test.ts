import { jest } from "@jest/globals";
import type { EnvListView } from "../src/index.js";
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
let businessId: string;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  owner = await createMemberAndLogin(server, adminToken, "owner");
  other = await createMemberAndLogin(server, adminToken, "other");
  const res = await api(server, "POST", "/api/businesses", {
    token: owner.token,
    body: {
      business_name: "环境配置业务",
      source: "jira",
      event_type: "issue.created",
    },
  });
  businessId = (res.body as { business_id: string }).business_id;
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("通用层 /api/env/global", () => {
  it("member 可读：vars 明文、secrets 只见键名不见值", async () => {
    await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "vars", key: "REGION", value: "cn" },
    });
    await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "secrets", key: "API_TOKEN", value: "SECRET_VALUE" },
    });
    const res = await api(server, "GET", "/api/env/global", {
      token: other.token,
    });
    expect(res.status).toBe(200);
    const view = res.body as EnvListView;
    expect(view.vars.REGION).toBe("cn");
    expect(view.secret_keys).toContain("API_TOKEN");
    expect(JSON.stringify(view)).not.toContain("SECRET_VALUE");
  });

  it("member 写/删 → 403；admin 写/删 → 204", async () => {
    const put = await api(server, "PUT", "/api/env/global", {
      token: owner.token,
      body: { bucket: "vars", key: "X", value: "1" },
    });
    expect(put.status).toBe(403);
    const del = await api(server, "DELETE", "/api/env/global", {
      token: owner.token,
      body: { bucket: "vars", key: "REGION" },
    });
    expect(del.status).toBe(403);

    const adminPut = await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "vars", key: "X", value: "1" },
    });
    expect(adminPut.status).toBe(204);
    const adminDel = await api(server, "DELETE", "/api/env/global", {
      token: adminToken,
      body: { bucket: "vars", key: "X" },
    });
    expect(adminDel.status).toBe(204);
  });
});

describe("业务层 /api/env/businesses/:id", () => {
  it("creator 写 → 204；他人 member → 403；admin → 204；读 = 登录即可", async () => {
    const byOwner = await api(
      server,
      "PUT",
      `/api/env/businesses/${businessId}`,
      { token: owner.token, body: { bucket: "vars", key: "K", value: "v1" } },
    );
    expect(byOwner.status).toBe(204);

    const byOther = await api(
      server,
      "PUT",
      `/api/env/businesses/${businessId}`,
      { token: other.token, body: { bucket: "vars", key: "K", value: "v2" } },
    );
    expect(byOther.status).toBe(403);

    const byAdmin = await api(
      server,
      "PUT",
      `/api/env/businesses/${businessId}`,
      {
        token: adminToken,
        body: { bucket: "secrets", key: "BIZ_SECRET", value: "S3CRET" },
      },
    );
    expect(byAdmin.status).toBe(204);

    const read = await api(server, "GET", `/api/env/businesses/${businessId}`, {
      token: other.token,
    });
    expect(read.status).toBe(200);
    const view = read.body as EnvListView;
    expect(view.vars.K).toBe("v1");
    expect(view.secret_keys).toContain("BIZ_SECRET");
    expect(JSON.stringify(view)).not.toContain("S3CRET");

    const delByOther = await api(
      server,
      "DELETE",
      `/api/env/businesses/${businessId}`,
      { token: other.token, body: { bucket: "vars", key: "K" } },
    );
    expect(delByOther.status).toBe(403);
    const delByOwner = await api(
      server,
      "DELETE",
      `/api/env/businesses/${businessId}`,
      { token: owner.token, body: { bucket: "vars", key: "K" } },
    );
    expect(delByOwner.status).toBe(204);
  });

  it("不存在业务 → 404", async () => {
    const res = await api(server, "GET", "/api/env/businesses/b_nope", {
      token: owner.token,
    });
    expect(res.status).toBe(404);
    const put = await api(server, "PUT", "/api/env/businesses/b_nope", {
      token: adminToken,
      body: { bucket: "vars", key: "K", value: "v" },
    });
    expect(put.status).toBe(404);
  });
});

describe("入参校验", () => {
  it("key 含空白 → 400；bucket 非法 → 400；value 非字符串 → 400", async () => {
    const blankKey = await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "vars", key: " bad-key", value: "1" },
    });
    expect(blankKey.status).toBe(400);
    const badBucket = await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "secret", key: "K", value: "1" },
    });
    expect(badBucket.status).toBe(400);
    const badValue = await api(server, "PUT", "/api/env/global", {
      token: adminToken,
      body: { bucket: "vars", key: "K", value: 42 },
    });
    expect(badValue.status).toBe(400);
  });
});
