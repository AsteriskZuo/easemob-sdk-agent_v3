import { writeSync } from "node:fs";
import { writeBizLog } from "./log.js";

/** 业务流程程序的 stdout 唯一结果（runner 只认第一个合法结果对象） */
export type StdoutResult =
  | { contract_version: "v1"; ok: true; output: unknown }
  | { contract_version: "v1"; ok: false; reason: string };

// 出口只生效一次：return/fail 任一调用后置位
let settled = false;

/** 唯一出口实现：同步写 stdout 结果行后 exit。重复调用任何出口 → 写错误日志行并 exit(1) */
export function exitWith(result: StdoutResult, code: 0 | 1): never {
  if (settled) {
    writeBizLog(
      "error",
      "sdk.return/fail 只能调用一次（重复出口），本次调用被丢弃",
    );
    process.exit(1);
    // 防御：exit 被拦截（如测试替身）时不许落穿到结果写出
    throw new Error("sdk: process.exit(1) 未生效");
  }
  settled = true;
  writeSync(1, JSON.stringify(result) + "\n");
  process.exit(code);
  // 防御：同上
  throw new Error(`sdk: process.exit(${code}) 未生效`);
}
