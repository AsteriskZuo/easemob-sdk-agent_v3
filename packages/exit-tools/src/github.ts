import { writeFile } from "node:fs/promises";
import { getOctokit } from "@actions/github";
import type { ConfigField, Exit, ExitTool } from "./types.js";

const KIND = "github";
const DEFAULT_API_BASE = "https://api.github.com";

/** Octokit 最小表面（结构化类型，不 import @octokit 类型以避免版本耦合）：
 *  真实 @actions/github 的 getOctokit 返回值天然满足本接口 */
export interface OctokitLike {
  rest: {
    repos: {
      /** 仓库探测：GET /repos/{owner}/{repo}（assertUsable 用） */
      get(params: { owner: string; repo: string }): Promise<unknown>;
    };
    issues: {
      /** 建 issue：POST /repos/{owner}/{repo}/issues；返回 data.number */
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body?: string;
      }): Promise<{ data: { number: number } }>;
      /** 评论（issue/PR 同端点）：POST /repos/{owner}/{repo}/issues/{number}/comments */
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      /** 关闭 issue（state=closed） */
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        state: string;
      }): Promise<unknown>;
    };
    pulls: {
      /** 建 PR：POST /repos/{owner}/{repo}/pulls；返回 data.number */
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body?: string;
        head?: string;
        base?: string;
      }): Promise<{ data: { number: number } }>;
      /** 关闭 PR（state=closed） */
      update(params: {
        owner: string;
        repo: string;
        pull_number: number;
        state: string;
      }): Promise<unknown>;
    };
  };
  /** 未封装端点的逃生门（octokit.request，调用方可自行扩展任意 REST 端点） */
  request?(route: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** GithubClient 构造配置：token/repo 必填，baseUrl 为 GHES 实例地址（缺省 github.com） */
export interface GithubClientOptions {
  /** REST 认证 token（Bearer）；GitHub 出口无可依赖的宿主机 keyring，必填 */
  token: string;
  /** 仓库，owner/repo 形态（调用方经 parseRepo 归一化） */
  repo: string;
  /** GHES 实例地址（如 https://ghes.example.com），缺省 github.com */
  baseUrl?: string;
}

/** 构造可选依赖注入（测试用假 octokit / fetch，零真实网络） */
export interface GithubClientDeps {
  /** 缺省经 getOctokit(token, { baseUrl }) 构造 */
  octokit?: OctokitLike;
  /** 缺省全局 fetch；仅 downloadCode 使用 */
  fetchImpl?: typeof fetch;
}

const configSchema: ConfigField[] = [
  {
    key: "repo",
    label: "仓库地址",
    required: true,
    placeholder:
      "https://github.com/owner/repo 或 git@github.com:owner/repo 或 owner/repo",
  },
  {
    key: "base_url",
    label: "GitHub 实例地址（GHES 时填，缺省 github.com）",
  },
  {
    key: "token",
    label: "GitHub Token（REST 必需，无宿主机 keyring 可依赖）",
    required: true,
    secret: true,
  },
];

/** 仓库地址解析结果：host 为归一化小写主机名，owner/repo 为小写 */
interface ParsedRepo {
  host: string;
  owner: string;
  repo: string;
}

/** 仓库地址两阶段归一化（调研文档算法）：
 *  ① new URL() 解析显式协议（http/https/ssh/git，ssh:// 的用户段忽略）；
 *  ② 失败则按 scp 语法 `git@host:owner/repo`（去 git@ 前缀、按首个 ':' 分 host/path）；
 *  ③ 纯 `owner/repo` 两段简写补默认 github.com；其余输入非法抛错。
 *  path 去前导 '/'、尾斜杠与 .git 后缀，统一小写。 */
function parseRepo(input: string): ParsedRepo {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`出口工具 '${KIND}' 缺少必需配置项 'repo'`);
  }

  let host = "";
  let path = "";

  const SUPPORTED_PROTOCOLS = ["http:", "https:", "ssh:", "git:"];
  try {
    const url = new URL(trimmed);
    if (SUPPORTED_PROTOCOLS.includes(url.protocol) && url.hostname) {
      host = url.hostname;
      path = url.pathname;
    }
  } catch {
    // 非显式协议 URL，走下方 scp/简写分支
  }

  if (!host) {
    // scp 语法：git@host:owner/repo（git@ 前缀可选）
    const scp = trimmed.match(/^(?:git@)?([^:/\s]+):(.+)$/);
    if (scp) {
      host = scp[1];
      path = scp[2];
    } else if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
      // owner/repo 简写
      host = "github.com";
      path = trimmed;
    } else {
      throw new Error(
        `${KIND} 配置非法：repo='${trimmed}' 不是合法仓库地址（支持 https/ssh/git@/owner/repo 形态）`,
      );
    }
  }

  const cleaned = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const segments = cleaned.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) {
    throw new Error(
      `${KIND} 配置非法：repo='${trimmed}' 无法解析为 host/owner/repo（owner/repo 必须恰为两段）`,
    );
  }
  return {
    host: host.toLowerCase(),
    owner: segments[0].toLowerCase(),
    repo: segments[1].toLowerCase(),
  };
}

/** body 渲染：字符串原样；其他值走 ```json 围栏文本（与包内其他出口一致） */
function renderBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  return "```json\n" + JSON.stringify(body, null, 2) + "\n```";
}

/** 校验 payload 字段为字符串，缺失/类型错抛错（说明合法形态） */
function requireStringField(
  payload: Record<string, unknown>,
  field: string,
  legalForms: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || !value) {
    throw new Error(
      `出口工具 '${KIND}' 投递 payload 非法：字段 '${field}' 缺失或不是非空字符串。合法形态：${legalForms}`,
    );
  }
  return value;
}

/** 无业务知识的 GitHub REST 工具类：构造注入 options + 可选 octokit/fetch，
 *  类内零 process.env 读取、零全局状态。新端点需求优先经 api 逃生门或扩展调用方，
 *  不再为本类加固化方法。 */
export class GithubClient {
  private readonly octokit: OctokitLike;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBase: string;

  constructor(options: GithubClientOptions, deps?: GithubClientDeps) {
    const segments = options.repo.split("/");
    if (segments.length !== 2 || segments.some((s) => !s)) {
      throw new Error(
        `GithubClient 构造参数非法：repo='${options.repo}' 须为 owner/repo 形态`,
      );
    }
    this.owner = segments[0];
    this.repo = segments[1];
    this.token = options.token;
    this.apiBase = options.baseUrl
      ? `${options.baseUrl.replace(/\/+$/, "")}/api/v3`
      : DEFAULT_API_BASE;
    this.octokit =
      deps?.octokit ??
      (getOctokit(options.token, octokitBaseUrl(options)) as OctokitLike);
    this.fetchImpl = deps?.fetchImpl ?? fetch;
  }

  /** 底层 octokit 实例透传：未封装端点的逃生门。
   *  新需求优先走这里（octokit.request）或在调用方扩展，不再加固化方法。 */
  get api(): OctokitLike {
    return this.octokit;
  }

  /** 前置校验：rest.repos.get 探测（凭证有效性 + 仓库权限）。
   *  失败抛错（含权限/凭证提示；私有仓库无权限返回 404 而非 403），
   *  把配置错误前置到首次投递（由调用方做惰性一次性调度） */
  async assertUsable(): Promise<void> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
    } catch (err) {
      throw new Error(
        `GitHub 凭证或仓库权限校验失败：${(err as Error).message}（请检查 token 有效性、scopes 与目标仓库权限）`,
      );
    }
  }

  /** 建 issue（rest.issues.create）；返回 issue number */
  async createIssue(title: string, body?: string): Promise<number> {
    const response = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      ...(body !== undefined ? { body } : {}),
    });
    return response.data.number;
  }

  /** 评论（rest.issues.createComment，issue/PR 同端点） */
  async addComment(number: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      body,
    });
  }

  /** 建 PR（rest.pulls.create；head 分支须已推送）；返回 PR number */
  async createPullRequest(options: {
    title: string;
    body?: string;
    head?: string;
    base?: string;
  }): Promise<number> {
    const response = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: options.title,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.head ? { head: options.head } : {}),
      ...(options.base ? { base: options.base } : {}),
    });
    return response.data.number;
  }

  /** 下载仓库 tarball（GET /repos/{owner}/{repo}/tarball/{ref}，跟随 302 到 codeload）
   *  写入 filePath；返回字节数。非 2xx 抛错 */
  async downloadCode(filePath: string, ref?: string): Promise<number> {
    const suffix = ref ? `/${encodeURIComponent(ref)}` : "";
    const url = `${this.apiBase}/repos/${this.owner}/${this.repo}/tarball${suffix}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
        },
        redirect: "follow",
      });
    } catch (err) {
      throw new Error(
        `GitHub tarball 下载失败：无法连接（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `GitHub tarball 下载失败：HTTP ${response.status}${detail ? `，响应片段：${detail}` : ""}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, buffer);
    return buffer.byteLength;
  }
}

/** getOctokit 的 baseUrl 参数：GHES 为 {baseUrl}/api/v3，github.com 缺省不传 */
function octokitBaseUrl(options: GithubClientOptions): {
  baseUrl?: string;
} {
  return options.baseUrl
    ? { baseUrl: `${options.baseUrl.replace(/\/+$/, "")}/api/v3` }
    : {};
}

/** 缺省 client 工厂：把绑定配置（snake_case 键）映射为 GithubClientOptions */
function defaultCreateClient(config: Record<string, string>): GithubClient {
  const parsed = parseRepo(config.repo ?? "");
  return new GithubClient({
    token: config.token,
    repo: `${parsed.owner}/${parsed.repo}`,
    ...(config.base_url ? { baseUrl: config.base_url } : {}),
  });
}

const LEGAL_FORMS =
  "{ op: 'issue', title, body? } | { op: 'comment', number, body } | " +
  "{ op: 'pr', title, body?, head?, base? } | { op: 'clone', path, ref? }";

/** GitHub 出口工具（kind = 'github'，name = 'GitHub 操作'）。
 *  经 @actions/github（Octokit REST 客户端）操作仓库，无子进程；
 *  createClient 可注入（测试用假 client），缺省直接 new GithubClient */
export function createGithubExitTool(options?: {
  createClient?: (config: Record<string, string>) => GithubClient;
}): ExitTool {
  const createClient = options?.createClient ?? defaultCreateClient;
  return {
    kind: KIND,
    name: "GitHub 操作",
    implemented: true,
    configSchema,
    destinationOf(config) {
      const parsed = parseRepo(config.repo ?? "");
      // destination_id 契约：host/owner/repo 的 ':'/'/' → '_'
      return `${parsed.host}_${parsed.owner}_${parsed.repo}`;
    },
    bind(config): Exit {
      // parseRepo 先做地址合法性校验（缺 repo/非法形态在此抛错）
      parseRepo(config.repo ?? "");
      for (const field of configSchema) {
        if (field.required && !config[field.key]?.trim()) {
          throw new Error(`出口工具 '${KIND}' 缺少必需配置项 '${field.key}'`);
        }
      }
      const client = createClient({ ...config });
      let usableChecked = false;
      return {
        async deliver(result): Promise<void> {
          // bind 为同步签名：可用性校验惰性放到首次投递前，成功后仅执行一次
          if (!usableChecked) {
            await client.assertUsable();
            usableChecked = true;
          }
          if (typeof result !== "object" || result === null) {
            throw new Error(
              `出口工具 '${KIND}' 投递 payload 非法：须为对象。合法形态：${LEGAL_FORMS}`,
            );
          }
          const payload = result as Record<string, unknown>;
          switch (payload.op) {
            case "issue": {
              const title = requireStringField(payload, "title", LEGAL_FORMS);
              await client.createIssue(title, renderBody(payload.body));
              return;
            }
            case "comment": {
              const number = payload.number;
              if (
                typeof number !== "number" ||
                !Number.isInteger(number) ||
                number <= 0
              ) {
                throw new Error(
                  `出口工具 '${KIND}' 投递 payload 非法：字段 'number' 缺失或不是正整数。合法形态：${LEGAL_FORMS}`,
                );
              }
              const body = renderBody(payload.body);
              if (body === undefined) {
                throw new Error(
                  `出口工具 '${KIND}' 投递 payload 非法：字段 'body' 缺失。合法形态：${LEGAL_FORMS}`,
                );
              }
              await client.addComment(number, body);
              return;
            }
            case "pr": {
              const title = requireStringField(payload, "title", LEGAL_FORMS);
              const head =
                typeof payload.head === "string" && payload.head
                  ? payload.head
                  : undefined;
              const base =
                typeof payload.base === "string" && payload.base
                  ? payload.base
                  : undefined;
              await client.createPullRequest({
                title,
                body: renderBody(payload.body),
                head,
                base,
              });
              return;
            }
            case "clone": {
              const filePath = requireStringField(payload, "path", LEGAL_FORMS);
              const ref =
                typeof payload.ref === "string" && payload.ref
                  ? payload.ref
                  : undefined;
              await client.downloadCode(filePath, ref);
              return;
            }
            default:
              throw new Error(
                `出口工具 '${KIND}' 投递 payload 非法：op '${String(payload.op)}' 缺失或未知。合法形态：${LEGAL_FORMS}`,
              );
          }
        },
      };
    },
  };
}
