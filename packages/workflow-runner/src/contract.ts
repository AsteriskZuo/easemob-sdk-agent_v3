/** 平台 → 业务流程程序（或 sdk.run → 子程序）的 stdin 信封，两端契约递归同构。
 *  写完即关（EOF 即输入结束信号），SDK 侧同步一次性读取 */
export interface StdinEnvelope {
  contract_version: "v1"; // 契约版本，恒为 "v1"
  input: unknown; // 平台→流程：入口事件信封（EventEnvelope 形状）；sdk.run→子程序：args.input 原样
  workspace?: string; // run 工作目录（平台→流程必填；sdk.run 继承父级）
  config?: Record<string, string>; // 业务非机密配置（控制台登记）
  secrets?: Record<string, string>; // 业务安全变量（仅平台→流程；sdk.run 不传）
  endpoint?: { socket_path: string; token: string }; // agent 服务端点（仅平台→流程）
  programs?: Record<string, string>; // 程序名→物化绝对路径映射（本包 programs ∪ 绑定工具 programs）；仅平台→流程程序注入，sdk.run 不向子程序传
  dataDir?: string; // 业务级持久目录绝对路径（{workspace}/data/{source}/{session_id}/{business_id}/，run 启动时已建）；仅平台→流程程序注入，sdk.run 不向子程序传（叶子无状态语义，子程序确需持久由流程程序自己把路径经 input 传入）
}

/** 业务流程程序的 stdout 唯一结果：只认第一个合法结果对象，其后内容忽略（仍计入大小上限） */
export type StdoutResult =
  | { contract_version: "v1"; ok: true; output: unknown }
  | { contract_version: "v1"; ok: false; reason: string };

/** 信封编码：一段 JSON（runner 写完即 end，无需换行分隔） */
export function encodeStdinEnvelope(envelope: StdinEnvelope): string {
  return JSON.stringify(envelope);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 逐行扫描 stdout：本行是合法 StdoutResult → 返回之（调用方只采信第一个）；否则 null */
export function parseStdoutResult(line: string): StdoutResult | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.contract_version !== "v1") return null;
  if (parsed.ok === true && "output" in parsed) {
    return { contract_version: "v1", ok: true, output: parsed.output };
  }
  if (parsed.ok === false && typeof parsed.reason === "string") {
    return { contract_version: "v1", ok: false, reason: parsed.reason };
  }
  return null;
}

/** stderr 业务日志行分类结果 */
export type StderrLine =
  | {
      kind: "structured"; // SDK 写出的结构化行：单行 JSON 且含 __biz_log 标记
      level: "error" | "warn" | "info" | "debug"; // 非法级别降级为 info
      message: string;
      fields?: Record<string, unknown>;
    }
  | { kind: "raw"; text: string }; // 非结构化行（异常堆栈、库杂讯），原样透传

const LOG_LEVELS = new Set(["error", "warn", "info", "debug"]);

/** stderr 行分类：以 { 开头且 JSON.parse 成功且含 __biz_log → 结构化；其余 → 原样透传 */
export function classifyStderrLine(line: string): StderrLine {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainObject(parsed) && parsed.__biz_log === 1) {
        const level =
          typeof parsed.level === "string" && LOG_LEVELS.has(parsed.level)
            ? (parsed.level as "error" | "warn" | "info" | "debug")
            : "info";
        const message =
          typeof parsed.message === "string"
            ? parsed.message
            : JSON.stringify(parsed.message);
        const fields = isPlainObject(parsed.fields) ? parsed.fields : undefined;
        return { kind: "structured", level, message, fields };
      }
    } catch {
      // 非 JSON：落到原样透传
    }
  }
  return { kind: "raw", text: line };
}
