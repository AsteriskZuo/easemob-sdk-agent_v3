import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConfigField, Exit, ExitTool } from "./types.js";

const KIND = "github";

const execFileAsync = promisify(execFile);

/** gh 子进程抽象：args 为 gh 命令行参数（无 shell 拼接）；非零退出抛错（消息含 stderr 片段），
 *  resolve 值为 stdout。由 createGithubExitTool 的 createRunner 注入，测试用假实现 */
export type GhRunner = (
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

const configSchema: ConfigField[] = [
  {
    key: "repo",
    label: "仓库地址",
    required: true,
    placeholder:
      "https://github.com/owner/repo 或 git@github.com:owner/repo 或 owner/repo",
  },
  {
    key: "token",
    label: "GitHub Token（缺省用宿主机 gh 登录态）",
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

/** 无业务知识的 gh CLI 工具类：构造注入 runner/repo/env，零 process.env 读取、零全局状态 */
export class GhCli {
  private readonly runner: GhRunner;
  readonly repo: string;
  private readonly env?: Record<string, string>;

  /** repo 须为规范化后的 owner/repo 形态（调用方经 parseRepo 归一化） */
  constructor(options: {
    runner: GhRunner;
    repo: string;
    env?: Record<string, string>;
  }) {
    this.runner = options.runner;
    this.repo = options.repo;
    this.env = options.env;
  }

  private run(args: string[]): Promise<string> {
    return this.runner(args, this.env ? { env: this.env } : undefined);
  }

  /** 前置校验：gh 可执行且已认证（gh --version + gh auth status）。
   *  失败抛错（消息提示检查 gh 安装/登录），把配置错误前置到首次投递 */
  async assertUsable(): Promise<void> {
    try {
      await this.run(["--version"]);
      await this.run(["auth", "status"]);
    } catch (err) {
      throw new Error(
        `gh CLI 不可用或未登录：${(err as Error).message}（请检查 gh 是否安装、已 gh auth login，或配置 token）`,
      );
    }
  }

  /** gh issue create -R <repo> --title <t> [--body <b>] */
  async createIssue(title: string, body?: string): Promise<void> {
    await this.run([
      "issue",
      "create",
      "--repo",
      this.repo,
      "--title",
      title,
      ...(body !== undefined ? ["--body", body] : []),
    ]);
  }

  /** gh issue comment <n> -R <repo> --body <b>（issue/PR 同端点） */
  async addComment(number: number, body: string): Promise<void> {
    await this.run([
      "issue",
      "comment",
      String(number),
      "--repo",
      this.repo,
      "--body",
      body,
    ]);
  }

  /** gh pr create -R <repo> --title <t> [--body <b>] [--head <h>] [--base <b>] */
  async createPullRequest(
    title: string,
    body?: string,
    options?: { head?: string; base?: string },
  ): Promise<void> {
    await this.run([
      "pr",
      "create",
      "--repo",
      this.repo,
      "--title",
      title,
      ...(body !== undefined ? ["--body", body] : []),
      ...(options?.head ? ["--head", options.head] : []),
      ...(options?.base ? ["--base", options.base] : []),
    ]);
  }

  /** gh repo clone <repo> <dir> */
  async cloneRepo(dir: string): Promise<void> {
    await this.run(["repo", "clone", this.repo, dir]);
  }
}

/** 缺省 runner 工厂（ghPath 缺省 'gh'）：execFile 包装；统一注入防交互挂起/日志噪声的环境变量；
 *  非零退出抛错（消息含 stderr 片段） */
function defaultCreateRunner(ghPath: string) {
  return (env?: Record<string, string>): GhRunner => {
    return async (args, options) => {
      try {
        const { stdout } = await execFileAsync(ghPath, args, {
          cwd: options?.cwd,
          env: {
            ...process.env,
            ...env,
            ...options?.env,
            GH_PROMPT_DISABLED: "1",
            NO_COLOR: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
          },
          maxBuffer: 4 * 1024 * 1024,
        });
        return stdout;
      } catch (err) {
        const e = err as Error & { stderr?: string };
        const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
        const detail = (stderr || e.message || String(err)).slice(0, 500);
        throw new Error(
          `gh 命令执行失败（${ghPath} ${args.join(" ")}）：${detail}`,
        );
      }
    };
  };
}

const LEGAL_FORMS =
  "{ op: 'issue', title, body? } | { op: 'comment', number, body } | " +
  "{ op: 'pr', title, body?, head?, base? } | { op: 'clone', dir? }";

/** GitHub 出口工具（kind = 'github'，name = 'GitHub 操作'）。
 *  经 gh CLI 子进程操作仓库；createRunner 可注入（测试用），缺省为真实 spawn 实现 */
export function createGithubExitTool(options?: {
  createRunner?: (env?: Record<string, string>) => GhRunner;
  ghPath?: string;
}): ExitTool {
  const createRunner =
    options?.createRunner ?? defaultCreateRunner(options?.ghPath ?? "gh");

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
      const parsed = parseRepo(config.repo ?? "");
      const token = config.token?.trim();
      const env = token ? { GH_TOKEN: token } : undefined;
      const cli = new GhCli({
        runner: createRunner(env),
        repo: `${parsed.owner}/${parsed.repo}`,
        env,
      });
      const defaultCloneDir = parsed.repo;
      let usableChecked = false;
      return {
        async deliver(result): Promise<void> {
          // bind 为同步签名：可用性校验惰性放到首次投递前
          if (!usableChecked) {
            await cli.assertUsable();
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
              await cli.createIssue(title, renderBody(payload.body));
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
              await cli.addComment(number, body);
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
              await cli.createPullRequest(title, renderBody(payload.body), {
                head,
                base,
              });
              return;
            }
            case "clone": {
              const dir =
                typeof payload.dir === "string" && payload.dir
                  ? payload.dir
                  : defaultCloneDir;
              await cli.cloneRepo(dir);
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
