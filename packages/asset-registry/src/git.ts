import { execFileSync } from "node:child_process";

/** 凭据注入（spec §5.3）：仅对本次 git 子进程把 https url 临时改写为带凭据形态；
 *  不落盘、不入库、不进日志。ssh/scp-like url 不支持注入，直接抛 credential_unsupported；
 *  其余形态（本地路径等）原样使用（本地 clone 无需认证，注入不适用） */
function injectCredential(url: string, credential?: string): string {
  if (!credential) {
    return url;
  }
  if (url.startsWith("https://")) {
    return `https://oauth2:${encodeURIComponent(credential)}@${url.slice("https://".length)}`;
  }
  if (url.startsWith("ssh://") || /^[^/@]+@[^/:]+:/.test(url)) {
    throw new Error("credential_unsupported: 私有资产请使用 https 形式的 url");
  }
  return url;
}

/** 错误脱敏：凭据值（原文与 url 编码形态）出现处一律替换为 *** */
function sanitize(message: string, credential?: string): string {
  if (!credential) {
    return message;
  }
  return message
    .split(credential)
    .join("***")
    .split(encodeURIComponent(credential))
    .join("***");
}

/** 执行 git 子进程：GIT_TERMINAL_PROMPT=0 禁止交互；失败抛 stderr 尾部 1KB（已脱敏） */
function runGit(
  args: string[],
  timeoutSec: number,
  credential?: string,
): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      timeout: timeoutSec * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
  const effectiveUrl = injectCredential(url, credential);
  // 同时给 <ref> 与 <ref>^{} 两个 pattern：注解 tag 的剥离行不匹配 <ref> 本身，须显式带出
  const out = runGit(
    ["ls-remote", effectiveUrl, ref, `${ref}^{}`],
    60,
    credential,
  );
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
 *  失败抛 materialize_failed: <stderr 尾部 1KB（已脱敏）> */
export function cloneAtCommit(
  url: string,
  commit: string,
  destDir: string,
  credential?: string,
): void {
  const effectiveUrl = injectCredential(url, credential);
  try {
    runGit(["clone", "--quiet", effectiveUrl, destDir], 300, credential);
    runGit(["-C", destDir, "checkout", "--quiet", commit], 300, credential);
  } catch (err) {
    throw new Error(`materialize_failed: ${(err as Error).message}`);
  }
}
