import { createExitRegistry } from "../src/index.js";

describe("createExitRegistry", () => {
  const registry = createExitRegistry();

  it("list 返回七个工具且全部已实现", () => {
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
    expect(tools.every((t) => t.implemented)).toBe(true);
  });

  it("get 命中已注册工具", () => {
    expect(registry.get("mail").kind).toBe("mail");
    expect(registry.get("wecom-webhook").name).toBe("企业微信群机器人");
    expect(registry.get("wecom-aibot").name).toBe("企业微信智能机器人");
    expect(registry.get("jira").name).toBe("Jira 操作");
    expect(registry.get("confluence").name).toBe("Confluence 操作");
    expect(registry.get("github").name).toBe("GitHub 操作");
  });

  it("get 未知 kind 抛错", () => {
    expect(() => registry.get("nope")).toThrow("未注册的出口工具");
  });

  it("每个工具都带 resultDoc（markdown，非空；含示例）", () => {
    for (const tool of registry.list()) {
      expect(typeof tool.resultDoc).toBe("string");
      expect(tool.resultDoc.length).toBeGreaterThan(0);
      // 文档须含「sdk.return 期望形状」语义与至少一个 JSON 示例围栏
      expect(tool.resultDoc).toContain("sdk.return");
      expect(tool.resultDoc).toContain("```json");
    }
  });
});
