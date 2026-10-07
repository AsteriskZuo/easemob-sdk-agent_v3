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
import { loadModelList } from "./models.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 启动自检（fail-fast）：任一前提不满足抛出 Error，message 列出全部失败项。
 *  检查项全量收集后一次性报出，不遇一错即停：
 *  ① {workspace} 可建可写；② 数据分类子目录骨架（data/ cache/ runs/ logs/）可建；
 *  ③ pi_cli_path 存在且可执行；④ pi_agent_dir 存在且含可解析、非空的 models.json
 *  （可选模型列表的部署侧来源，loadModelList 验证）；⑤ git 可用。
 *  （node 不单列：workflow-runner 用 process.execPath spawn 业务程序，server 能启动即 node 恒在；
 *   数据库可打开/迁移由各工厂创建时自然 fail-fast） */
export function runSelfCheck(config: ServerConfig): void {
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

  // ② 数据分类子目录骨架
  for (const dir of ["data", "cache", "runs", "logs"]) {
    try {
      mkdirSync(join(config.workspace, dir), { recursive: true });
    } catch (err) {
      failures.push(
        `子目录不可建: ${join(config.workspace, dir)}: ${errorMessage(err)}`,
      );
    }
  }

  // ③ pi_cli_path 存在且可执行
  try {
    accessSync(config.pi_cli_path, constants.X_OK);
  } catch (err) {
    failures.push(
      `pi_cli_path 不存在或不可执行: ${config.pi_cli_path}: ${errorMessage(err)}`,
    );
  }

  // ④ pi_agent_dir 存在且含 models.json 文件，且可解析出非空模型列表
  try {
    if (!statSync(join(config.pi_agent_dir, "models.json")).isFile()) {
      failures.push(
        `pi_agent_dir 下 models.json 不是文件: ${config.pi_agent_dir}`,
      );
    } else {
      try {
        loadModelList(config.pi_agent_dir);
      } catch (err) {
        failures.push(`models.json 不可用: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    failures.push(
      `pi_agent_dir 不存在或缺 models.json: ${config.pi_agent_dir}: ${errorMessage(err)}`,
    );
  }

  // ⑤ git 可用（asset-registry 物化资产经 git 子进程，缺失则一切资产拉取必败）
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch (err) {
    failures.push(`git 不可用: ${errorMessage(err)}`);
  }

  if (failures.length > 0) {
    throw new Error(`启动自检失败:\n- ${failures.join("\n- ")}`);
  }
}
