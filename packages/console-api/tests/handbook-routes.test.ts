import { jest } from "@jest/globals";
import type { HandbookPage } from "../src/index.js";
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
let token: string;

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  const adminToken = await loginToken(server, "admin", "admin-pass");
  token = (await createMemberAndLogin(server, adminToken, "member1")).token;
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("GET /api/handbook/:page", () => {
  it("返回业务编辑页生成物，保留稳定 id、正文与展示位置", async () => {
    const res = await api(server, "GET", "/api/handbook/business-edit", {
      token,
    });
    expect(res.status).toBe(200);
    const page = res.body as HandbookPage;
    expect(page["console.business-edit.assets.tip"]).toMatchObject({
      status: "stable",
      surfaces: [
        { type: "console", at: "business-edit.assets", display: "tip" },
      ],
    });
    expect(page["console.business-edit.assets.tip"].body.cn).toContain(
      "统一更新队列",
    );
    expect(
      page["console.business-edit.assets.detail"].surfaces[0].display,
    ).toBe("drawer");
  });

  it("未知页面返回 404", async () => {
    const res = await api(server, "GET", "/api/handbook/not-a-page", { token });
    expect(res.status).toBe(404);
  });

  it("未登录返回 401", async () => {
    const res = await api(server, "GET", "/api/handbook/business-edit", {});
    expect(res.status).toBe(401);
  });
});
