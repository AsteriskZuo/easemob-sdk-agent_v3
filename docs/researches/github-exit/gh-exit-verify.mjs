#!/usr/bin/env node
/**
 * gh-exit-verify.mjs — GitHub 出口工具（gh CLI 通道）验证脚本
 *
 * 验证范围（对应 docs/researches/github-exit/2026-10-03-github-rest-exit-research.md）：
 *   默认（只读）：gh 可用性 → 登录态 → 仓库权限/default branch → 浅克隆（下载代码）后清理
 *   --write：追加写链路 —— 建 test issue → 评论 → 关闭；推临时分支（空提交）→ 建 PR →
 *             PR 评论 → 关 PR → 删远端分支。标题统一带「[验证]」前缀，产物以关闭收尾。
 *
 * 用法：
 *   node docs/researches/github-exit/gh-exit-verify.mjs [--repo <owner>/<repo>] [--write]
 *
 * 前置条件：宿主机已安装 gh 且已登录（gh auth login），或对目标 host 设置了 GH_TOKEN。
 * 仅依赖 node 内置模块，无第三方依赖。退出码：0 = 全链路 PASS，1 = 任一步失败。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

// ---- 参数解析（--repo 支持 "--repo a/b" 与 "--repo=a/b" 两种形式）----
const argv = process.argv.slice(2);
function getArgValue(name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const REPO = getArgValue('--repo') ?? 'AsteriskZuo/easemob-sdk-agent_v3';
const WRITE = argv.includes('--write');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

// 子进程统一环境：禁交互提示（失败即报错而非挂起）、禁颜色、禁更新检查提示
const CHILD_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

const tmpDirs = [];

async function run(bin, args, opts = {}) {
  try {
    const { stdout } = await execFileP(bin, args, {
      env: CHILD_ENV,
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    });
    return stdout.trim();
  } catch (err) {
    const detail = (err.stderr || err.message || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 6)
      .join('\n    ');
    throw new Error(`${bin} ${args.join(' ')} → 退出码 ${err.code ?? '非 0'}\n    ${detail}`);
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
      console.error(`      ${err.message.split('\n').join('\n      ')}`);
      throw err;
    },
  );
}

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function cleanupTmpDirs() {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      console.warn(`WARN  临时目录清理失败（请手工删除）: ${dir}`);
    }
  }
}

// ---- 只读链路 ----

async function assertGhInstalled() {
  try {
    const out = await run('gh', ['--version']);
    console.log(`INFO  ${out.split('\n')[0]}`);
  } catch (err) {
    throw new Error(
      `未检测到 gh 命令。请先安装 GitHub CLI（如 macOS: brew install gh），并执行 gh auth login 登录。\n    ${err.message}`,
    );
  }
}

async function checkAuthStatus() {
  let out;
  try {
    out = await run('gh', ['auth', 'status']);
  } catch (err) {
    throw new Error(
      `gh 未登录或凭据失效。请在宿主机执行 gh auth login，或为对应 host 设置 GH_TOKEN 环境变量后重试。\n    ${err.message}`,
    );
  }
  // 输出含 token 细节，摘要展示：取 "Logged in to" 行即可
  const summary = out
    .split('\n')
    .filter((l) => /Logged in to/i.test(l))
    .join('；');
  console.log(`INFO  登录态: ${summary || '已登录'}`);
}

async function checkRepoView() {
  const out = await run('gh', [
    'repo',
    'view',
    REPO,
    '--json',
    'nameWithOwner,viewerPermission,defaultBranchRef',
  ]);
  const info = JSON.parse(out);
  const defaultBranch = info.defaultBranchRef?.name ?? '(未知)';
  console.log(
    `INFO  仓库: ${info.nameWithOwner}，viewerPermission: ${info.viewerPermission}，defaultBranch: ${defaultBranch}`,
  );
  if (!['ADMIN', 'WRITE', 'MAINTAIN'].includes(info.viewerPermission)) {
    throw new Error(`viewerPermission=${info.viewerPermission}，无写权限，--write 链路必然失败`);
  }
  return { ...info, defaultBranch };
}

async function checkClone() {
  const dir = makeTmpDir('gh-exit-clone-');
  await run('gh', ['repo', 'clone', REPO, dir, '--', '--depth', '1']);
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) throw new Error(`克隆目录为空: ${dir}`);
  console.log(`INFO  克隆 ${entries.length} 个顶层条目 → ${dir}（随后清理）`);
}

// ---- 写链路（--write）----

async function writeIssueChain() {
  const title = `[验证] gh 出口工具 issue 链路验证 ${STAMP}`;
  const body = [
    '本 issue 由 `docs/researches/github-exit/gh-exit-verify.mjs --write` 自动创建，',
    `用于验证出口工具 gh CLI 通道的 issue 链路（${new Date().toISOString()}）。`,
    '验证完成后将以 close 收尾（GitHub issue 不可删除）。',
  ].join('\n');

  const url = await step('issue: 创建', () =>
    run('gh', ['issue', 'create', '-R', REPO, '--title', title, '--body', body]),
  );
  const number = url.match(/(\d+)$/)?.[1];
  if (!number) throw new Error(`无法从输出解析 issue 号: ${url}`);
  console.log(`INFO  issue: ${url}`);

  await step('issue: 评论', () =>
    run('gh', [
      'issue',
      'comment',
      number,
      '-R',
      REPO,
      '--body',
      `[验证] issue 评论链路验证（${STAMP}）`,
    ]),
  );
  await step('issue: 关闭', () => run('gh', ['issue', 'close', number, '-R', REPO]));
}

async function writePrChain(repoInfo) {
  const branch = `verify/gh-exit-${STAMP.toLowerCase()}`;
  const base = repoInfo.defaultBranch;
  const dir = makeTmpDir('gh-exit-pr-');
  let remoteBranchCreated = false;

  try {
    await step('pr: 克隆并准备临时分支', async () => {
      await run('gh', ['repo', 'clone', REPO, dir, '--', '--depth', '1']);
      await run('git', ['checkout', '-b', branch], { cwd: dir });
    });

    await step('pr: 空提交并推送分支', async () => {
      await run(
        'git',
        [
          '-c',
          'user.name=gh-exit-verify',
          '-c',
          'user.email=gh-exit-verify@users.noreply.github.com',
          'commit',
          '--allow-empty',
          '-m',
          `[验证] 空提交：gh 出口工具 PR 链路验证 ${STAMP}`,
        ],
        { cwd: dir },
      );
      await run('git', ['push', '-u', 'origin', branch], { cwd: dir });
      remoteBranchCreated = true;
    });

    const title = `[验证] gh 出口工具 PR 链路验证 ${STAMP}`;
    const prBody = [
      '本 PR 由 `docs/researches/github-exit/gh-exit-verify.mjs --write` 自动创建（空提交），',
      `用于验证出口工具 gh CLI 通道的 PR 链路（${new Date().toISOString()}）。`,
      '验证完成后将以 close 收尾并删除临时分支（PR 不可删除）。',
    ].join('\n');

    const url = await step('pr: 创建', () =>
      run(
        'gh',
        ['pr', 'create', '-R', REPO, '-B', base, '-H', branch, '--title', title, '--body', prBody],
        { cwd: dir },
      ),
    );
    const number = url.match(/(\d+)$/)?.[1];
    if (!number) throw new Error(`无法从输出解析 PR 号: ${url}`);
    console.log(`INFO  pr: ${url}（base: ${base} ← head: ${branch}）`);

    await step('pr: 评论', () =>
      run('gh', ['pr', 'comment', number, '-R', REPO, '--body', `[验证] PR 评论链路验证（${STAMP}）`]),
    );
    await step('pr: 关闭', () => run('gh', ['pr', 'close', number, '-R', REPO]));
    await step('pr: 删除远端分支', async () => {
      await run('git', ['push', 'origin', '--delete', branch], { cwd: dir });
      remoteBranchCreated = false;
    });
  } finally {
    if (remoteBranchCreated) {
      try {
        await run('git', ['push', 'origin', '--delete', branch], { cwd: dir });
        console.log('INFO  finally: 已删除遗留远端分支');
      } catch {
        console.warn(`WARN  远端分支清理失败（请手工删除）: ${branch}`);
      }
    }
  }
}

// ---- 主流程 ----

async function main() {
  console.log(`== gh 出口工具验证 == repo: ${REPO}，模式: ${WRITE ? '读写（--write）' : '只读'}`);

  await assertGhInstalled();
  await step('auth: 登录态', checkAuthStatus);
  const repoInfo = await step('repo: 权限与默认分支', checkRepoView);
  await step('clone: 下载代码（浅克隆+清理）', checkClone);

  if (WRITE) {
    await writeIssueChain();
    await writePrChain(repoInfo);
  } else {
    console.log('INFO  只读验证完成；追加写链路请加 --write（会在目标仓库留下关闭的验证 issue/PR）');
  }

  console.log('RESULT: PASS');
}

main()
  .catch(() => {
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  })
  .finally(cleanupTmpDirs);
