import { screen } from "@testing-library/react";
import { ADMIN_USER, installFetchMock, renderApp, setupUser } from "./helpers";

/** 通用 mock：me 结果可配；dashboard 依赖的两个接口给空数据 */
function installBaseMock(me: { status: number; body?: unknown }) {
  return installFetchMock((path) => {
    if (path === "/api/auth/me") return me;
    if (path === "/api/monitor/queues") {
      return {
        status: 200,
        body: {
          entry: { pending: 0, processing: 0, done: 0, dead: 0 },
          exit: { pending: 0, processing: 0, done: 0, dead: 0 },
        },
      };
    }
    if (path === "/api/businesses") return { status: 200, body: [] };
    return undefined;
  });
}

describe("登录页", () => {
  it("提交调用 login 且成功跳转首页", async () => {
    const calls = installFetchMock((path, { method }) => {
      if (path === "/api/auth/login" && method === "POST") {
        return {
          status: 201,
          body: { user: ADMIN_USER, expires_at: "2026-01-08T00:00:00.000Z" },
        };
      }
      if (path === "/api/auth/me") return { status: 401 };
      if (path === "/api/monitor/queues") {
        return {
          status: 200,
          body: {
            entry: { pending: 0, processing: 0, done: 0, dead: 0 },
            exit: { pending: 0, processing: 0, done: 0, dead: 0 },
          },
        };
      }
      if (path === "/api/businesses") return { status: 200, body: [] };
      return undefined;
    });
    renderApp("/login");

    const user = setupUser();
    await user.type(await screen.findByLabelText("用户名"), "root");
    await user.type(screen.getByLabelText("密码"), "root-pass");
    await user.click(screen.getByRole("button", { name: /^登\s?录$/ }));

    // 登录接口被调用且跳转首页（仪表盘渲染）
    expect(await screen.findByText("入口队列")).toBeTruthy();
    const loginCall = calls.find((c) => c.path === "/api/auth/login");
    expect(loginCall?.body).toEqual({
      username: "root",
      password: "root-pass",
    });
  });

  it("失败展示统一错误文案（不区分原因）", async () => {
    installFetchMock((path, { method }) => {
      if (path === "/api/auth/me") return { status: 401 };
      if (path === "/api/auth/login" && method === "POST") {
        return {
          status: 401,
          body: {
            error: { code: "unauthenticated", message: "用户名或密码错误" },
          },
        };
      }
      if (path === "/api/monitor/queues") return { status: 401 };
      if (path === "/api/businesses") return { status: 401 };
      return undefined;
    });
    renderApp("/login");

    const user = setupUser();
    await user.type(await screen.findByLabelText("用户名"), "root");
    await user.type(screen.getByLabelText("密码"), "wrong");
    await user.click(screen.getByRole("button", { name: /^登\s?录$/ }));

    expect(await screen.findByText("用户名或密码错误")).toBeTruthy();
    // 仍在登录页
    expect(screen.getByLabelText("用户名")).toBeTruthy();
  });

  it("已登录访问 /login → 重定向首页", async () => {
    installBaseMock({ status: 200, body: ADMIN_USER });
    renderApp("/login");
    expect(await screen.findByText("入口队列")).toBeTruthy();
    expect(screen.queryByLabelText("用户名")).toBeNull();
  });
});
