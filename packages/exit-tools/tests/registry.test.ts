import { createExitRegistry } from "../src/index.js";

describe("createExitRegistry", () => {
  const registry = createExitRegistry();

  it("list 返回七个工具（三个实现、四个占位）", () => {
    const tools = registry.list();
    expect(tools.map((t) => t.kind)).toEqual([
      "wecom-webhook",
      "mail",
      "webhook",
      "wecom-aibot",
      "github",
      "jira",
      "confluence",
    ]);
    const implemented = tools.filter((t) => t.implemented);
    expect(implemented.map((t) => t.kind).sort()).toEqual([
      "mail",
      "webhook",
      "wecom-webhook",
    ]);
    const placeholders = tools.filter((t) => !t.implemented);
    expect(placeholders).toHaveLength(4);
    for (const p of placeholders) expect(p.configSchema).toEqual([]);
  });

  it("get 命中已注册工具", () => {
    expect(registry.get("mail").kind).toBe("mail");
    expect(registry.get("wecom-webhook").name).toBe("企业微信群机器人");
    expect(registry.get("jira").name).toBe("Jira 操作");
  });

  it("get 未知 kind 抛错", () => {
    expect(() => registry.get("nope")).toThrow("未注册的出口工具");
  });

  it("占位工具 destinationOf/bind 抛「未实现」", () => {
    for (const kind of ["wecom-aibot", "github", "jira", "confluence"]) {
      const tool = registry.get(kind);
      expect(() => tool.destinationOf({})).toThrow(
        `出口工具 '${kind}' 尚未实现`,
      );
      expect(() => tool.bind({})).toThrow(`出口工具 '${kind}' 尚未实现`);
    }
  });
});
