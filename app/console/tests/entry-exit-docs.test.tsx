import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import type { ExitToolMenuItem } from "@asteriskzuo/agent-console-api";
import {
  MEMBER_USER,
  installFetchMock,
  renderApp,
  selectOption,
  setupUser,
} from "./helpers";

/** 出口工具菜单 mock：wecom-webhook 已实现并带 resultDoc */
const EXIT_TOOLS: ExitToolMenuItem[] = [
  {
    kind: "wecom-webhook",
    name: "企业微信群机器人",
    implemented: true,
    configSchema: [{ key: "url", label: "Webhook 地址", required: true }],
    resultDoc:
      "# 企业微信群机器人：sdk.return 期望形状\n\n字符串或 { content, mentions? }",
  },
];

/** 入口适配器 mock（/api/config 的 entry_adapters）：webhook 启用、jira-polling 关闭 */
const ENTRY_ADAPTERS = [
  {
    id: "webhook",
    kind: "webhook",
    name: "自定义 Webhook",
    defaultEnabled: true,
    enabled: true,
    configSchema: [
      { key: "path", label: "URL 路径段", required: true },
      { key: "session_id_key", label: "session_id 字段路径", required: true },
      { key: "token", label: "验签 token" },
    ],
    eventDoc: "# 自定义 Webhook 入口\n\nPOST /hooks/{path}",
  },
  {
    id: "jira-polling",
    kind: "jira",
    name: "Jira 定时轮询",
    defaultEnabled: false,
    enabled: false,
    configSchema: [
      { key: "jira_url", label: "Jira 站点根地址", required: true },
    ],
    eventDoc: "# Jira 定时轮询入口",
  },
];

/** 现有业务列表 mock：internal 引导的「上游业务」下拉数据源 */
const BUSINESSES = [
  {
    business_id: "biz-up",
    business_name: "上游业务",
    creator_id: MEMBER_USER.user_id,
    on_failure: false,
    prompt: "",
    model: "qwen/qwen3.8-max",
    agent_kind: "pi",
    tool_asset_ids: [],
    skill_asset_ids: [],
  },
];

const PACKAGE_META = {
  asset_id: "pkg-1",
  kind: "package",
  owner_id: MEMBER_USER.user_id,
  shared: false,
  is_private: false,
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-01T00:00:00.000Z",
};

const PACKAGE_OBJECT = {
  meta: PACKAGE_META,
  manifest: {
    kind: "package",
    name: "demo",
    programs: { main: "src/main.js" },
    requires: { tools: [], skills: [] },
  },
};

/** 业务编辑页通用 mock（创建态） */
function installPageMocks() {
  return installFetchMock((path, { method }) => {
    if (path === "/api/auth/me") return { status: 200, body: MEMBER_USER };
    if (path === "/api/config") {
      return {
        status: 200,
        body: {
          models: ["qwen/qwen3.8-max"],
          agents: ["pi"],
          entry_adapters: ENTRY_ADAPTERS,
        },
      };
    }
    if (path === "/api/exit-tools") return { status: 200, body: EXIT_TOOLS };
    if (path === "/api/assets?kind=package&scope=mine") {
      return { status: 200, body: [PACKAGE_META] };
    }
    if (path === "/api/assets?kind=tool&scope=all") {
      return { status: 200, body: [] };
    }
    if (path === "/api/assets?kind=skill&scope=all") {
      return { status: 200, body: [] };
    }
    if (path === "/api/assets/pkg-1")
      return { status: 200, body: PACKAGE_OBJECT };
    if (path === "/api/businesses" && method === "GET") {
      return { status: 200, body: BUSINESSES };
    }
    if (path === "/api/businesses" && method === "POST") {
      return {
        status: 201,
        body: { business_id: "biz-new", business_name: "新业务" },
      };
    }
    if (path.startsWith("/api/env/businesses/")) {
      return { status: 200, body: { vars: {}, secret_keys: [] } };
    }
    if (path === "/api/businesses/biz-new" && method === "GET") {
      return {
        status: 200,
        body: {
          profile: { business_id: "biz-new", business_name: "新业务" },
          matches: [],
          exit_bindings: [],
        },
      };
    }
    return undefined;
  });
}

/** 填齐创建表单必填项（名称/包/入口程序/大模型/首个匹配行事件类型） */
async function fillRequiredFields(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.type(await screen.findByLabelText("业务名称"), name);
  await selectOption(user, "包绑定", "pkg-1");
  await selectOption(user, "入口程序", "main");
  await selectOption(user, "大模型", "qwen/qwen3.8-max");
  await user.type(screen.getByLabelText("匹配行 1 事件类型"), "review.request");
}

describe("入口区：适配器 eventDoc 与 entry_config schema 表单", () => {
  it("source 选 webhook → 渲染 eventDoc + 按 configSchema 生成表单项；表单值进 entry_config", async () => {
    const calls = installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "webhook 业务");
    await selectOption(user, "匹配行 1 来源", "webhook");

    // eventDoc 原文渲染（含标题与契约行）
    expect(
      await screen.findByText(/入口事件文档（自定义 Webhook）/),
    ).toBeTruthy();
    expect(screen.getByText(/POST \/hooks\/\{path\}/)).toBeTruthy();

    // configSchema 表单项渲染（required 星标；不再有 secret 键名引用的特殊提示）
    const pathInput = screen.getByLabelText("匹配行 1 path");
    const sessionKeyInput = screen.getByLabelText("匹配行 1 session_id_key");
    expect(screen.getByLabelText("匹配行 1 token")).toBeTruthy();
    expect(screen.queryByText(/填 secrets 键名/)).toBeNull();

    // 表单项写入 → 提交时 entry_config 进创建 body
    await user.type(pathInput, "hook-1");
    await user.type(sessionKeyInput, "issue.key");
    await user.click(screen.getByRole("button", { name: "创建业务" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
      ).toBe(true);
    });
    const createCall = calls.find(
      (c) => c.method === "POST" && c.path === "/api/businesses",
    );
    expect(
      (createCall?.body as { entry_config?: unknown }).entry_config,
    ).toEqual({ path: "hook-1", session_id_key: "issue.key" });
  });

  it("非适配器 source（manual）维持裸 JSON 文本域（无 schema 表单）", async () => {
    installPageMocks();
    renderApp("/businesses/new");

    await screen.findByLabelText("业务名称");
    expect(screen.getByLabelText("匹配行 1 入口配置")).toBeTruthy();
    expect(screen.queryByLabelText("匹配行 1 path")).toBeNull();
    expect(screen.queryByText(/入口事件文档/)).toBeNull();
  });

  it("source 选 jira（适配器当前关闭）→ 显示未启用警告", async () => {
    installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await screen.findByLabelText("业务名称");
    await selectOption(user, "匹配行 1 来源", "jira");

    expect(
      await screen.findByText(/适配器「Jira 定时轮询」当前未启用/),
    ).toBeTruthy();
    expect(screen.getByText(/AGENT_ENTRY_JIRA_POLLING_ENABLED/)).toBeTruthy();
  });
});

describe("入口区：internal 引导", () => {
  it("source 选 internal → 上游业务 + 结果类型自动生成 event_type（可再手改）", async () => {
    installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await screen.findByLabelText("业务名称");
    await selectOption(user, "匹配行 1 来源", "internal");

    // 提示文案
    expect(
      await screen.findByText(/payload 为上游业务 sdk.return 的 output 原样/),
    ).toBeTruthy();

    // 选上游业务 → event_type 自动生成（缺省 completed）
    await selectOption(user, "匹配行 1 上游业务", "上游业务（biz-up）");
    expect(screen.getByLabelText("匹配行 1 事件类型")).toHaveProperty(
      "value",
      "biz-up.completed",
    );

    // 换结果类型 → event_type 联动更新
    await selectOption(user, "匹配行 1 结果类型", "failed（失败产出）");
    expect(screen.getByLabelText("匹配行 1 事件类型")).toHaveProperty(
      "value",
      "biz-up.failed",
    );
  });
});

describe("入口区：「表单」/「JSON」Tab 双视图", () => {
  it("表单编辑 → JSON 视图同步；JSON 编辑 → 表单视图同步（entry_config_text 唯一事实源）", async () => {
    installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await screen.findByLabelText("业务名称");
    await selectOption(user, "匹配行 1 来源", "webhook");

    // 表单视图填 path → 切 JSON 视图，文本里已带上
    await user.type(screen.getByLabelText("匹配行 1 path"), "hook-1");
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const jsonEditor = screen.getByLabelText("匹配行 1 入口配置");
    expect(jsonEditor).toHaveProperty("value", '{"path":"hook-1"}');

    // JSON 视图改值 → 切回表单视图，输入框同步
    fireEvent.change(jsonEditor, {
      target: { value: '{"path":"hook-2","session_id_key":"issue.key"}' },
    });
    await user.click(screen.getByRole("tab", { name: "表单" }));
    expect(screen.getByLabelText("匹配行 1 path")).toHaveProperty(
      "value",
      "hook-2",
    );
    expect(screen.getByLabelText("匹配行 1 session_id_key")).toHaveProperty(
      "value",
      "issue.key",
    );
  });

  it("JSON 非法时「表单」Tab 禁用且给出提示，非法内容不丢", async () => {
    installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await screen.findByLabelText("业务名称");
    await selectOption(user, "匹配行 1 来源", "webhook");
    await user.click(screen.getByRole("tab", { name: "JSON" }));

    // "{" 是 user-event 的按键描述符起始符，用 fireEvent.change 直接设值
    const jsonEditor = screen.getByLabelText("匹配行 1 入口配置");
    fireEvent.change(jsonEditor, { target: { value: "{invalid" } });

    // 行内报错 + Alert 提示
    expect(
      await screen.findAllByText(/入口配置不是合法 JSON object/),
    ).not.toHaveLength(0);
    // 「表单」Tab 禁用（非法 JSON 不丢，但不能切回表单视图）
    const formTab = screen.getByRole("tab", { name: "表单" });
    expect(formTab.closest(".ant-tabs-tab-disabled")).not.toBeNull();
    // 非法内容原样保留
    expect(jsonEditor).toHaveProperty("value", "{invalid");
  });
});

describe("出口区：「表单」/「JSON」Tab 双视图", () => {
  it("勾选出口 → 双视图编辑同一份 config；JSON 视图空绑定预填占位模板", async () => {
    installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await screen.findByLabelText("业务名称");
    await user.click(
      screen.getByRole("checkbox", { name: /企业微信群机器人/ }),
    );

    // 表单视图填 url → 切 JSON 视图同步
    await user.type(
      screen.getByLabelText("出口 wecom-webhook url"),
      "https://hook.example.com",
    );
    const exitTabs = screen.getByLabelText("出口 wecom-webhook 配置视图");
    const jsonTab = within(exitTabs).getByRole("tab", { name: "JSON" });
    await user.click(jsonTab);
    const jsonEditor = screen.getByLabelText("出口 wecom-webhook 配置 JSON");
    expect(jsonEditor).toHaveProperty(
      "value",
      '{"url":"https://hook.example.com"}',
    );

    // 清空后 placeholder 给预填模板（含字段键）
    fireEvent.change(jsonEditor, { target: { value: "" } });
    expect(jsonEditor.getAttribute("placeholder")).toContain('"url"');

    // JSON 非法 → 「表单」Tab 禁用
    fireEvent.change(jsonEditor, { target: { value: "{bad" } });
    expect(
      await screen.findByText(/出口「企业微信群机器人」的配置不是合法 JSON/),
    ).toBeTruthy();
    const formTab = within(exitTabs).getByRole("tab", { name: "表单" });
    expect(formTab.closest(".ant-tabs-tab-disabled")).not.toBeNull();
  });
});

describe("出口区：resultDoc 渲染", () => {
  it("勾选出口工具 → 下方渲染其 resultDoc", async () => {
    installPageMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await screen.findByLabelText("业务名称");
    await user.click(
      screen.getByRole("checkbox", { name: /企业微信群机器人/ }),
    );

    expect(
      await screen.findByText(/该出口期望 sdk.return 返回的形状/),
    ).toBeTruthy();
    expect(
      screen.getByText(/企业微信群机器人：sdk.return 期望形状/),
    ).toBeTruthy();
  });
});
