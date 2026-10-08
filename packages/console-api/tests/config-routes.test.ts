import { jest } from "@jest/globals";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EffectiveConfigView, ExitToolMenuItem } from "../src/index.js";
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
let member: { user_id: string; token: string };

beforeAll(async () => {
  server = await startTestServer({
    bootstrap_admin: { username: "admin", password: "admin-pass" },
  });
  adminToken = await loginToken(server, "admin", "admin-pass");
  member = await createMemberAndLogin(server, adminToken, "member1");
});

afterAll(async () => {
  await server.stop();
  resetTestLogger();
});

describe("GET /api/config", () => {
  it("含 entry_adapters（自描述 + 当前开关状态）", async () => {
    const res = await api(server, "GET", "/api/config", {
      token: member.token,
    });
    expect(res.status).toBe(200);
    const view = res.body as EffectiveConfigView;
    expect(view.entry_adapters).toHaveLength(2);
    const webhook = view.entry_adapters.find((a) => a.id === "webhook");
    expect(webhook).toMatchObject({
      kind: "webhook",
      name: "自定义 Webhook",
      defaultEnabled: true,
      enabled: true,
    });
    expect(webhook?.configSchema.length).toBeGreaterThan(0);
    expect(webhook?.eventDoc).toContain("Webhook");
    const jira = view.entry_adapters.find((a) => a.id === "jira-polling");
    expect(jira).toMatchObject({
      kind: "jira",
      defaultEnabled: false,
      enabled: false,
    });
  });
});

describe("GET /api/exit-tools", () => {
  it("每项追加 resultDoc（markdown，非空）", async () => {
    const res = await api(server, "GET", "/api/exit-tools", {
      token: member.token,
    });
    expect(res.status).toBe(200);
    const menu = res.body as ExitToolMenuItem[];
    expect(menu.length).toBe(7);
    for (const tool of menu) {
      expect(typeof tool.resultDoc).toBe("string");
      expect(tool.resultDoc.length).toBeGreaterThan(0);
    }
    // 抽查关键工具的对接形状写进了文档
    const wecom = menu.find((t) => t.kind === "wecom-webhook");
    expect(wecom?.resultDoc).toContain("content");
    expect(wecom?.resultDoc).toContain("mentions");
    const github = menu.find((t) => t.kind === "github");
    expect(github?.resultDoc).toContain("op");
  });
});

describe("POST /api/cache/clear", () => {
  it("member → 403 forbidden", async () => {
    const res = await api(server, "POST", "/api/cache/clear", {
      token: member.token,
    });
    expect(res.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    const res = await api(server, "POST", "/api/cache/clear", {});
    expect(res.status).toBe(401);
  });

  it("admin → 200 { cleared: true } 且缓存目录被清空；目录不存在时同样 200", async () => {
    // 先造一个缓存目录内容（模拟已物化的资产）
    const cacheRoot = join(server.tmpDir, "cache", "assets");
    mkdirSync(join(cacheRoot, "ast_fake"), { recursive: true });
    writeFileSync(join(cacheRoot, "ast_fake", "marker"), "x");
    expect(existsSync(join(cacheRoot, "ast_fake", "marker"))).toBe(true);

    const res = await api(server, "POST", "/api/cache/clear", {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true });
    expect(existsSync(join(cacheRoot, "ast_fake"))).toBe(false);

    // 目录内容已空（cacheRoot 本身保留或不存在均可，再调一次幂等 200）
    const again = await api(server, "POST", "/api/cache/clear", {
      token: adminToken,
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ cleared: true });
  });
});
