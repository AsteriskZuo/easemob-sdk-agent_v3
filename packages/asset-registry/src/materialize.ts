import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { cloneAtCommit } from "./git.js";
import { assertProgramsBuilt, validateAssetShape } from "./validate.js";
import type { AssetKind, AssetManifest } from "./validate.js";

/** npm ci / 业务初始化脚本的子进程超时（spec §4.3/§4.4：各 10 分钟） */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** 失败消息携带的 stderr 尾部行数上限（spec §4.2） */
const STDERR_TAIL_LINES = 30;

/** 物化输入（与 AssetRegistry.materialize / materialize-cli 共用） */
export interface MaterializeGitOptions {
  /** git 仓库地址（本地路径亦可） */
  url: string;
  /** 目标 commit（40 位 hex；登记时已由 ref 解析存定） */
  commit: string;
  /** 资产根在仓库内的子路径（缺省 = 仓库根） */
  subpath?: string;
  /** 物化产物最终就位目录（原子 rename 目标；已存在则先删） */
  target: string;
  /** 私有仓库凭据值（仅 https url 注入本次 clone，见 git.ts） */
  credential?: string;
  /** 资产三族；缺省时按资产根是否含 agent-package.json 探测（有 = package 形态参与构建，无 = skill 不构建）。
   *  平台路径（AssetRegistry）必传登记行的真实 kind；CLI 独立执行不传 */
  kind?: AssetKind;
  /** npm registry 地址（映射为 NPM_CONFIG_REGISTRY 传给 npm ci 与初始化脚本子进程；缺省 = npm 自身默认） */
  npmRegistry?: string;
}

/** 构建子进程环境（spec §4.3）：只透传 PATH/HOME（+ 可选 NPM_CONFIG_REGISTRY），
 *  不继承平台进程其余环境变量 */
function buildChildEnv(npmRegistry?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (npmRegistry !== undefined && npmRegistry !== "") {
    env.NPM_CONFIG_REGISTRY = npmRegistry;
  }
  return env;
}

/** 提取子进程失败的 stderr 尾部（最后 STDERR_TAIL_LINES 行）；无 stderr 退到 err.message */
function stderrTail(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  const raw =
    e.stderr !== undefined && String(e.stderr).trim() !== ""
      ? String(e.stderr)
      : (e.message ?? String(err));
  const lines = raw.trimEnd().split("\n");
  return lines.slice(-STDERR_TAIL_LINES).join("\n");
}

/** 同步执行一个构建阶段子进程；失败抛 materialize_failed: <阶段名>: <stderr 尾部 30 行> */
function runBuildStage(
  stage: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  try {
    execFileSync(command, args, {
      cwd,
      env,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`materialize_failed: ${stage}: ${stderrTail(err)}`);
  }
}

/** package/tool 资产的构建段（spec §4.3/§4.4）：
 *  资产根含 package.json 时先 npm ci（必须同时含 package-lock.json），
 *  然后执行业务初始化脚本 agent.materialize.mjs（必带，缺失即失败） */
function buildAsset(assetRoot: string, npmRegistry?: string): void {
  const env = buildChildEnv(npmRegistry);
  if (existsSync(path.join(assetRoot, "package.json"))) {
    if (!existsSync(path.join(assetRoot, "package-lock.json"))) {
      throw new Error(
        "materialize_failed: npm ci: 资产根含 package.json 但缺 package-lock.json（v1 只支持 npm + package-lock.json）",
      );
    }
    runBuildStage(
      "npm ci",
      "npm",
      ["ci", "--no-audit", "--no-fund"],
      assetRoot,
      env,
    );
  }
  const script = path.join(assetRoot, "agent.materialize.mjs");
  if (!existsSync(script)) {
    throw new Error(
      "materialize_failed: 业务初始化脚本缺失: package/tool 资产根必须含 agent.materialize.mjs（拷贝模板 templates/agent-package 的默认实现即可）",
    );
  }
  runBuildStage(
    "agent.materialize.mjs",
    process.execPath,
    [script],
    assetRoot,
    env,
  );
}

/** CLI 缺省 kind 探测：资产根含 agent-package.json = package 形态（参与构建），否则 = skill（纯文档不构建）。
 *  package/tool 对构建段等价（区别仅在清单 requires 形状，探测按 package 处理） */
function detectKind(assetRoot: string): AssetKind {
  return existsSync(path.join(assetRoot, "agent-package.json"))
    ? "package"
    : "skill";
}

/** 物化固定流程（spec §4.2）：clone → 清单形状校验 →（package/tool）npm ci → 业务初始化脚本
 *  → 产物校验 → 去 .git → 写 .materialized-ok → 原子 rename 就位。
 *  任一步失败：清理临时目录、不落 marker、抛错（子进程阶段的消息含阶段名与 stderr 尾部 30 行）。
 *  返回物化后的资产根绝对路径（= target/subpath） */
export function materializeFromGit(opts: MaterializeGitOptions): string {
  const subpath = opts.subpath ?? "";
  mkdirSync(path.dirname(opts.target), { recursive: true });
  const tmp = path.join(
    path.dirname(opts.target),
    `.tmp-${path.basename(opts.target)}-${process.pid}`,
  );
  try {
    cloneAtCommit(opts.url, opts.commit, tmp, opts.credential);
    const assetRoot = path.join(tmp, subpath);
    const kind = opts.kind ?? detectKind(assetRoot);
    // 构建前只验清单形状：programs 指向的是构建产物，存在性此时尚不成立
    const manifest: AssetManifest = validateAssetShape(assetRoot, kind);
    if (kind !== "skill") {
      // skill 资产（纯文档）不构建；package/tool 必走 npm ci（有 package.json 时）+ 初始化脚本
      buildAsset(assetRoot, opts.npmRegistry);
      // 平台不理解构建过程，只验收产物：清单 programs 每条路径必须真实存在
      assertProgramsBuilt(assetRoot, manifest);
    }
    rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    // 完成标记写在临时目录内，随 rename 一起就位（内容 = 完成时 ISO 时间戳）
    writeFileSync(path.join(tmp, ".materialized-ok"), new Date().toISOString());
    rmSync(opts.target, { recursive: true, force: true });
    renameSync(tmp, opts.target);
    return path.join(opts.target, subpath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
