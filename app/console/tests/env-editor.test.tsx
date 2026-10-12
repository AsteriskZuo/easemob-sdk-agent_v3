import { render, screen, waitFor } from "@testing-library/react";
import { App as AntdApp } from "antd";
import EnvEditor from "../src/components/EnvEditor";
import { installFetchMock, setupUser } from "./helpers";

/**
 * EnvEditor（编辑页/设置页两桶环境配置）：行内草稿 + 保存 diff 语义。
 * 与创建页 CreateEnvEditor 同一套行内交互（KvGroup），保存时对后端逐 key PUT/DELETE。
 */

function renderEditor(readOnly = false) {
  return render(
    <AntdApp>
      <EnvEditor scope="business" businessId="biz-1" readOnly={readOnly} />
    </AntdApp>,
  );
}

/** 已有数据：vars 两条、secrets 一条；记录全部 env 写请求 */
function installEnvMocks() {
  return installFetchMock((path, { method }) => {
    if (path === "/api/env/businesses/biz-1" && method === "GET") {
      return {
        status: 200,
        body: { vars: { region: "cn", legacy: "x" }, secret_keys: ["token"] },
      };
    }
    if (path === "/api/env/businesses/biz-1") {
      return { status: 200 };
    }
    return undefined;
  });
}

// antd 两字中文按钮的可访问名会插入空格（"添 加"），用正则兼容
const addButtons = () => screen.getAllByRole("button", { name: /添\s?加/ });
const saveButton = () => screen.getByRole("button", { name: /保\s?存/ });

describe("EnvEditor：行内草稿 + 保存", () => {
  it("加载后已有键渲染为行；secrets 键只回显键名、值留空", async () => {
    installEnvMocks();
    renderEditor();

    // vars 两行：键与明文值（findBy* 找不到即抛错，存在性已断言）
    await screen.findByDisplayValue("region");
    await screen.findByDisplayValue("cn");
    await screen.findByDisplayValue("legacy");
    // secrets：键回显、值输入框留空（不回显）
    await screen.findByDisplayValue("token");
    const secretValue = screen.getByLabelText("secrets 1 值");
    expect((secretValue as HTMLInputElement).value).toBe("");
  });

  it("vars 保存 = diff：新增/改值 PUT、删行 DELETE、未变键不发请求", async () => {
    const calls = installEnvMocks();
    renderEditor();
    const user = setupUser();

    // 改已有键 region 的值；删掉 legacy 行；新增一行
    const regionValue = await screen.findByLabelText("vars 1 值");
    await user.clear(regionValue);
    await user.type(regionValue, "us");
    await user.click(screen.getByLabelText("删除vars 2")); // legacy
    await user.click(addButtons()[0]);
    await user.type(screen.getByLabelText("vars 2 键"), "added");
    await user.type(screen.getByLabelText("vars 2 值"), "v1");

    await user.click(saveButton());

    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const writes = calls.filter((c) => c.method !== "GET");
    const keys = writes.map(
      (c) => `${c.method}:${(c.body as { key: string }).key}`,
    );
    expect(keys).toContain("PUT:region");
    expect(keys).toContain("PUT:added");
    expect(keys).toContain("DELETE:legacy");
    expect(keys).toHaveLength(3);
  });

  it("secrets 保存：值留空 = 不动；填写 = 覆盖；新键留空被忽略", async () => {
    const calls = installEnvMocks();
    renderEditor();
    const user = setupUser();

    // 已有 token 行填值 = 覆盖；再新增一行留空值（应被忽略）
    await user.type(await screen.findByLabelText("secrets 1 值"), "new-secret");
    await user.click(addButtons()[1]);
    await user.type(screen.getByLabelText("secrets 2 键"), "empty-new");

    await user.click(saveButton());

    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("PUT");
    expect((writes[0].body as { key: string }).key).toBe("token");
  });

  it("secrets 删掉已有键行 → 保存后 DELETE", async () => {
    const calls = installEnvMocks();
    renderEditor();
    const user = setupUser();

    await screen.findByDisplayValue("token");
    await user.click(screen.getByLabelText("删除secrets 1"));
    await user.click(saveButton());

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    });
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect((deletes[0].body as { key: string }).key).toBe("token");
  });

  it("hideActions：无保存/重置按钮（由外层经 ref 统一保存）", async () => {
    installEnvMocks();
    render(
      <AntdApp>
        <EnvEditor scope="business" businessId="biz-1" hideActions />
      </AntdApp>,
    );

    await screen.findByLabelText("vars 1 键");
    expect(screen.queryByRole("button", { name: /保\s?存/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /重\s?置/ })).toBeNull();
  });

  it("readOnly：输入禁用、无添加/保存按钮", async () => {
    installEnvMocks();
    renderEditor(true);

    const keyInput = await screen.findByLabelText("vars 1 键");
    expect((keyInput as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /添\s?加/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /保\s?存/ })).toBeNull();
  });
});
