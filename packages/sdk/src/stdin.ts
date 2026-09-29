import { readFileSync } from "node:fs";

/** 平台 → 业务流程程序（或 sdk.run → 子程序）的 stdin 信封，两端契约递归同构。
 *  SDK 运行时零依赖，不 import @easemob/agent-contracts，此处为结构化本地类型 */
export interface StdinEnvelope {
  contract_version: "v1"; // 契约版本，恒为 "v1"
  input: unknown; // 平台→流程：入口事件信封（EventEnvelope 形状）；sdk.run→子程序：args.input 原样
  workspace?: string; // run 工作目录（平台→流程必填；sdk.run 继承父级）
  config?: Record<string, string>; // 业务非机密配置（控制台登记）
  secrets?: Record<string, string>; // 业务安全变量（仅平台→流程；sdk.run 不传）
  endpoint?: { socket_path: string; token: string }; // agent 服务端点（仅平台→流程）
}

// 一次性读取缓存：所有读口共享同一份信封；读失败也缓存（重复读抛同一个错）
let cached: StdinEnvelope | null = null;
let cachedError: Error | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isStdinEnvelope(value: unknown): value is StdinEnvelope {
  return (
    isPlainObject(value) && value.contract_version === "v1" && "input" in value
  );
}

/** 同步一次性读 stdin（runner 写完即关，EOF 立达），解析缓存。
 *  无注入输入（TTY / 空数据）或信封非法 → 抛带原因的错 */
export function readStdinEnvelope(): StdinEnvelope {
  if (cached) return cached;
  if (cachedError) throw cachedError;
  try {
    if (process.stdin.isTTY) {
      throw new Error(
        "无注入输入：stdin 是 TTY。本地调试请用管道喂 mock JSON，如 echo '{...}' | node program.js",
      );
    }
    const raw = readFileSync(0, "utf8").trim();
    if (raw.length === 0) {
      throw new Error("无注入输入：stdin 为空（平台应注入一段 JSON 信封）");
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isStdinEnvelope(parsed)) {
      throw new Error(
        "stdin 信封非法：必须是 contract_version='v1' 且含 input 字段的 JSON 对象",
      );
    }
    cached = parsed;
    return cached;
  } catch (err) {
    cachedError = err instanceof Error ? err : new Error(String(err));
    throw cachedError;
  }
}
