import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  accessSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 启动自检（fail-fast）：任一前提不满足抛出 Error，message 列出全部失败项。
 *  检查项全量收集后一次性报出，不遇一错即停：
 *  ① {workspace} 可建可写；② 数据分类子目录骨架（platform/{data,cache,logs} + businesses/）可建；
 *  ③ pi_cli_path 存在且可执行；④ handbook 生成目录存在且可读；⑤ git 可用；
 *  ⑥ npm 可用；⑦ npm registry 可达（HEAD，3s 超时）。
 *  （node 不单列：workflow-runner 用 process.execPath spawn 业务程序，server 能启动即 node 恒在；
 *   数据库可打开/迁移由各工厂创建时自然 fail-fast；大模型配置归业务自查，平台启动不检查） */
export async function runSelfCheck(config: ServerConfig): Promise<void> {
  const failures: string[] = [];

  // ① {workspace} 可建可写（探测文件写删）
  try {
    mkdirSync(config.workspace, { recursive: true });
    const probe = join(config.workspace, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
  } catch (err) {
    failures.push(
      `workspace 不可建/不可写: ${config.workspace}: ${errorMessage(err)}`,
    );
  }

  // ② 数据分类子目录骨架（平台三类 + 业务根；业务内的 runs/data/cache/logs 由 runner/lifecycle 按需建）
  for (const dir of [
    join("platform", "data"),
    join("platform", "cache"),
    join("platform", "logs"),
    "businesses",
  ]) {
    try {
      mkdirSync(join(config.workspace, dir), { recursive: true });
    } catch (err) {
      failures.push(
        `子目录不可建: ${join(config.workspace, dir)}: ${errorMessage(err)}`,
      );
    }
  }

  // ③ pi_cli_path 存在且可执行（缺省值来自 npm 依赖 @earendil-works/pi-coding-agent 的解析）
  try {
    accessSync(config.pi_cli_path, constants.X_OK);
  } catch (err) {
    failures.push(
      `pi_cli_path 不存在或不可执行: ${config.pi_cli_path}（缺省应随 npm 依赖安装；显式路径检查 AGENT_PI_CLI_PATH）: ${errorMessage(err)}`,
    );
  }

  // ④ handbook 控制台生成物目录必须存在且可读（console-api 运行时逐请求读取 JSON）
  try {
    if (!statSync(config.handbook_dir).isDirectory()) {
      throw new Error("路径不是目录");
    }
    accessSync(config.handbook_dir, constants.R_OK);
  } catch (err) {
    failures.push(
      `handbook_dir 不存在、不是目录或不可读: ${config.handbook_dir}（检查 AGENT_HANDBOOK_DIR）: ${errorMessage(err)}`,
    );
  }

  // ⑤ git 可用（asset-registry 物化资产经 git 子进程，缺失则一切资产拉取必败）
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch (err) {
    failures.push(`git 不可用: ${errorMessage(err)}`);
  }

  // ⑥ npm 可用（物化构建跑 npm ci，缺失则 package/tool 资产物化必败）
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
  } catch (err) {
    failures.push(`npm 不可用: ${errorMessage(err)}`);
  }

  // ⑦ npm registry 可达（HEAD，3s 超时；物化 npm ci 依赖它解析依赖。
  //  有任何 HTTP 响应即视为可达——只排网络层失败/超时，不替 registry 判状态码）
  try {
    await fetch(config.npm_registry, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    failures.push(
      `npm registry 不可达: ${config.npm_registry}: ${errorMessage(err)}（物化 npm ci 依赖它；离线部署请用 AGENT_NPM_REGISTRY 指向内网镜像）`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`启动自检失败:\n- ${failures.join("\n- ")}`);
  }
}
