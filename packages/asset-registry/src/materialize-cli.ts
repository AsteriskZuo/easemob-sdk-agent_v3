import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFromGit } from "./materialize.js";

/** 平台物化脚本的独立 CLI 入口（spec §4.1）：与 AssetRegistry.materialize 共用 materializeFromGit。
 *  用途：绑定/物化失败时管理员脱离平台手动复现完整输出，不用翻日志猜。
 *
 *  用法：
 *    node packages/asset-registry/dist/materialize-cli.js \
 *      --url <git url> --commit <40 位 commit> [--subpath <仓库内子路径>] --target <就位目录>
 *
 *  环境变量：
 *    AGENT_ASSET_CREDENTIAL  私有仓库凭据（仅 https url 注入本次 clone；不落盘不入日志）
 *    AGENT_NPM_REGISTRY      npm registry 地址（可选；映射为 NPM_CONFIG_REGISTRY 传给 npm ci 与初始化脚本）
 *
 *  行为：成功把资产根绝对路径打到 stdout，exit 0；任一步失败把错误（含阶段名与 stderr 尾部）写 stderr，exit 1 */

const USAGE =
  "用法: node materialize-cli.js --url <url> --commit <commit> [--subpath <p>] --target <dir>";

/** 解析 argv 为选项表：--key value 成对；缺 key/值或多余参数 → 抛带 USAGE 的错 */
function parseArgs(argv: string[]): {
  url: string;
  commit: string;
  subpath?: string;
  target: string;
} {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(`参数非法: ${argv.slice(i).join(" ")}\n${USAGE}`);
    }
    out[key.slice(2)] = value;
  }
  const { url, commit, subpath, target } = out;
  if (url === undefined || commit === undefined || target === undefined) {
    throw new Error(`缺必填参数（--url/--commit/--target）\n${USAGE}`);
  }
  return {
    url,
    commit,
    ...(subpath !== undefined ? { subpath } : {}),
    target: path.resolve(target),
  };
}

/** CLI 主流程（导出仅为可测；正常入口是文件末尾的 main 守卫） */
export function runMaterializeCli(argv: string[]): string {
  const args = parseArgs(argv);
  return materializeFromGit({
    url: args.url,
    commit: args.commit,
    ...(args.subpath !== undefined ? { subpath: args.subpath } : {}),
    target: args.target,
    credential: process.env.AGENT_ASSET_CREDENTIAL,
    npmRegistry: process.env.AGENT_NPM_REGISTRY,
  });
}

// main 守卫：仅作为独立进程入口时执行（被 import 时不跑）
const invokedAs =
  process.argv[1] !== undefined ? path.resolve(process.argv[1]) : "";
if (invokedAs !== "" && fileURLToPath(import.meta.url) === invokedAs) {
  try {
    const root = runMaterializeCli(process.argv.slice(2));
    process.stdout.write(`${root}\n`);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
