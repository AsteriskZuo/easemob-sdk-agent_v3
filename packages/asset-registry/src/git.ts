import { execFileSync } from "node:child_process";

/** 凭据形态校验（spec §5.3）：credential 仅支持 https url（经 extraheader 注入，见 buildEnv）；
 *  ssh/scp-like url 直接抛 credential_unsupported；
 *  其余形态（本地路径等）无需认证，凭据忽略 */
function assertCredentialSupported(url: string, credential?: string): void {
  if (!credential || url.startsWith("https://")) {
    return;
  }
  if (url.startsWith("ssh://") || /^[^/@]+@[^/:]+:/.test(url)) {
    throw new Error("credential_unsupported: 私有资产请使用 https 形式的 url");
  }
}

/** git 子进程环境白名单（spec §5.3）：只透传 PATH/HOME（git 找子命令、读 gitconfig 所需），
 *  平台进程其余环境变量（可能含口令）一律不下传；GIT_TERMINAL_PROMPT=0 禁止交互问密码。
 *  https url + credential 时经 GIT_CONFIG_* 注入 http.<url> 作用域的 basic 认证头：
 *  仅当次进程生效——不写 .git/config（clone 落盘的 origin url 是无凭据原文）、
 *  不出现在命令行参数（ps 不可见）、作用域外 host 不携带 */
function buildEnv(url: string, credential?: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (credential && url.startsWith("https://")) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${url}.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`oauth2:${credential}`).toString("base64")}`;
  }
  return env;
}

/** 错误脱敏：凭据值（原文、url 编码、base64 形态）出现处一律替换为 *** */
function sanitize(message: string, credential?: string): string {
  if (!credential) {
    return message;
  }
  return message
    .split(credential)
    .join("***")
    .split(encodeURIComponent(credential))
    .join("***")
    .split(Buffer.from(`oauth2:${credential}`).toString("base64"))
    .join("***");
}

/** 执行 git 子进程：环境白名单 + 凭据走 extraheader（见 buildEnv）；
 *  失败抛 stderr 尾部 1KB（已脱敏） */
function runGit(
  args: string[],
  timeoutSec: number,
  url: string,
  credential?: string,
): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      timeout: timeoutSec * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: buildEnv(url, credential),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const raw = e.stderr ? e.stderr.toString() : (e.message ?? String(err));
    throw new Error(sanitize(raw.slice(-1024).trim(), credential));
  }
}

/** ref → commit 解析（spec §5.3）：
 *  - 40 位 hex 直接作为 commit 返回（存在性留给物化时 checkout 检验）；
 *  - 否则 git ls-remote 解析：无输出 → ref_not_found；注解 tag 优先取 ^{} 剥离行；
 *    分支与 tag 同名等多义 → ref_ambiguous */
export function resolveRef(
  url: string,
  ref: string,
  credential?: string,
): string {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return ref;
  }
  assertCredentialSupported(url, credential);
  // 同时给 <ref> 与 <ref>^{} 两个 pattern：注解 tag 的剥离行不匹配 <ref> 本身，须显式带出
  const out = runGit(["ls-remote", url, ref, `${ref}^{}`], 60, url, credential);
  const entries = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), ref: line.slice(tab + 1) };
    });
  if (entries.length === 0) {
    throw new Error(`ref_not_found: ${ref}`);
  }
  const direct = entries.filter((e) => !e.ref.endsWith("^{}"));
  const peeled = entries.filter((e) => e.ref.endsWith("^{}"));
  if (direct.length > 1) {
    throw new Error(`ref_ambiguous: ${ref}（建议直接给 commit）`);
  }
  const hit = direct[0];
  const peel = peeled.find((e) => e.ref === `${hit.ref}^{}`);
  return peel ? peel.sha : hit.sha;
}

/** clone 仓库并 checkout 到指定 commit（物化用，spec §5.7）；
 *  认证经 extraheader 注入，clone 落盘的 origin url 为无凭据原文；
 *  失败抛 materialize_failed: <stderr 尾部 1KB（已脱敏）> */
export function cloneAtCommit(
  url: string,
  commit: string,
  destDir: string,
  credential?: string,
): void {
  assertCredentialSupported(url, credential);
  try {
    runGit(["clone", "--quiet", url, destDir], 300, url, credential);
    // checkout 是纯本地操作，无需凭据
    runGit(["-C", destDir, "checkout", "--quiet", commit], 300, url);
  } catch (err) {
    throw new Error(`materialize_failed: ${(err as Error).message}`);
  }
}
