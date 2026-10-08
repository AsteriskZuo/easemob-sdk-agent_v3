import { screen, waitFor, within } from "@testing-library/react";
import {
  ADMIN_USER,
  MEMBER_USER,
  installFetchMock,
  renderApp,
  setupUser,
} from "./helpers";

const CONFIG_VIEW = {
  workspace: "/data/workspace",
  log_level: "info",
  log_enabled: true,
  hop_limit: 8,
  task_concurrency: 4,
  result_concurrency: 16,
  task_timeout_minutes: 60,
  max_agent_calls: 20,
  pi_cli_path: "/usr/local/bin/pi",
  pi_agent_dir: "/opt/pi-agent",
  entry_adapters: [
    {
      id: "webhook",
      kind: "webhook",
      name: "自定义 Webhook",
      defaultEnabled: true,
      enabled: true,
      configSchema: [],
      eventDoc: "# doc",
    },
  ],
};

describe("页面冒烟", () => {
  it("Dashboard：队列卡片渲染 mock 计数", async () => {
    installFetchMock((path) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/monitor/queues") {
        return {
          status: 200,
          body: {
            entry: { pending: 7, processing: 2, done: 30, dead: 1 },
            exit: { pending: 0, processing: 0, done: 9, dead: 0 },
          },
        };
      }
      if (path === "/api/businesses") return { status: 200, body: [] };
      return undefined;
    });
    renderApp("/");

    const entryCard = (await screen.findByText("入口队列")).closest(
      ".ant-card",
    );
    expect(entryCard).not.toBeNull();
    // 入口队列 pending = 7
    expect(within(entryCard as HTMLElement).getByText("7")).toBeTruthy();
    expect(screen.getByText("出口队列")).toBeTruthy();
  });

  it("Settings：config 只读展示；admin 可编辑通用层，member 隐藏编辑入口", async () => {
    const installSettingsMocks = (me: typeof ADMIN_USER) =>
      installFetchMock((path) => {
        if (path === "/api/auth/me") return { status: 200, body: me };
        if (path === "/api/config") return { status: 200, body: CONFIG_VIEW };
        if (path === "/api/env/global") {
          return {
            status: 200,
            body: { vars: { FOO: "bar" }, secret_keys: ["jira_token"] },
          };
        }
        return undefined;
      });

    // admin：编辑入口可见
    installSettingsMocks(ADMIN_USER);
    const adminView = renderApp("/settings");
    expect(await screen.findByText("工作目录")).toBeTruthy();
    expect(screen.getByText("/data/workspace")).toBeTruthy();
    expect(screen.getByText("bar")).toBeTruthy(); // vars 明文回显
    expect(screen.getByText("jira_token")).toBeTruthy(); // secret 只见键名
    expect(
      screen.getAllByRole("button", { name: /^新\s?增$/ }).length,
    ).toBeGreaterThan(0);
    adminView.unmount();

    // member：只读（编辑按钮隐藏）
    installSettingsMocks(MEMBER_USER);
    renderApp("/settings");
    expect(await screen.findByText("工作目录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^新\s?增$/ })).toBeNull();
    // member 不见缓存清理入口（仅 admin）
    expect(screen.queryByRole("button", { name: /清理资产缓存/ })).toBeNull();
  });

  it("Settings：admin 清理资产缓存——确认弹窗写明后果，确认后调 POST /api/cache/clear", async () => {
    const calls = installFetchMock((path, { method }) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/config") return { status: 200, body: CONFIG_VIEW };
      if (path === "/api/env/global") {
        return { status: 200, body: { vars: {}, secret_keys: [] } };
      }
      if (path === "/api/cache/clear" && method === "POST") {
        return { status: 200, body: { cleared: true } };
      }
      return undefined;
    });
    renderApp("/settings");
    const user = setupUser();

    // 入口适配器回显（名称 + 开关状态）
    expect(
      await screen.findByText(/自定义 Webhook（webhook，开）/),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /清理资产缓存/ }));
    // 确认弹窗写明后果（重新物化构建、耗时分钟级）
    expect(await screen.findByText(/重新物化构建/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^清\s?理$/ }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/cache/clear"),
      ).toBe(true);
    });
    expect(await screen.findByText("资产缓存已清理")).toBeTruthy();
  });

  it("Users：admin 表格渲染 + 停用确认", async () => {
    const memberUser = {
      user_id: "usr_m9",
      username: "bob",
      display_name: "鲍勃",
      role: "member",
      disabled: false,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const calls = installFetchMock((path, { method }) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/users" && method === "GET") {
        return { status: 200, body: [ADMIN_USER, memberUser] };
      }
      if (path === "/api/users/usr_m9/disabled" && method === "POST") {
        return { status: 204 };
      }
      return undefined;
    });
    renderApp("/users");

    // 表格渲染两行
    expect(await screen.findByText("鲍勃")).toBeTruthy();
    expect(screen.getByText("root")).toBeTruthy();

    // 停用需确认
    const user = setupUser();
    await user.click(screen.getByRole("button", { name: /^停\s?用$/ }));
    expect(await screen.findByText(/确认停用「鲍勃」/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^确\s?认$/ }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === "POST" && c.path === "/api/users/usr_m9/disabled",
        ),
      ).toBe(true);
    });
    const disableCall = calls.find(
      (c) => c.method === "POST" && c.path === "/api/users/usr_m9/disabled",
    );
    expect(disableCall?.body).toEqual({ disabled: true });
  });
});
