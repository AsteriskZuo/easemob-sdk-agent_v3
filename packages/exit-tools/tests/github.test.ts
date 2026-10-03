import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { createGithubExitTool, GithubClient } from "../src/github.js";
import type { OctokitLike } from "../src/github.js";

type CallRecord = { method: string; params: Record<string, unknown> };

type FakeOctokit = OctokitLike & { __calls: CallRecord[] };

/** 假 octokit：满足 OctokitLike 的最小对象，记录每次调用（method 命名：rest.issues.create） */
function makeFakeOctokit(): FakeOctokit {
  const calls: CallRecord[] = [];
  let nextIssueNumber = 101;
  let nextPrNumber = 202;
  const octokit = {
    rest: {
      repos: {
        get: async (params: Record<string, unknown>) => {
          calls.push({ method: "rest.repos.get", params: { ...params } });
          return { data: { id: 1 } };
        },
      },
      issues: {
        create: async (params: Record<string, unknown>) => {
          calls.push({ method: "rest.issues.create", params: { ...params } });
          return { data: { number: nextIssueNumber++ } };
        },
        createComment: async (params: Record<string, unknown>) => {
          calls.push({
            method: "rest.issues.createComment",
            params: { ...params },
          });
          return { data: { id: 1 } };
        },
        update: async (params: Record<string, unknown>) => {
          calls.push({ method: "rest.issues.update", params: { ...params } });
          return { data: {} };
        },
      },
      pulls: {
        create: async (params: Record<string, unknown>) => {
          calls.push({ method: "rest.pulls.create", params: { ...params } });
          return { data: { number: nextPrNumber++ } };
        },
        update: async (params: Record<string, unknown>) => {
          calls.push({ method: "rest.pulls.update", params: { ...params } });
          return { data: {} };
        },
      },
    },
  } as unknown as FakeOctokit;
  Object.defineProperty(octokit, "__calls", { value: calls });
  return octokit;
}

/** 真实 GithubClient + 假 octokit（downloadCode 场景再叠加假 fetchImpl） */
function makeClient(
  octokit: OctokitLike,
  fetchImpl?: typeof fetch,
): GithubClient {
  return new GithubClient(
    { token: "tk-test", repo: "owner/repo" },
    { octokit, ...(fetchImpl ? { fetchImpl } : {}) },
  );
}

/** 绑定一个注入假 octokit 的 exit；返回调用记录与 deliver */
function bindFake(config: Record<string, string> = repoConfig) {
  const octokit = makeFakeOctokit();
  const client = makeClient(octokit);
  const captured: Record<string, string>[] = [];
  const tool = createGithubExitTool({
    createClient: (cfg) => {
      captured.push({ ...cfg });
      return client;
    },
  });
  return { octokit, captured, client, exit: tool.bind(config) };
}

const repoConfig: Record<string, string> = {
  repo: "https://github.com/Owner/Repo.git",
  token: "tk-123",
};

describe("github destinationOf", () => {
  const tool = createGithubExitTool();

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
    const tool = createGithubExitTool();
    expect(() => tool.bind({ token: "tk" })).toThrow("'repo'");
  });

  it("缺 token → 抛错（REST 必需）", () => {
    const tool = createGithubExitTool();
    expect(() => tool.bind({ repo: "owner/repo" })).toThrow("'token'");
  });

  it("createClient 收到绑定配置：repo/token/base_url 原样传入", () => {
    const { captured } = bindFake({
      ...repoConfig,
      base_url: "https://ghes.example.com",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].repo).toBe(repoConfig.repo);
    expect(captured[0].token).toBe("tk-123");
    expect(captured[0].base_url).toBe("https://ghes.example.com");
  });

  it("缺省 createClient 存在：bind 成功且不发任何请求", () => {
    const tool = createGithubExitTool();
    const exit = tool.bind(repoConfig);
    expect(typeof exit.deliver).toBe("function");
  });
});

describe("github deliver", () => {
  it("首次 deliver 前惰性执行 repos.get 探测，成功后仅一次", async () => {
    const { octokit, exit } = bindFake();
    expect(octokit.__calls).toHaveLength(0);
    await exit.deliver({ op: "issue", title: "a" });
    await exit.deliver({ op: "issue", title: "b" });
    const gets = octokit.__calls.filter((c) => c.method === "rest.repos.get");
    expect(gets).toEqual([
      { method: "rest.repos.get", params: { owner: "owner", repo: "repo" } },
    ]);
  });

  it("可用性校验失败不置 flag，下次投递重试并透传错误", async () => {
    const octokit = makeFakeOctokit();
    let attempts = 0;
    octokit.rest.repos.get = (async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("HTTP 404: Not Found（权限不足或仓库不存在）");
      }
      return { data: { id: 1 } };
    }) as OctokitLike["rest"]["repos"]["get"];
    const client = makeClient(octokit);
    const tool = createGithubExitTool({ createClient: () => client });
    const exit = tool.bind(repoConfig);
    await expect(exit.deliver({ op: "issue", title: "t" })).rejects.toThrow(
      "HTTP 404: Not Found",
    );
    // 校验未通过不置 flag，下次投递重试（第 2 次 repos.get 成功 → 走到 create）
    await exit.deliver({ op: "issue", title: "t" });
    expect(attempts).toBe(2);
    expect(
      octokit.__calls.filter((c) => c.method === "rest.issues.create"),
    ).toHaveLength(1);
  });

  it("op=issue → issues.create 参数精确匹配（含 body）", async () => {
    const { octokit, exit } = bindFake();
    await exit.deliver({ op: "issue", title: "缺陷报告", body: "详情" });
    expect(octokit.__calls).toContainEqual({
      method: "rest.issues.create",
      params: {
        owner: "owner",
        repo: "repo",
        title: "缺陷报告",
        body: "详情",
      },
    });
  });

  it("op=issue 对象 body → json 围栏文本；无 body 不带 body 字段", async () => {
    const { octokit, exit } = bindFake();
    const payload = { trace: "abc" };
    await exit.deliver({ op: "issue", title: "t", body: payload });
    expect(octokit.__calls).toContainEqual({
      method: "rest.issues.create",
      params: {
        owner: "owner",
        repo: "repo",
        title: "t",
        body: "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
      },
    });
    await exit.deliver({ op: "issue", title: "t2" });
    expect(octokit.__calls).toContainEqual({
      method: "rest.issues.create",
      params: { owner: "owner", repo: "repo", title: "t2" },
    });
  });

  it("op=comment → issues.createComment（issue/PR 共用端点）", async () => {
    const { octokit, exit } = bindFake();
    await exit.deliver({ op: "comment", number: 1, body: "收到" });
    expect(octokit.__calls).toContainEqual({
      method: "rest.issues.createComment",
      params: {
        owner: "owner",
        repo: "repo",
        issue_number: 1,
        body: "收到",
      },
    });
  });

  it("op=pr → pulls.create 参数含 head/base，缺省省略", async () => {
    const { octokit, exit } = bindFake();
    await exit.deliver({
      op: "pr",
      title: "PR 标题",
      base: "v3",
      head: "feat/x",
    });
    expect(octokit.__calls).toContainEqual({
      method: "rest.pulls.create",
      params: {
        owner: "owner",
        repo: "repo",
        title: "PR 标题",
        head: "feat/x",
        base: "v3",
      },
    });
    await exit.deliver({ op: "pr", title: "仅标题" });
    expect(octokit.__calls).toContainEqual({
      method: "rest.pulls.create",
      params: { owner: "owner", repo: "repo", title: "仅标题" },
    });
  });

  it("op=clone → downloadCode：path 必填，ref 透传", async () => {
    const { client, exit } = bindFake();
    const downloads: { filePath: string; ref?: string }[] = [];
    jest
      .spyOn(client, "downloadCode")
      .mockImplementation(
        async (filePath: string, ref?: string): Promise<number> => {
          downloads.push({ filePath, ref });
          return 0;
        },
      );
    await exit.deliver({ op: "clone", path: "/tmp/code.tar.gz" });
    await exit.deliver({
      op: "clone",
      path: "/tmp/code2.tar.gz",
      ref: "v1.0.0",
    });
    expect(downloads).toEqual([
      { filePath: "/tmp/code.tar.gz", ref: undefined },
      { filePath: "/tmp/code2.tar.gz", ref: "v1.0.0" },
    ]);
  });

  it("op=clone 缺 path → 抛错", async () => {
    const { exit } = bindFake();
    await expect(exit.deliver({ op: "clone" })).rejects.toThrow("'path'");
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

  it("octokit 抛错（模拟 422）→ deliver 抛错透传", async () => {
    const octokit = makeFakeOctokit();
    octokit.rest.issues.create = (async () => {
      throw new Error("HTTP 422: Validation Failed（label 不存在）");
    }) as OctokitLike["rest"]["issues"]["create"];
    const tool = createGithubExitTool({
      createClient: () => makeClient(octokit),
    });
    const exit = tool.bind(repoConfig);
    await expect(exit.deliver({ op: "issue", title: "t" })).rejects.toThrow(
      "HTTP 422: Validation Failed",
    );
  });
});

describe("GithubClient.downloadCode", () => {
  const gzipBytes = Buffer.from("1f8b-synthetic-tarball-bytes");

  function makeFetchImpl(response: Response | (() => Response)) {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push({ url: String(url), init });
      return typeof response === "function" ? response() : response;
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  function makeClientWith(fetchImpl: typeof fetch, baseUrl?: string) {
    return new GithubClient(
      { token: "tk-test", repo: "owner/repo", ...(baseUrl ? { baseUrl } : {}) },
      { fetchImpl },
    );
  }

  it("fetchImpl 收到正确 URL/头（Bearer token、Accept），跟随 302，写入文件内容一致", async () => {
    const { seen, fetchImpl } = makeFetchImpl(new Response(gzipBytes));
    const client = makeClientWith(fetchImpl);
    const filePath = path.join(
      tmpdir(),
      `github-exit-test-${Date.now()}.tar.gz`,
    );
    try {
      const bytes = await client.downloadCode(filePath, "v1.0.0");
      expect(bytes).toBe(gzipBytes.byteLength);
      const written = await readFile(filePath);
      expect(written.equals(gzipBytes)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(
        "https://api.github.com/repos/owner/repo/tarball/v1.0.0",
      );
      const headers = seen[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tk-test");
      expect(headers.Accept).toBe("application/vnd.github+json");
      expect(seen[0].init?.redirect).toBe("follow");
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it("缺省 ref → tarball 不带 ref 段", async () => {
    const { seen, fetchImpl } = makeFetchImpl(new Response(gzipBytes));
    const client = makeClientWith(fetchImpl);
    await client.downloadCode("/tmp/x.tar.gz");
    expect(seen[0].url).toBe("https://api.github.com/repos/owner/repo/tarball");
  });

  it("非 2xx 响应 → 抛错（含状态码）", async () => {
    const { fetchImpl } = makeFetchImpl(
      new Response("Not Found", { status: 404 }),
    );
    const client = makeClientWith(fetchImpl);
    await expect(client.downloadCode("/tmp/x.tar.gz")).rejects.toThrow(
      "HTTP 404",
    );
  });

  it("网络异常 → 抛错（无法连接）", async () => {
    const { fetchImpl } = makeFetchImpl(() => {
      throw new TypeError("fetch failed");
    });
    const client = makeClientWith(fetchImpl);
    await expect(client.downloadCode("/tmp/x.tar.gz")).rejects.toThrow(
      "无法连接",
    );
  });

  it("baseUrl（GHES）→ tarball 地址指向 {baseUrl}/api/v3", async () => {
    const { seen, fetchImpl } = makeFetchImpl(new Response(gzipBytes));
    const client = makeClientWith(fetchImpl, "https://ghes.example.com/");
    await client.downloadCode("/tmp/x.tar.gz");
    expect(seen[0].url).toBe(
      "https://ghes.example.com/api/v3/repos/owner/repo/tarball",
    );
  });
});
