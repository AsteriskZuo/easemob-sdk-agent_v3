import { createGithubExitTool } from "../src/github.js";
import type { GhRunner } from "../src/github.js";

/** 假 createRunner：捕获创建时注入的 env 与每次调用的 args，不发真实子进程 */
function makeFakeRunner() {
  const calls: string[][] = [];
  const creationEnvs: (Record<string, string> | undefined)[] = [];
  const createRunner = (env?: Record<string, string>): GhRunner => {
    creationEnvs.push(env ? { ...env } : undefined);
    return async (args: string[]) => {
      calls.push([...args]);
      return "";
    };
  };
  return { calls, creationEnvs, createRunner };
}

const repoConfig: Record<string, string> = {
  repo: "https://github.com/Owner/Repo.git",
};

describe("github destinationOf", () => {
  const tool = createGithubExitTool(makeFakeRunner());

  it("HTTPS 形态（含大写与 .git）归一化", () => {
    expect(
      tool.destinationOf({ repo: "https://github.com/Owner/Repo.git" }),
    ).toBe("github.com_owner_repo");
  });

  it("git@ scp 形态归一化", () => {
    expect(tool.destinationOf({ repo: "git@github.com:owner/repo.git" })).toBe(
      "github.com_owner_repo",
    );
  });

  it("ssh:// 显式协议形态归一化", () => {
    expect(
      tool.destinationOf({ repo: "ssh://git@github.com/owner/repo.git" }),
    ).toBe("github.com_owner_repo");
  });

  it("owner/repo 简写补 github.com 前缀", () => {
    expect(tool.destinationOf({ repo: "owner/repo" })).toBe(
      "github.com_owner_repo",
    );
  });

  it("尾斜杠与大小写归一化", () => {
    expect(tool.destinationOf({ repo: "https://GitHub.com/Owner/Repo/" })).toBe(
      "github.com_owner_repo",
    );
  });

  it("非法输入抛错", () => {
    expect(() => tool.destinationOf({})).toThrow("'repo'");
    expect(() => tool.destinationOf({ repo: "not-a-repo" })).toThrow("非法");
    expect(() =>
      tool.destinationOf({ repo: "https://github.com/onlyone" }),
    ).toThrow("非法");
    expect(() => tool.destinationOf({ repo: "ftp://github.com/a/b" })).toThrow(
      "非法",
    );
  });
});

describe("github bind", () => {
  it("缺 repo → 抛错", () => {
    const tool = createGithubExitTool(makeFakeRunner());
    expect(() => tool.bind({})).toThrow("'repo'");
  });

  it("token → 以 { GH_TOKEN } 传入 createRunner", () => {
    const fake = makeFakeRunner();
    const tool = createGithubExitTool({ createRunner: fake.createRunner });
    tool.bind({ ...repoConfig, token: "tk-123" });
    expect(fake.creationEnvs).toEqual([{ GH_TOKEN: "tk-123" }]);
  });

  it("无 token → createRunner 收到 undefined（依赖宿主机登录态）", () => {
    const fake = makeFakeRunner();
    const tool = createGithubExitTool({ createRunner: fake.createRunner });
    tool.bind(repoConfig);
    expect(fake.creationEnvs).toEqual([undefined]);
  });

  it("缺省 createRunner 存在：bind 成功且不调用任何子进程", () => {
    const tool = createGithubExitTool();
    const exit = tool.bind(repoConfig);
    expect(typeof exit.deliver).toBe("function");
  });
});

describe("github deliver", () => {
  function bindFake(config: Record<string, string> = repoConfig) {
    const fake = makeFakeRunner();
    const tool = createGithubExitTool({ createRunner: fake.createRunner });
    return { fake, exit: tool.bind(config) };
  }

  it("op=issue → args 精确匹配（含 body）", async () => {
    const { fake, exit } = bindFake();
    await exit.deliver({ op: "issue", title: "缺陷报告", body: "详情" });
    expect(fake.calls).toContainEqual([
      "issue",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "缺陷报告",
      "--body",
      "详情",
    ]);
  });

  it("op=issue 对象 body → json 围栏文本；无 body 不带 --body", async () => {
    const { fake, exit } = bindFake();
    const payload = { trace: "abc" };
    await exit.deliver({ op: "issue", title: "t", body: payload });
    expect(fake.calls).toContainEqual([
      "issue",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "t",
      "--body",
      "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
    ]);
    await exit.deliver({ op: "issue", title: "t2" });
    expect(fake.calls).toContainEqual([
      "issue",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "t2",
    ]);
  });

  it("op=comment → issue comment 端点（issue/PR 共用）", async () => {
    const { fake, exit } = bindFake();
    await exit.deliver({ op: "comment", number: 1, body: "收到" });
    expect(fake.calls).toContainEqual([
      "issue",
      "comment",
      "1",
      "--repo",
      "owner/repo",
      "--body",
      "收到",
    ]);
  });

  it("op=pr → args 含 head/base，缺省省略", async () => {
    const { fake, exit } = bindFake();
    await exit.deliver({
      op: "pr",
      title: "PR 标题",
      base: "v3",
      head: "feat/x",
    });
    expect(fake.calls).toContainEqual([
      "pr",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "PR 标题",
      "--head",
      "feat/x",
      "--base",
      "v3",
    ]);
    await exit.deliver({ op: "pr", title: "仅标题" });
    expect(fake.calls).toContainEqual([
      "pr",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "仅标题",
    ]);
  });

  it("op=clone：缺 dir 用 repo 末段名；带 dir 原样传入", async () => {
    const { fake, exit } = bindFake();
    await exit.deliver({ op: "clone" });
    expect(fake.calls).toContainEqual(["repo", "clone", "owner/repo", "repo"]);
    await exit.deliver({ op: "clone", dir: "work/clone1" });
    expect(fake.calls).toContainEqual([
      "repo",
      "clone",
      "owner/repo",
      "work/clone1",
    ]);
  });

  it("首次 deliver 前惰性执行 gh --version 与 gh auth status，仅一次", async () => {
    const { fake, exit } = bindFake();
    expect(fake.calls).toHaveLength(0);
    await exit.deliver({ op: "issue", title: "a" });
    await exit.deliver({ op: "issue", title: "b" });
    const versionCalls = fake.calls.filter((c) => c[0] === "--version");
    const authCalls = fake.calls.filter((c) => c[0] === "auth");
    expect(versionCalls).toHaveLength(1);
    expect(authCalls).toEqual([["auth", "status"]]);
  });

  it("未知 op / 缺 op / 非对象 payload → 抛错并说明合法形态", async () => {
    const { exit } = bindFake();
    await expect(exit.deliver({ op: "merge", number: 1 })).rejects.toThrow(
      "合法形态",
    );
    await expect(exit.deliver({ title: "x" })).rejects.toThrow("op");
    await expect(exit.deliver("plain")).rejects.toThrow("合法形态");
  });

  it("缺 title / 缺 number / 缺 body → 抛错", async () => {
    const { exit } = bindFake();
    await expect(exit.deliver({ op: "issue", body: "b" })).rejects.toThrow(
      "'title'",
    );
    await expect(exit.deliver({ op: "comment", body: "b" })).rejects.toThrow(
      "'number'",
    );
    await expect(exit.deliver({ op: "comment", number: 1 })).rejects.toThrow(
      "'body'",
    );
  });

  it("runner 抛错（模拟 gh 非零退出）→ deliver 抛错且透传消息", async () => {
    const failingRunner: GhRunner = async (args) => {
      if (args[0] === "--version" || args[0] === "auth") return "";
      throw new Error("HTTP 404: Not Found（权限不足或仓库不存在）");
    };
    const tool = createGithubExitTool({ createRunner: () => failingRunner });
    const exit = tool.bind(repoConfig);
    await expect(exit.deliver({ op: "issue", title: "t" })).rejects.toThrow(
      "HTTP 404: Not Found",
    );
  });

  it("可用性校验失败（gh 未登录）→ deliver 抛错且消息提示检查安装/登录", async () => {
    const failingRunner: GhRunner = async () => {
      throw new Error("stub error: 未登录");
    };
    const tool = createGithubExitTool({ createRunner: () => failingRunner });
    const exit = tool.bind(repoConfig);
    await expect(exit.deliver({ op: "issue", title: "t" })).rejects.toThrow(
      "未登录",
    );
    // 校验未通过不置 flag，下次投递仍会重试
    await expect(exit.deliver({ op: "issue", title: "t" })).rejects.toThrow(
      "gh CLI 不可用或未登录",
    );
  });
});
