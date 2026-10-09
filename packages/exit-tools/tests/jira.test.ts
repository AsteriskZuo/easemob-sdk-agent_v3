import { createJiraExitTool } from "../src/jira.js";
import type { JiraWriteClient } from "../src/jira.js";
import type { JiraResult } from "@asterisk/agent-jira-client";

/** fake 客户端工厂：记录调用，可按用例注入 error 结果。
 *  HTTP 级认证链行为（登录/cookie/401 自愈/错误码映射）已迁移到 @asterisk/agent-jira-client 的测试，此处不重复。 */

function success(data: unknown = undefined): JiraResult<never> {
  return { status: "success", data: data as never };
}

describe("jira destinationOf", () => {
  const tool = createJiraExitTool();

  it("host + issue_key", () => {
    expect(
      tool.destinationOf({
        url: "https://j1.private.easemob.com",
        project: "HIM",
        issue_key: "HIM-123",
      }),
    ).toBe("j1.private.easemob.com__HIM-123");
  });

  it("无 issue_key 时用 project", () => {
    expect(
      tool.destinationOf({
        url: "https://j1.private.easemob.com",
        project: "HIM",
      }),
    ).toBe("j1.private.easemob.com__HIM");
  });

  it("host 中 ':' 替换为 '_'", () => {
    expect(
      tool.destinationOf({ url: "http://example.com:8443", project: "HIM" }),
    ).toBe("example.com_8443__HIM");
  });

  it("缺 url → 抛错", () => {
    expect(() => tool.destinationOf({ project: "HIM" })).toThrow("'url'");
  });

  it("url 非法 → 抛错", () => {
    expect(() =>
      tool.destinationOf({ url: "not a url", project: "HIM" }),
    ).toThrow("不是合法地址");
  });

  it("缺 project → 抛错", () => {
    expect(() => tool.destinationOf({ url: "https://a.b" })).toThrow(
      "'project'",
    );
  });
});

describe("jira bind 校验", () => {
  it("缺 username → 抛错", () => {
    expect(() =>
      createJiraExitTool().bind({
        url: "https://a.b",
        project: "HIM",
        password: "p",
      }),
    ).toThrow("'username'");
  });

  it("缺 password → 抛错", () => {
    expect(() =>
      createJiraExitTool().bind({
        url: "https://a.b",
        project: "HIM",
        username: "u",
      }),
    ).toThrow("'password'");
  });
});

describe("jira deliver（fake JiraWriteClient 注入）", () => {
  it("bind 把完整配置原样传给 createClient，deliver comment 调用假 client", async () => {
    const calls: Record<string, string>[] = [];
    const comments: { issueKey: string; body: string }[] = [];
    const fake: JiraWriteClient = {
      addComment(issueKey, body) {
        comments.push({ issueKey, body });
        return Promise.resolve(success());
      },
      createIssue() {
        return Promise.resolve(success({ key: "HIM-9" }));
      },
    };
    const tool = createJiraExitTool({
      createClient(config) {
        calls.push(config);
        return fake;
      },
    });
    const config = {
      url: "https://j.example.com",
      project: "HIM",
      issue_key: "HIM-1",
      username: "u",
      password: "p",
      redirect_username: "gw",
      redirect_password: "gp",
    };
    const exit = tool.bind(config);
    expect(calls[0]).toEqual(config);
    await exit.deliver({ op: "comment", body: "hi" });
    expect(comments).toEqual([{ issueKey: "HIM-1", body: "hi" }]);
  });

  it("comment：对象 body 走 ```json 围栏渲染", async () => {
    const comments: { issueKey: string; body: string }[] = [];
    const fake: JiraWriteClient = {
      addComment(issueKey, body) {
        comments.push({ issueKey, body });
        return Promise.resolve(success());
      },
      createIssue() {
        return Promise.resolve(success({ key: "HIM-9" }));
      },
    };
    const tool = createJiraExitTool({ createClient: () => fake });
    const exit = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      issue_key: "HIM-1",
      username: "u",
      password: "p",
    });
    await exit.deliver({ op: "comment", body: { a: 1 } });
    expect(comments[0]?.body).toBe(
      "```json\n" + JSON.stringify({ a: 1 }, null, 2) + "\n```",
    );
  });

  it("deliver create：fields 组装（project.key/summary/extra 透传，description 缺省省略）", async () => {
    const created: Record<string, unknown>[] = [];
    const fake: JiraWriteClient = {
      addComment() {
        return Promise.resolve(success());
      },
      createIssue(fields) {
        created.push(fields);
        return Promise.resolve(success({ key: "HIM-7" }));
      },
    };
    const tool = createJiraExitTool({ createClient: () => fake });
    const exit = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      username: "u",
      password: "p",
    });
    await exit.deliver({
      op: "create",
      fields: { summary: "s", customfield_11901: "bug 内容" },
    });
    expect(created[0]).toEqual({
      project: { key: "HIM" },
      summary: "s",
      customfield_11901: "bug 内容",
    });
    await exit.deliver({
      op: "create",
      fields: { summary: "s2", description: "d" },
    });
    expect(created[1]).toEqual({
      project: { key: "HIM" },
      summary: "s2",
      description: "d",
    });
  });

  it("客户端 error → deliver 抛 `${code}: ${message}`", async () => {
    const fake: JiraWriteClient = {
      addComment() {
        return Promise.resolve({
          status: "error",
          code: "jira_server_error",
          message: "jira 服务端错误",
        });
      },
      createIssue() {
        return Promise.resolve({
          status: "error",
          code: "permission_denied",
          message: "jira 权限不足",
        });
      },
    };
    const tool = createJiraExitTool({ createClient: () => fake });
    const commentExit = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      issue_key: "HIM-1",
      username: "u",
      password: "p",
    });
    await expect(
      commentExit.deliver({ op: "comment", body: "x" }),
    ).rejects.toThrow("jira_server_error: jira 服务端错误");

    const createExit = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      username: "u",
      password: "p",
    });
    await expect(
      createExit.deliver({ op: "create", fields: { summary: "s" } }),
    ).rejects.toThrow("permission_denied: jira 权限不足");
  });

  it("payload 校验：非对象 / 缺 op / 未知 op / comment 缺 issue_key / create 缺 summary → 抛错", async () => {
    const fake: JiraWriteClient = {
      addComment: () => Promise.resolve(success()),
      createIssue: () => Promise.resolve(success({ key: "HIM-1" })),
    };
    const tool = createJiraExitTool({ createClient: () => fake });
    const withKey = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      issue_key: "HIM-1",
      username: "u",
      password: "p",
    });
    await expect(withKey.deliver("plain")).rejects.toThrow("payload 非法");
    await expect(withKey.deliver({ body: "x" })).rejects.toThrow("op");
    await expect(withKey.deliver({ op: "delete" })).rejects.toThrow(
      "'comment' 或 'create'",
    );

    const noKey = tool.bind({
      url: "https://j.example.com",
      project: "HIM",
      username: "u",
      password: "p",
    });
    await expect(noKey.deliver({ op: "comment", body: "x" })).rejects.toThrow(
      "'issue_key'",
    );
    await expect(noKey.deliver({ op: "create", fields: {} })).rejects.toThrow(
      "summary",
    );
    await expect(
      noKey.deliver({ op: "create", fields: { summary: 1 } }),
    ).rejects.toThrow("summary");
    await expect(
      noKey.deliver({ op: "create", fields: { summary: "s", description: 1 } }),
    ).rejects.toThrow("description");
  });
});
