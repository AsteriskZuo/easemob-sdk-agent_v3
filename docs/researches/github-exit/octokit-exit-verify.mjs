#!/usr/bin/env node
/**
 * octokit-exit-verify.mjs — GitHub 出口工具（@actions/github REST 通道）验证脚本
 *
 * 验证范围（对应 docs/researches/github-exit/2026-10-03-github-rest-exit-research.md）：
 *   默认（只读）：token 解析 → rest.repos.get（凭证/权限探测）→ tarball 下载（写入 os.tmpdir 后删除）
 *   --write：追加写链路 —— 建 test issue → 评论 → 关闭；推临时分支（空提交）→ 建 PR →
 *             PR 评论 → 关 PR → 删远端分支。标题统一带「[验证]」前缀，产物以关闭收尾。
 *
 * 用法：
 *   node docs/researches/github-exit/octokit-exit-verify.mjs [--repo <owner>/<repo>] [--write]
 *
 * token 来源（不打印）：优先 GH_TOKEN 环境变量，缺省经 `gh auth token` 子进程获取
 * （复用宿主机 gh 登录态；token 本身不落地、不输出）。分支推送用 git 命令（S2 经典命令）。
 * 退出码：0 = 全链路 PASS，1 = 任一步失败。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOctokit } from "@actions/github";

const execFileP = promisify(execFile);

// ---- 参数解析（--repo 支持 "--repo a/b" 与 "--repo=a/b" 两种形式）----
const argv = process.argv.slice(2);
function getArgValue(name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const REPO = getArgValue("--repo") ?? "AsteriskZuo/easemob-sdk-agent_v3";
const WRITE = argv.includes("--write");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const [OWNER, REPO_NAME] = REPO.split("/");
if (!OWNER || !REPO_NAME) {
  console.error(`RESULT: FAIL --repo 须为 owner/repo 形态，收到: ${REPO}`);
  process.exit(1);
}

const tmpDirs = [];
const tmpFiles = [];

/** token 解析：GH_TOKEN 优先，缺省 `gh auth token`；任何路径都不打印 token */
async function resolveToken() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  try {
    const { stdout } = await execFileP("gh", ["auth", "token"], {
      maxBuffer: 1024 * 1024,
    });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fallthrough 到统一报错
  }
  throw new Error(
    "无法获取 token：请设置 GH_TOKEN 环境变量，或在宿主机执行 gh auth login 后重试",
  );
}

async function run(bin, args, opts = {}) {
  try {
    const { stdout } = await execFileP(bin, args, {
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    });
    return stdout.trim();
  } catch (err) {
    const detail = (err.stderr || err.message || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 6)
      .join("\n    ");
    // 绝不回显可能内嵌 token 的命令行：git 推送类命令的 remote URL 含 token
    const label = bin === "git" ? "git ..." : `${bin} ${args.join(" ")}`;
    throw new Error(`${label} → 退出码 ${err.code ?? "非 0"}\n    ${detail}`);
  }
}

function step(name, fn) {
  return fn().then(
    (v) => {
      console.log(`PASS  ${name}`);
      return v;
    },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.error(`      ${err.message.split("\n").join("\n      ")}`);
      throw err;
    },
  );
}

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const file of tmpFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      console.warn(`WARN  临时文件清理失败（请手工删除）: ${file}`);
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      console.warn(`WARN  临时目录清理失败（请手工删除）: ${dir}`);
    }
  }
}

// ---- 只读链路 ----

async function checkRepoAccess(octokit) {
  const { data } = await octokit.rest.repos.get({ owner: OWNER, repo: REPO_NAME });
  const permissions = data.permissions ?? {};
  const writable =
    permissions.admin === true ||
    permissions.push === true ||
    permissions.maintain === true;
  console.log(
    `INFO  仓库: ${data.full_name}，defaultBranch: ${data.default_branch}，push 权限: ${writable ? "有" : "无"}`,
  );
  return { defaultBranch: data.default_branch ?? "main", writable };
}

async function checkTarballDownload(token) {
  const filePath = path.join(
    os.tmpdir(),
    `octokit-exit-tarball-${STAMP}.tar.gz`,
  );
  tmpFiles.push(filePath);
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO_NAME}/tarball`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
      redirect: "follow",
    },
  );
  if (!response.ok) {
    throw new Error(`tarball 下载失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error("tarball 内容为空");
  fs.writeFileSync(filePath, buffer);
  console.log(
    `INFO  tarball ${buffer.byteLength} 字节 → ${filePath}（随后清理，gzip 魔数: ${buffer.subarray(0, 2).toString("hex") === "1f8b" ? "OK" : "异常"}）`,
  );
}

// ---- 写链路（--write）----

async function writeIssueChain(octokit) {
  const title = `[验证] octokit 出口工具 issue 链路验证 ${STAMP}`;
  const body = [
    "本 issue 由 `docs/researches/github-exit/octokit-exit-verify.mjs --write` 自动创建，",
    `用于验证出口工具 @actions/github REST 通道的 issue 链路（${new Date().toISOString()}）。`,
    "验证完成后将以 close 收尾（GitHub issue 不可删除）。",
  ].join("\n");

  const { data: issue } = await step("issue: 创建（rest.issues.create）", () =>
    octokit.rest.issues.create({ owner: OWNER, repo: REPO_NAME, title, body }),
  );
  console.log(`INFO  issue: #${issue.number}`);

  await step("issue: 评论（rest.issues.createComment）", () =>
    octokit.rest.issues.createComment({
      owner: OWNER,
      repo: REPO_NAME,
      issue_number: issue.number,
      body: `[验证] issue 评论链路验证（${STAMP}）`,
    }),
  );
  await step("issue: 关闭（rest.issues.update state=closed）", () =>
    octokit.rest.issues.update({
      owner: OWNER,
      repo: REPO_NAME,
      issue_number: issue.number,
      state: "closed",
    }),
  );
}

async function writePrChain(octokit, token, repoInfo) {
  const branch = `verify/octokit-exit-${STAMP.toLowerCase()}`;
  const base = repoInfo.defaultBranch;
  const dir = makeTmpDir("octokit-exit-pr-");
  const authedRemote = `https://x-access-token:${token}@github.com/${OWNER}/${REPO_NAME}.git`;
  let remoteBranchCreated = false;

  try {
    await step("pr: 克隆并准备临时分支", async () => {
      await run("git", [
        "clone",
        "--depth",
        "1",
        authedRemote,
        dir,
      ]);
      await run("git", ["checkout", "-b", branch], { cwd: dir });
    });

    await step("pr: 空提交并推送分支", async () => {
      await run(
        "git",
        [
          "-c",
          "user.name=octokit-exit-verify",
          "-c",
          "user.email=octokit-exit-verify@users.noreply.github.com",
          "commit",
          "--allow-empty",
          "-m",
          `[验证] 空提交：octokit 出口工具 PR 链路验证 ${STAMP}`,
        ],
        { cwd: dir },
      );
      await run("git", ["push", "-u", "origin", branch], { cwd: dir });
      remoteBranchCreated = true;
    });

    const title = `[验证] octokit 出口工具 PR 链路验证 ${STAMP}`;
    const prBody = [
      "本 PR 由 `docs/researches/github-exit/octokit-exit-verify.mjs --write` 自动创建（空提交），",
      `用于验证出口工具 @actions/github REST 通道的 PR 链路（${new Date().toISOString()}）。`,
      "验证完成后将以 close 收尾并删除临时分支（PR 不可删除）。",
    ].join("\n");

    const { data: pr } = await step("pr: 创建（rest.pulls.create）", () =>
      octokit.rest.pulls.create({
        owner: OWNER,
        repo: REPO_NAME,
        title,
        body: prBody,
        head: branch,
        base,
      }),
    );
    console.log(`INFO  pr: #${pr.number}（base: ${base} ← head: ${branch}）`);

    await step("pr: 评论（rest.issues.createComment）", () =>
      octokit.rest.issues.createComment({
        owner: OWNER,
        repo: REPO_NAME,
        issue_number: pr.number,
        body: `[验证] PR 评论链路验证（${STAMP}）`,
      }),
    );
    await step("pr: 关闭（rest.pulls.update state=closed）", () =>
      octokit.rest.pulls.update({
        owner: OWNER,
        repo: REPO_NAME,
        pull_number: pr.number,
        state: "closed",
      }),
    );
    await step("pr: 删除远端分支", async () => {
      await run("git", ["push", "origin", "--delete", branch], { cwd: dir });
      remoteBranchCreated = false;
    });
  } finally {
    if (remoteBranchCreated) {
      try {
        await run("git", ["push", "origin", "--delete", branch], { cwd: dir });
        console.log("INFO  finally: 已删除遗留远端分支");
      } catch {
        console.warn(`WARN  远端分支清理失败（请手工删除）: ${branch}`);
      }
    }
  }
}

// ---- 主流程 ----

async function main() {
  console.log(
    `== octokit 出口工具验证 == repo: ${REPO}，模式: ${WRITE ? "读写（--write）" : "只读"}`,
  );

  const token = await step("auth: 解析 token（GH_TOKEN 或 gh auth token）", resolveToken);
  const octokit = getOctokit(token);
  const repoInfo = await step("repo: 凭证与仓库权限（rest.repos.get）", () =>
    checkRepoAccess(octokit),
  );
  await step("tarball: 下载代码（REST tarball → tmp，验证后删除）", () =>
    checkTarballDownload(token),
  );

  if (WRITE) {
    if (!repoInfo.writable) {
      throw new Error("当前 token 对仓库无 push 权限，--write 链路必然失败");
    }
    await writeIssueChain(octokit);
    await writePrChain(octokit, token, repoInfo);
  } else {
    console.log(
      "INFO  只读验证完成；追加写链路请加 --write（会在目标仓库留下关闭的验证 issue/PR）",
    );
  }

  console.log("RESULT: PASS");
}

main()
  .catch(() => {
    console.log("RESULT: FAIL");
    process.exitCode = 1;
  })
  .finally(cleanup);
