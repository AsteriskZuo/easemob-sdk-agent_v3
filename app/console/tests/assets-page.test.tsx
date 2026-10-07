import { screen, waitFor } from "@testing-library/react";
import type { AssetMeta, User } from "@easemob/agent-console-api";
import {
  ADMIN_USER,
  MEMBER_USER,
  installFetchMock,
  renderApp,
  selectOption,
  setupUser,
} from "./helpers";

const OWN_PACKAGE: AssetMeta = {
  asset_id: "pkg-own-1",
  kind: "package",
  owner_id: MEMBER_USER.user_id,
  shared: false,
  is_private: false,
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-01T00:00:00.000Z",
};

const OTHER_PACKAGE: AssetMeta = {
  ...OWN_PACKAGE,
  asset_id: "pkg-other-1",
  owner_id: "usr_someone_else",
};

/** 资产页 mock：mine 只回自己的；all 回两条（自己的 + 他人的） */
function installAssetMocks(me: User) {
  return installFetchMock((path, { method }) => {
    if (path === "/api/auth/me") return { status: 200, body: me };
    if (path === "/api/assets?kind=package&scope=mine") {
      return { status: 200, body: [OWN_PACKAGE] };
    }
    if (path === "/api/assets?kind=package&scope=all") {
      return { status: 200, body: [OWN_PACKAGE, OTHER_PACKAGE] };
    }
    if (path.startsWith("/api/assets?")) return { status: 200, body: [] };
    if (path === "/api/assets" && method === "POST") {
      return { status: 201, body: OWN_PACKAGE };
    }
    return undefined;
  });
}

describe("资产管理", () => {
  it("登记表单提交映射：package 隐藏 shared 选项", async () => {
    const calls = installAssetMocks(MEMBER_USER);
    renderApp("/assets");
    const user = setupUser();

    // 等待列表加载
    expect(
      await screen.findByText("pkg-own-1…", { exact: false }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "登记资产" }));
    // package 页：不渲染「共享」开关
    expect(screen.queryByLabelText("共享")).toBeNull();

    await user.type(
      screen.getByLabelText("仓库地址"),
      "https://git.example.com/demo.git",
    );
    await user.type(screen.getByLabelText("ref"), "main");
    await user.click(screen.getByRole("button", { name: /^登\s?记$/ }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/assets"),
      ).toBe(true);
    });
    const post = calls.find(
      (c) => c.method === "POST" && c.path === "/api/assets",
    );
    expect(post?.body).toEqual({
      kind: "package",
      url: "https://git.example.com/demo.git",
      ref: "main",
    });
  });

  it("tool 页签显示 shared 开关；is_private 必填 credential_key", async () => {
    const calls = installAssetMocks(MEMBER_USER);
    renderApp("/assets");
    const user = setupUser();

    expect(
      await screen.findByText("pkg-own-1…", { exact: false }),
    ).toBeTruthy();

    // 切到工具页签
    await user.click(screen.getByRole("tab", { name: "工具" }));
    await user.click(screen.getByRole("button", { name: "登记资产" }));
    // 工具页签：「共享」开关可见
    expect(await screen.findByLabelText("共享")).toBeTruthy();

    // 打开私有仓库 → credential_key 必填
    await user.click(screen.getByLabelText("私有仓库"));
    await user.type(
      screen.getByLabelText("仓库地址"),
      "https://git.example.com/tool.git",
    );
    await user.type(screen.getByLabelText("ref"), "main");
    await user.click(screen.getByRole("button", { name: /^登\s?记$/ }));

    // 表单内报错，未提交
    expect(await screen.findByText("私有仓库必须填凭据 key")).toBeTruthy();
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/api/assets"),
    ).toBe(false);
  });

  it("下架按钮仅属主可见", async () => {
    installAssetMocks(MEMBER_USER);
    renderApp("/assets");
    const user = setupUser();

    expect(
      await screen.findByText("pkg-own-1…", { exact: false }),
    ).toBeTruthy();

    // 切到「全部」scope：列表出现他人资产
    await selectOption(user, "范围筛选", "全部");

    expect(
      await screen.findByText("pkg-other-1…", { exact: false }),
    ).toBeTruthy();
    // 两行资产，但只有自己的行有「下架」
    expect(screen.getAllByRole("button", { name: /^下\s?架$/ })).toHaveLength(
      1,
    );
  });

  it("admin 不见登记入口（admin 不持有资产）", async () => {
    installAssetMocks(ADMIN_USER);
    renderApp("/assets");
    // 列表加载完成（admin 默认 scope=mine → 回 OWN_PACKAGE）
    expect(
      await screen.findByText("pkg-own-1…", { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "登记资产" })).toBeNull();
  });
});
