import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** contract.json 的字段声明 */
export interface ContractField {
  path: string; // 点分路径（input 从事件信封根解析，实际多为 payload.*；output 从 sdk.return 产出根解析）
  type: string; // 类型词：string / number / boolean / object / array / T[]（T 为类型词，逐个元素递归校验）
  required?: boolean; // 缺省 false。校验器只查 required: true 项（存在 + 类型）；可选项不查，仅供展示与人工理解
  desc?: string; // 展示用说明（控制台字段表）
}

/** contract.json 顶层可选 metrics 节的字段声明（值只允许 string|number，与平台保留键规则一致） */
export interface ContractMetricField {
  key: string; // 指标键，须匹配 [a-z][a-z0-9_]*
  type: "string" | "number";
  required?: boolean; // 缺省 false；true = main 产出 metrics 必须含此键
  desc?: string; // 展示用说明
}

/** contract.json 的形状：顶层 version 恒 1；input/output 必须显式给出（null = 无约束/无产出，不允许缺失——缺失分不清"忘了"和"没有"）；
 *  metrics 为可选节：缺省或 null = 无声明（存量业务包无此节，不能像 input/output 一样要求显式） */
export interface ContractDoc {
  version: 1;
  input: { fields: ContractField[] } | null;
  output: { fields: ContractField[] } | null;
  metrics?: { fields: ContractMetricField[] } | null;
}

const TYPE_WORDS = new Set(["string", "number", "boolean", "object", "array"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 类型词合法性（声明侧）：五个基词或 `<词>[]`（可叠层，如 string[][]） */
function isValidTypeWord(type: unknown): boolean {
  if (typeof type !== "string" || type === "") return false;
  if (type.endsWith("[]")) return isValidTypeWord(type.slice(0, -2));
  return TYPE_WORDS.has(type);
}

/** 类型匹配（数据侧）：T[] 逐个元素递归校验；object = 纯对象（非数组非 null） */
function matchType(type: string, value: unknown): boolean {
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) return false;
    const element = type.slice(0, -2);
    return value.every((item) => matchType(element, item));
  }
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return false;
  }
}

/** 值的类型速写（报错消息用） */
function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** 点分路径解析：任一段不存在 → undefined（调用方按"缺失"处理） */
function resolvePath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 校验 contract 一侧（input/output）的声明形状；返回问题列表（空 = 合法） */
function lintSide(side: unknown, name: "input" | "output"): string[] {
  if (side === null) return [];
  if (!isPlainObject(side) || !Array.isArray(side.fields)) {
    return [`${name} 必须是 null 或 { fields: [...] }`];
  }
  const problems: string[] = [];
  for (const [index, field] of (side.fields as unknown[]).entries()) {
    const at = `${name}.fields[${index}]`;
    if (!isPlainObject(field)) {
      problems.push(`${at} 必须是对象`);
      continue;
    }
    if (typeof field.path !== "string" || field.path === "") {
      problems.push(`${at}.path 必须是非空字符串`);
    }
    if (!isValidTypeWord(field.type)) {
      problems.push(
        `${at}.type 非法：${JSON.stringify(field.type)}（词表：string/number/boolean/object/array/T[]）`,
      );
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      problems.push(`${at}.required 必须是布尔值`);
    }
    if (field.desc !== undefined && typeof field.desc !== "string") {
      problems.push(`${at}.desc 必须是字符串`);
    }
  }
  return problems;
}

const METRIC_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const METRIC_TYPE_WORDS = new Set(["string", "number"]);

/** 校验 contract 可选 metrics 节的声明形状；返回问题列表（空 = 合法）。缺省/null 由调用方挡掉（= 无声明） */
function lintMetricsSide(side: unknown): string[] {
  if (!isPlainObject(side) || !Array.isArray(side.fields)) {
    return ["metrics 必须是 null 或 { fields: [...] }"];
  }
  const problems: string[] = [];
  for (const [index, field] of (side.fields as unknown[]).entries()) {
    const at = `metrics.fields[${index}]`;
    if (!isPlainObject(field)) {
      problems.push(`${at} 必须是对象`);
      continue;
    }
    if (typeof field.key !== "string" || !METRIC_KEY_PATTERN.test(field.key)) {
      problems.push(
        `${at}.key 非法：${JSON.stringify(field.key)}（须匹配 [a-z][a-z0-9_]*）`,
      );
    }
    if (
      typeof field.type !== "string" ||
      !METRIC_TYPE_WORDS.has(field.type)
    ) {
      problems.push(
        `${at}.type 非法：${JSON.stringify(field.type)}（词表：string/number）`,
      );
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      problems.push(`${at}.required 必须是布尔值`);
    }
    if (field.desc !== undefined && typeof field.desc !== "string") {
      problems.push(`${at}.desc 必须是字符串`);
    }
  }
  return problems;
}

/** 读 contract.json 并做形状校验。坏契约 = 抛错（check 程序 crash → run 失败，与平台 fail-closed 一致）。
 *  fileUrl 用 `new URL("../../../contract.json", import.meta.url)` 从 check 程序产物定位包根 */
export function loadContract(fileUrl: URL): ContractDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fileURLToPath(fileUrl), "utf8"));
  } catch (err) {
    throw new Error(
      `contract.json 读取/解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const problems: string[] = [];
  if (!isPlainObject(parsed)) {
    problems.push("顶层必须是 JSON 对象");
  } else {
    if (parsed.version !== 1) {
      problems.push("version 缺失或不是 1（未知版本平台无法解释）");
    }
    if (!("input" in parsed)) {
      problems.push("缺少 input 节（无输入约束也要显式写 null）");
    } else {
      problems.push(...lintSide(parsed.input, "input"));
    }
    if (!("output" in parsed)) {
      problems.push("缺少 output 节（无产出也要显式写 null）");
    } else {
      problems.push(...lintSide(parsed.output, "output"));
    }
    if ("metrics" in parsed && parsed.metrics !== null) {
      problems.push(...lintMetricsSide(parsed.metrics));
    }
  }
  if (problems.length > 0) {
    throw new Error(`contract.json 非法：\n- ${problems.join("\n- ")}`);
  }
  return parsed as ContractDoc;
}

/** 校验数据是否满足字段声明：只查 required: true 项（存在 + 类型），可选项不查。
 *  返回问题列表（空数组 = 通过），调用方（check 程序）一般 `sdk.fail(problems.join("；"))` */
export function checkFields(fields: ContractField[], data: unknown): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    if (field.required !== true) continue;
    const value = resolvePath(data, field.path);
    if (value === undefined) {
      problems.push(`缺少必填字段：${field.path}`);
      continue;
    }
    if (!matchType(field.type, value)) {
      problems.push(
        `字段类型不符：${field.path} 期望 ${field.type}，实际 ${typeNameOf(value)}`,
      );
    }
  }
  return problems;
}

/** metrics 值的类型匹配（数据侧）：string → typeof "string"；number → typeof "number" 且 Number.isFinite */
function matchMetricType(type: "string" | "number", value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  return typeof value === "number" && Number.isFinite(value);
}

/** 校验 main 产出的 metrics 是否满足声明（独立函数，与 checkFields 语义不同：扁平 kv 键名/类型校验）：
 *  - 声明了 required: true 的键：必须存在且类型匹配；
 *  - 声明的可选键：存在时类型必须匹配；
 *  - 未声明的键：不查（runner 侧防御式形状检查已兜底合法性）；
 *  - metrics 为 undefined/null 时：等价于 {}（required 键全部报缺失）。
 *  返回问题列表（空数组 = 通过），调用方（check 程序）一般 `sdk.fail(problems.join("；"))` */
export function checkMetrics(
  fields: ContractMetricField[],
  metrics: Record<string, unknown> | undefined | null,
): string[] {
  const problems: string[] = [];
  const data: Record<string, unknown> = metrics ?? {};
  for (const field of fields) {
    const value = data[field.key];
    if (value === undefined) {
      if (field.required === true) {
        problems.push(`缺少必填指标：${field.key}`);
      }
      continue;
    }
    if (!matchMetricType(field.type, value)) {
      problems.push(
        `指标类型不符：${field.key} 期望 ${field.type}，实际 ${typeNameOf(value)}`,
      );
    }
  }
  return problems;
}
