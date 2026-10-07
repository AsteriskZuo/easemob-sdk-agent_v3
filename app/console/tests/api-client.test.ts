import { apiFetch, ApiError, setUnauthorizedHandler } from "../src/api/client";
import { installFetchMock } from "./helpers";

afterEach(() => {
  setUnauthorizedHandler(null);
});

describe("apiFetch", () => {
  it("成功：解析 JSON 返回", async () => {
    installFetchMock(() => ({ status: 200, body: { hello: "world" } }));
    const data = await apiFetch<{ hello: string }>("/api/whatever");
    expect(data).toEqual({ hello: "world" });
  });

  it("错误体 → ApiError（code/status 保留）", async () => {
    installFetchMock(() => ({
      status: 403,
      body: { error: { code: "forbidden", message: "无权操作" } },
    }));
    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe("forbidden");
    expect(apiErr.message).toBe("无权操作");
    expect(apiErr.status).toBe(403);
  });

  it("非错误体 500 → internal", async () => {
    installFetchMock(() => ({ status: 500, body: "not json body" }));
    // 注意：fetch stub 会把 string body 序列化成 JSON 字符串，内容仍非错误体结构
    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("internal");
    expect((err as ApiError).status).toBe(500);
  });

  it("401 触发注入的 onUnauthorized 回调", async () => {
    installFetchMock(() => ({
      status: 401,
      body: { error: { code: "unauthenticated", message: "未登录" } },
    }));
    // 不用 jest.fn：esbuild --bundle 会把 @jest/globals 打进产物，脱离 jest 模块注册表报错
    let calls = 0;
    setUnauthorizedHandler(() => {
      calls += 1;
    });
    await expect(apiFetch("/api/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  it("DELETE 带 body：JSON.stringify + content-type", async () => {
    const calls = installFetchMock(() => ({ status: 204 }));
    await apiFetch<void>("/api/businesses/b1/matches", {
      method: "DELETE",
      body: { source: "manual", event_type: "test.ping" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].body).toEqual({
      source: "manual",
      event_type: "test.ping",
    });
    expect(calls[0].headers?.["Content-Type"]).toBe("application/json");
  });

  it("204 无体 → undefined", async () => {
    installFetchMock(() => ({ status: 204 }));
    await expect(
      apiFetch<void>("/api/x", { method: "POST" }),
    ).resolves.toBeUndefined();
  });
});
