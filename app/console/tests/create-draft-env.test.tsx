import { fireEvent, screen, waitFor } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import type { ExitToolMenuItem } from "@asteriskzuo/agent-console-api";
import {
  MEMBER_USER,
  installFetchMock,
  renderApp,
  selectOption,
  setupUser,
} from "./helpers";

/** 创建草稿的 localStorage 键（与 BusinessEditPage 的 CREATE_DRAFT_KEY 对齐） */
const DRAFT_KEY = "business-create-draft-v1";

/** 出口工具菜单 mock（与 business-form.test.tsx 同形） */
const EXIT_TOOLS: ExitToolMenuItem[] = [
  {
    kind: "wecom-webhook",
    name: "企业微信群机器人",
    implemented: true,
    configSchema: [
      { key: "url", label: "Webhook 地址", required: true },
      { key: "token", label: "令牌", required: true, secret: true },
    ],
    resultDoc:
      "# 企业微信群机器人：sdk.return 期望形状\n\n字符串或 { content, mentions? }",
  },
];

const ENTRY_ADAPTERS = [
  {
    id: "webhook",
    kind: "webhook",
    name: "自定义 Webhook",
    defaultEnabled: true,
    enabled: true,
    configSchema: [{ key: "path", label: "URL 路径段", required: true }],
    eventDoc: "# 自定义 Webhook 入口\n\nPOST /hooks/{path}",
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

const BIZ_DETAIL = {
  profile: {
    business_id: "biz-1",
    business_name: "旧业务",
    creator_id: MEMBER_USER.user_id,
    on_failure: false,
    prompt: "旧总纲",
    model: "qwen/qwen3.8-max",
    agent_kind: "pi",
    package_asset_id: "pkg-1",
    entry_program: "main",
    tool_asset_ids: [],
    skill_asset_ids: [],
    timeout_minutes: 30,
  },
  matches: [
    {
      business_id: "biz-1",
      business_name: "旧业务",
      creator_id: MEMBER_USER.user_id,
      source: "manual",
      event_type: "review.request",
    },
  ],
  exit_bindings: [],
};

/** 业务表单通用 mock；createResponse 覆盖 POST /api/businesses 的返回（占位校验失败用例用） */
function installBusinessMocks(overrides?: {
  createResponse?: { status: number; body?: unknown };
}) {
  return installFetchMock((path, { method }) => {
    if (path === "/api/auth/me") return { status: 200, body: MEMBER_USER };
    if (path === "/api/config") {
      return {
        status: 200,
        body: {
          models: ["qwen/qwen3.8-max", "moonshot/k2"],
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
      return { status: 200, body: [] };
    }
    if (path === "/api/businesses" && method === "POST") {
      return (
        overrides?.createResponse ?? {
          status: 201,
          body: { business_id: "biz-new", business_name: "新业务" },
        }
      );
    }
    if (path === "/api/businesses/biz-1" && method === "GET") {
      return { status: 200, body: BIZ_DETAIL };
    }
    if (path === "/api/businesses/biz-new" && method === "GET") {
      return { status: 200, body: BIZ_DETAIL };
    }
    if (path.startsWith("/api/env/businesses/") && method === "GET") {
      return { status: 200, body: { vars: {}, secret_keys: [] } };
    }
    if (path.startsWith("/api/businesses/") && path.endsWith("/matches")) {
      return { status: 201 };
    }
    return undefined;
  });
}

/** 填齐创建表单必填项（名称/包/入口程序/大模型）；事件类型留空与否由调用方决定 */
async function fillRequiredFields(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  fireEvent.change(await screen.findByLabelText("业务名称"), {
    target: { value: name },
  });
  await selectOption(user, "包绑定", "pkg-1");
  await selectOption(user, "入口程序", "main");
  await selectOption(user, "大模型", "qwen/qwen3.8-max");
}

/** 等防抖（500ms）落盘后的草稿 JSON */
async function waitDraft(): Promise<{
  form: { business_name?: string };
  matches: unknown[];
  envVars: Array<{ key: string; value: string }>;
  envSecrets: Array<{ key: string; value: string }>;
}> {
  await waitFor(() => {
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });
  return JSON.parse(localStorage.getItem(DRAFT_KEY) as string) as never;
}

beforeEach(() => {
  localStorage.clear();
});

describe("T25：event_type 通配 + 创建草稿 + 随建环境配置", () => {
  it('① event_type 留空可提交（body 里 event_type 为 ""），未填环境配置不携带 env', async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "通配业务");
    // 不填事件类型（留空 = 通配）

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
      ).toBe(true);
    });
    const createCall = calls.find(
      (c) => c.method === "POST" && c.path === "/api/businesses",
    );
    const body = createCall?.body as Record<string, unknown>;
    expect(body.event_type).toBe("");
    expect("env" in body).toBe(false);
  });

  it("② 草稿：填写后防抖落盘；卸载重挂载恢复表单 + 顶部提示", async () => {
    installBusinessMocks();
    const first = renderApp("/businesses/new");

    fireEvent.change(await screen.findByLabelText("业务名称"), {
      target: { value: "草稿业务" },
    });
    fireEvent.change(screen.getByLabelText("匹配行 1 事件类型"), {
      target: { value: "review.request" },
    });
    const draft = await waitDraft();
    expect(draft.form.business_name).toBe("草稿业务");
    expect(draft.matches).toEqual([
      { source: "manual", event_type: "review.request", entry_config_text: "" },
    ]);

    // 模拟重进：卸载后重新挂载创建页
    first.unmount();
    renderApp("/businesses/new");

    await waitFor(() => {
      expect(screen.getByLabelText("业务名称")).toHaveProperty(
        "value",
        "草稿业务",
      );
    });
    expect(screen.getByLabelText("匹配行 1 事件类型")).toHaveProperty(
      "value",
      "review.request",
    );
    expect(await screen.findByText("已恢复上次未完成的草稿")).toBeTruthy();
    expect(screen.getByRole("button", { name: "清除草稿" })).toBeTruthy();
  });

  it("③ 提交成功 → 清除草稿", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "提交清草稿业务");
    await waitDraft();

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });
  });

  it("④ 手动「清除草稿」：删 localStorage + 表单回到初始空态 + 提示消失", async () => {
    installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    // 预置草稿并重进，让恢复提示出现
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        form: { business_name: "待清草稿", on_failure: false },
        matches: [{ source: "manual", event_type: "", entry_config_text: "" }],
        checkedExits: {},
        exitConfigTexts: {},
        envVars: [],
        envSecrets: [],
      }),
    );

    await user.click(await screen.findByRole("button", { name: "清除草稿" }));

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.getByLabelText("业务名称")).toHaveProperty("value", "");
    expect(screen.queryByText("已恢复上次未完成的草稿")).toBeNull();
  });

  it("⑤ 编辑模式不做草稿：不恢复预置草稿，编辑也不写 localStorage", async () => {
    installBusinessMocks();
    const seeded = JSON.stringify({
      form: { business_name: "不应恢复", on_failure: false },
      matches: [{ source: "manual", event_type: "", entry_config_text: "" }],
      checkedExits: {},
      exitConfigTexts: {},
      envVars: [],
      envSecrets: [],
    });
    localStorage.setItem(DRAFT_KEY, seeded);
    renderApp("/businesses/biz-1");

    // 回填完成：仍是服务端数据，草稿未恢复；也无恢复提示
    await waitFor(() => {
      expect(screen.getByLabelText("业务名称")).toHaveProperty(
        "value",
        "旧业务",
      );
    });
    expect(screen.queryByText("已恢复上次未完成的草稿")).toBeNull();

    // 编辑操作不写草稿（等过防抖窗口，内容仍是预置原文）
    fireEvent.change(screen.getByLabelText("业务名称"), {
      target: { value: "改" },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(localStorage.getItem(DRAFT_KEY)).toBe(seeded);
  });

  it("⑥ 随建环境配置：填写普通/安全变量后提交 body 携带 env", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "随建环境业务");

    // 展开折叠区
    await user.click(
      await screen.findByText("环境配置（可选，随业务一并创建）"),
    );
    // 普通变量一行（antd 对两字中文按钮自动插空格：「添 加」；
    // 精确锚定 ^…$，避免误命中 MatchEditor 的「添加匹配行」）
    // 折叠区展开是异步挂载：全部用 findBy 等待式查询（重负载下同步查询会抢在挂载前）
    const addButtons = await screen.findAllByRole("button", {
      name: /^添\s?加$/,
    });
    await user.click(addButtons[0]);
    fireEvent.change(await screen.findByLabelText("普通变量 1 键"), {
      target: { value: "jira_url" },
    });
    fireEvent.change(await screen.findByLabelText("普通变量 1 值"), {
      target: { value: "https://jira.example.com" },
    });
    // 安全变量一行
    await user.click(
      (await screen.findAllByRole("button", { name: /^添\s?加$/ }))[1],
    );
    fireEvent.change(await screen.findByLabelText("安全变量 1 键"), {
      target: { value: "jira_password" },
    });
    fireEvent.change(await screen.findByLabelText("安全变量 1 值"), {
      target: { value: "s3cret" },
    });

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
      ).toBe(true);
    });
    const createCall = calls.find(
      (c) => c.method === "POST" && c.path === "/api/businesses",
    );
    expect((createCall?.body as { env: unknown }).env).toEqual({
      vars: { jira_url: "https://jira.example.com" },
      secrets: { jira_password: "s3cret" },
    });
  });

  it("⑦ 占位校验失败：错误提示末尾追加「环境配置」区引导", async () => {
    installBusinessMocks({
      createResponse: {
        status: 400,
        body: {
          error: {
            code: "invalid_input",
            message:
              "出口「企业微信群机器人」占位符引用了不存在的环境配置键: wecom_token（请先在业务/通用环境配置中创建对应键）",
          },
        },
      },
    });
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "占位缺失业务");
    await user.click(screen.getByRole("button", { name: "创建业务" }));

    expect(
      await screen.findByText(/可在下方「环境配置」区补充缺失的键后重新提交/),
    ).toBeTruthy();
  });

  it("⑧ 随建环境配置状态进草稿（重进恢复已填的键值行）", async () => {
    installBusinessMocks();
    const first = renderApp("/businesses/new");
    const user = setupUser();

    await user.click(
      await screen.findByText("环境配置（可选，随业务一并创建）"),
    );
    await user.click(
      (await screen.findAllByRole("button", { name: /^添\s?加$/ }))[0],
    );
    fireEvent.change(await screen.findByLabelText("普通变量 1 键"), {
      target: { value: "jira_url" },
    });
    fireEvent.change(await screen.findByLabelText("普通变量 1 值"), {
      target: { value: "https://jira.example.com" },
    });
    const draft = await waitDraft();
    expect(draft.envVars).toEqual([
      { key: "jira_url", value: "https://jira.example.com" },
    ]);

    first.unmount();
    renderApp("/businesses/new");

    // 恢复后展开折叠区（折叠区默认收起，行 DOM 未挂载）
    await screen.findByText("已恢复上次未完成的草稿");
    await setupUser().click(
      screen.getByText("环境配置（可选，随业务一并创建）"),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("普通变量 1 键")).toHaveProperty(
        "value",
        "jira_url",
      );
    });
    expect(screen.getByLabelText("普通变量 1 值")).toHaveProperty(
      "value",
      "https://jira.example.com",
    );
  });
});
