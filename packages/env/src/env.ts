/** 环境变量读取错误：变量名 + 原因都在 message 里（fail-fast 时可直接进日志） */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export interface StringOptions {
  default?: string; // 未设置时返回它；与 required 同时给时 default 优先
  required?: boolean; // true 且未设置 → 抛 EnvError
}

export interface NumberOptions {
  default?: number; // 同 StringOptions.default
  required?: boolean; // 同 StringOptions.required
  min?: number; // 下界（含）；越界 → EnvError
  max?: number; // 上界（含）；越界 → EnvError
}

export interface BooleanOptions {
  default?: boolean; // 同 StringOptions.default
  required?: boolean; // 同 StringOptions.required
}

/** 统一判定：undefined 或 ''（trim 后）= 未设置 */
function readRaw(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

/** 统一错误格式：环境变量 <NAME> <原因>（fail-fast 时可直接进日志） */
function missing(name: string): EnvError {
  return new EnvError(`环境变量 ${name} 未设置`);
}

/** 读取字符串。空串视为未设置；required 而未设置 → EnvError。
 *  重载语义：options 带 required: true 或 default → 返回必有值；都不给 → string | undefined（编译期可区分） */
export function getString(
  name: string,
  options: StringOptions & { required: true },
): string;
export function getString(
  name: string,
  options: StringOptions & { default: string },
): string;
export function getString(
  name: string,
  options?: StringOptions,
): string | undefined;
export function getString(
  name: string,
  options: StringOptions = {},
): string | undefined {
  const raw = readRaw(name);
  if (raw !== undefined) return raw;
  if (options.default !== undefined) return options.default;
  if (options.required) throw missing(name);
  return undefined;
}

/** 读取数字。非法数字（NaN）/ 越界 → EnvError；其余同 getString（含重载语义） */
export function getNumber(
  name: string,
  options: NumberOptions & { required: true },
): number;
export function getNumber(
  name: string,
  options: NumberOptions & { default: number },
): number;
export function getNumber(
  name: string,
  options?: NumberOptions,
): number | undefined;
export function getNumber(
  name: string,
  options: NumberOptions = {},
): number | undefined {
  const raw = readRaw(name);
  if (raw === undefined) {
    if (options.default !== undefined) return options.default;
    if (options.required) throw missing(name);
    return undefined;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    // Number('12abc') = NaN：正好挡住带尾巴的非法数字
    throw new EnvError(`环境变量 ${name} 非法数字: "${raw}"`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new EnvError(
      `环境变量 ${name} 越界: ${value} 小于 min ${options.min}`,
    );
  }
  if (options.max !== undefined && value > options.max) {
    throw new EnvError(
      `环境变量 ${name} 越界: ${value} 大于 max ${options.max}`,
    );
  }
  return value;
}

/** 读取布尔：'true'/'1' → true，'false'/'0' → false（大小写不敏感）；其他值 → EnvError。重载语义同 getString */
export function getBoolean(
  name: string,
  options: BooleanOptions & { required: true },
): boolean;
export function getBoolean(
  name: string,
  options: BooleanOptions & { default: boolean },
): boolean;
export function getBoolean(
  name: string,
  options?: BooleanOptions,
): boolean | undefined;
export function getBoolean(
  name: string,
  options: BooleanOptions = {},
): boolean | undefined {
  const raw = readRaw(name);
  if (raw === undefined) {
    if (options.default !== undefined) return options.default;
    if (options.required) throw missing(name);
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new EnvError(`环境变量 ${name} 非法布尔: "${raw}"`);
}
