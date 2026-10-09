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

/** 出口工具菜单 mock：wecom-webhook 有一个普通项（url）+ 一个机密项（token）；mail 未实现（置灰） */
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
  {
    kind: "mail",
    name: "邮件",
    implemented: false,
    configSchema: [],
    resultDoc: "# 邮件：待定",
  },
];

/** 入口适配器 mock（/api/config 的 entry_adapters）：webhook 启用 + jira-polling 关闭 */
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
      { key: "token_key", label: "验签 token 的 secrets 键名" },
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

/** 编辑态详情 mock（biz-1） */
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
  exit_bindings: [
    {
      business_id: "biz-1",
      tool: "wecom-webhook",
      config: { url: "https://old-hook" },
    },
  ],
};

/** 业务表单通用 mock；overrides.emptyPackages = true 时包列表为空（空资产引导用例） */
function installBusinessMocks(overrides?: { emptyPackages?: boolean }) {
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
      return {
        status: 200,
        body: overrides?.emptyPackages ? [] : [PACKAGE_META],
      };
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
      return {
        status: 201,
        body: { business_id: "biz-new", business_name: "新业务" },
      };
    }
    if (path === "/api/businesses/biz-1" && method === "GET") {
      return { status: 200, body: BIZ_DETAIL };
    }
    if (path === "/api/businesses/biz-1" && method === "PATCH") {
      return { status: 204 };
    }
    if (path === "/api/env/businesses/biz-1" && method === "GET") {
      return {
        status: 200,
        body: { vars: {}, secret_keys: ["exit.wecom-webhook.token"] },
      };
    }
    // 创建后跳编辑页（biz-new）的加载
    if (path === "/api/businesses/biz-new" && method === "GET") {
      return { status: 200, body: BIZ_DETAIL };
    }
    if (path === "/api/env/businesses/biz-new" && method === "GET") {
      return { status: 200, body: { vars: {}, secret_keys: [] } };
    }
    if (path.startsWith("/api/env/businesses/") && method === "PUT") {
      return { status: 204 };
    }
    if (path.startsWith("/api/businesses/") && path.endsWith("/matches")) {
      return { status: 201 };
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
  // 包绑定 → 选 pkg-1（触发拉 manifest 填充入口程序下拉）
  await selectOption(user, "包绑定", "pkg-1");
  // 入口程序 → main
  await selectOption(user, "入口程序", "main");
  // 大模型必选（无默认选中，可选项来自 /api/config）
  await selectOption(user, "大模型", "qwen/qwen3.8-max");
  await user.type(screen.getByLabelText("匹配行 1 事件类型"), "review.request");
}

describe("业务表单", () => {
  it("① 创建提交映射：表单值 → CreateBusinessBody（首个匹配行/agent/model/资产绑定/超时覆盖）", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "评审业务");
    // 超时覆盖填 45
    await user.type(screen.getByLabelText("超时覆盖"), "45");

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
      ).toBe(true);
    });
    const createCall = calls.find(
      (c) => c.method === "POST" && c.path === "/api/businesses",
    );
    expect(createCall?.body).toEqual({
      business_name: "评审业务",
      source: "manual",
      event_type: "review.request",
      on_failure: false,
      prompt: "",
      model: "qwen/qwen3.8-max",
      agent_kind: "pi",
      package_asset_id: "pkg-1",
      entry_program: "main",
      tool_asset_ids: [],
      skill_asset_ids: [],
      timeout_minutes: 45,
      exit_bindings: [],
    });
  });

  it("② 出口 secret 分流：secret 项进 env PUT（exit.{kind}.{field.key}）且不进 ExitBinding.config", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "投递业务");
    // 勾选出口工具并填写普通项 + 机密项
    await user.click(
      screen.getByRole("checkbox", { name: /企业微信群机器人/ }),
    );
    await user.type(
      screen.getByLabelText("出口 wecom-webhook url"),
      "https://hook.example.com",
    );
    await user.type(
      screen.getByLabelText("出口 wecom-webhook token"),
      "tok-123",
    );

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
      ).toBe(true);
    });
    // 非 secret 项进 ExitBinding.config
    const createCall = calls.find(
      (c) => c.method === "POST" && c.path === "/api/businesses",
    );
    expect(
      (createCall?.body as { exit_bindings: unknown[] }).exit_bindings,
    ).toEqual([
      { tool: "wecom-webhook", config: { url: "https://hook.example.com" } },
    ]);
    // secret 项写业务层安全桶，键 = exit.{kind}.{field.key}
    const secretPut = calls.find(
      (c) => c.method === "PUT" && c.path === "/api/env/businesses/biz-new",
    );
    expect(secretPut?.body).toEqual({
      bucket: "secrets",
      key: "exit.wecom-webhook.token",
      value: "tok-123",
    });
  });

  it("③ 编辑回填：BusinessDetail + env 键名 → 表单初值（secret 显示「已配置」占位）", async () => {
    installBusinessMocks();
    renderApp("/businesses/biz-1");

    // 资料字段回填（详情加载是异步的，waitFor 等回填完成）
    await waitFor(() => {
      expect(screen.getByLabelText("业务名称")).toHaveProperty(
        "value",
        "旧业务",
      );
    });
    // 非机密出口项原样回填
    expect(screen.getByLabelText("出口 wecom-webhook url")).toHaveProperty(
      "value",
      "https://old-hook",
    );
    // secret 项：值不回显，占位「已配置」
    const tokenInput = screen.getByLabelText("出口 wecom-webhook token");
    expect(tokenInput).toHaveProperty("value", "");
    expect(tokenInput.getAttribute("placeholder")).toContain("已配置");
    // 超时覆盖回填
    expect(screen.getByLabelText("超时覆盖")).toHaveProperty("value", "30");
  });

  it("④ entry_config 非法 JSON：表单内报错不提交", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    await fillRequiredFields(user, "坏 JSON 业务");
    // "{" 是 user-event 的按键描述符起始符，用 fireEvent.change 直接设值
    fireEvent.change(screen.getByLabelText("匹配行 1 入口配置"), {
      target: { value: "{invalid" },
    });

    // 行内实时报错
    expect(
      await screen.findByText("入口配置不是合法 JSON object"),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    // 提交被拦截：没有 POST /api/businesses
    await waitFor(() => {
      expect(
        screen.queryAllByText(/入口配置不是合法 JSON object/).length,
      ).toBeGreaterThan(0);
    });
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
    ).toBe(false);
  });

  it("⑤ 清除超时覆盖 → PATCH 提交 null", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/biz-1");
    const user = setupUser();

    // 等待回填（超时覆盖 = 30）
    const timeoutInput = await screen.findByLabelText("超时覆盖");
    await waitFor(() => {
      expect(timeoutInput).toHaveProperty("value", "30");
    });
    await user.clear(timeoutInput);

    await user.click(screen.getByRole("button", { name: /^保\s?存$/ }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === "PATCH" && c.path === "/api/businesses/biz-1",
        ),
      ).toBe(true);
    });
    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.path === "/api/businesses/biz-1",
    );
    expect(
      (patchCall?.body as { timeout_minutes: unknown }).timeout_minutes,
    ).toBeNull();
  });

  it("⑥ agent/大模型下拉由 /api/config 驱动（可选集合来自 models.json，无硬编码项）", async () => {
    installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    // 先等路由页渲染完（auth 加载是异步的，同步查询会撞上加载态 spinner）
    await screen.findByLabelText("业务名称");
    // 打开大模型下拉：两个 mock 模型都在，裸的 qwen3.8max 硬编码项不存在
    // （antd Select 的 aria-label 会命中多个节点，取 INPUT 同 selectOption 的做法）
    const candidates = screen.getAllByLabelText("大模型");
    const combobox =
      candidates.find((el) => el.tagName === "INPUT") ?? candidates[0];
    await user.click(combobox);
    expect(await screen.findAllByText("qwen/qwen3.8-max")).not.toHaveLength(0);
    expect(await screen.findAllByText("moonshot/k2")).not.toHaveLength(0);
    expect(screen.queryAllByText("qwen3.8max")).toHaveLength(0);
  });

  it("⑦ 大模型未选 → 表单校验拦截，不提交", async () => {
    const calls = installBusinessMocks();
    renderApp("/businesses/new");
    const user = setupUser();

    // 填齐除大模型外的必填项
    await user.type(await screen.findByLabelText("业务名称"), "缺模型业务");
    await selectOption(user, "包绑定", "pkg-1");
    await selectOption(user, "入口程序", "main");
    await user.type(
      screen.getByLabelText("匹配行 1 事件类型"),
      "review.request",
    );

    await user.click(screen.getByRole("button", { name: "创建业务" }));

    // 校验错误出现在表单错误区（与 Select 占位文案区分：必须在 explain-error 内）
    await waitFor(() => {
      const hits = screen.queryAllByText("请选择模型");
      expect(
        hits.some((el) => el.closest(".ant-form-item-explain-error") !== null),
      ).toBe(true);
    });
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/api/businesses"),
    ).toBe(false);
  });

  it("⑧ 空资产引导：包/工具/skill 下拉为空时给出去资产管理登记的引导", async () => {
    installBusinessMocks({ emptyPackages: true });
    renderApp("/businesses/new");

    expect(await screen.findByText(/还没有可用的包资产/)).toBeTruthy();
    expect(screen.getByText(/没有可绑定的工具资产/)).toBeTruthy();
    expect(screen.getByText(/没有可绑定的 skill 集合/)).toBeTruthy();
    // 引导含跳资产管理的链接
    const links = screen.getAllByRole("link", { name: /资产管理登记/ });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute("href")).toBe("/assets");
  });

  it("⑨ 出口机密项：键名标注 + 已配置/未配置状态（编辑态已配置，创建态未配置）", async () => {
    // 编辑态：secret_keys 含 exit.wecom-webhook.token → 已配置
    installBusinessMocks();
    const editView = renderApp("/businesses/biz-1");
    await waitFor(() => {
      expect(screen.getByLabelText("业务名称")).toHaveProperty(
        "value",
        "旧业务",
      );
    });
    expect(
      (await screen.findAllByText(/exit\.wecom-webhook\.token/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
    // 同文档双挂载会撞查询范围，先卸载再挂创建态
    editView.unmount();

    // 创建态：业务未存在 → 全部未配置
    renderApp("/businesses/new");
    const user = setupUser();
    await user.click(
      await screen.findByRole("checkbox", { name: /企业微信群机器人/ }),
    );
    expect(await screen.findAllByText("未配置")).not.toHaveLength(0);
  });
});
