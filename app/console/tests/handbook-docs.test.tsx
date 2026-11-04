import { screen } from "@testing-library/react";
import type { HandbookPage } from "@asteriskzuo/agent-console-api";
import { MEMBER_USER, installFetchMock, renderApp, setupUser } from "./helpers";

const HANDBOOK: HandbookPage = {
  "console.business-edit.assets.tip": {
    kind: "section",
    title: { cn: "资产配置" },
    body: { cn: "YAML_TIP_MARKER：这段短提示只来自接口" },
    surfaces: [{ type: "console", at: "business-edit.assets", display: "tip" }],
    status: "stable",
  },
  "console.business-edit.assets.detail": {
    kind: "section",
    title: { cn: "YAML_DRAWER_TITLE" },
    body: { cn: "YAML_DRAWER_MARKER：这段抽屉正文只来自接口" },
    surfaces: [
      { type: "console", at: "business-edit.assets", display: "drawer" },
    ],
    status: "stable",
  },
};

describe("业务编辑页 handbook 接线", () => {
  it("按稳定 id 渲染接口提供的 tip 与 drawer，不依赖静态正文", async () => {
    const calls = installFetchMock((path) => {
      if (path === "/api/auth/me") return { status: 200, body: MEMBER_USER };
      if (path === "/api/handbook/business-edit") {
        return { status: 200, body: HANDBOOK };
      }
      if (path === "/api/config") {
        return {
          status: 200,
          body: { agents: ["pi"], entry_adapters: [] },
        };
      }
      if (path === "/api/exit-tools" || path === "/api/businesses") {
        return { status: 200, body: [] };
      }
      if (path.startsWith("/api/assets?")) {
        return { status: 200, body: [] };
      }
      return undefined;
    });
    renderApp("/businesses/new");
    const user = setupUser();

    const tipIcon = await screen.findByLabelText("资产配置 短提示");
    await user.hover(tipIcon);
    expect(await screen.findByText(/YAML_TIP_MARKER/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "资产配置 详细说明" }));
    expect(await screen.findByText("YAML_DRAWER_TITLE")).toBeTruthy();
    expect(screen.getByText(/YAML_DRAWER_MARKER/)).toBeTruthy();
    expect(
      calls.filter((call) => call.path === "/api/handbook/business-edit"),
    ).toHaveLength(1);
  });
});
