import { screen, waitFor } from "@testing-library/react";
import { ADMIN_USER, installFetchMock, renderApp } from "./helpers";

describe("登录守卫", () => {
  it("me 200 → 渲染子路由（监控仪表盘）", async () => {
    installFetchMock((path) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/monitor/queues") {
        return {
          status: 200,
          body: {
            entry: { pending: 1, processing: 2, done: 3, dead: 0 },
            exit: { pending: 0, processing: 0, done: 5, dead: 1 },
          },
        };
      }
      if (path === "/api/businesses") return { status: 200, body: [] };
      return undefined;
    });
    renderApp("/");
    expect(await screen.findByText("入口队列")).toBeTruthy();
  });

  it("me 401 → 跳 /login（不渲染受保护页）", async () => {
    installFetchMock((path) => {
      if (path === "/api/auth/me") {
        return {
          status: 401,
          body: { error: { code: "unauthenticated", message: "未登录" } },
        };
      }
      return undefined;
    });
    renderApp("/");
    expect(await screen.findByLabelText("用户名")).toBeTruthy();
    expect(screen.queryByText("入口队列")).toBeNull();
  });

  it("me 加载中显示加载态（不闪现登录页）", async () => {
    // me 挂起：由测试末段放行（缺省 no-op 防类型收窄报错）
    let resolveMe: (r: Response) => void = () => {};
    (globalThis as { fetch: unknown }).fetch = (input: unknown) => {
      if (String(input) === "/api/auth/me") {
        return new Promise<Response>((resolve) => {
          resolveMe = resolve;
        });
      }
      return Promise.resolve({
        status: 500,
        ok: false,
        text: () => Promise.resolve(""),
      } as Response);
    };
    renderApp("/");
    // 加载态存在，登录表单未出现
    expect(document.querySelector(".ant-spin")).not.toBeNull();
    expect(screen.queryByLabelText("用户名")).toBeNull();
    // 收尾：放行 me（401 → 登录页），避免悬挂
    resolveMe({
      status: 401,
      ok: false,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: { code: "unauthenticated", message: "未登录" },
          }),
        ),
    } as Response);
    await waitFor(() => expect(screen.getByLabelText("用户名")).toBeTruthy());
  });
});
