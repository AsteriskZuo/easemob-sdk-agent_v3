import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EnvError, getBoolean, getNumber, getString } from "@easemob/agent-env";

/** 平台运行配置：装配根的唯一配置来源（解析后只读，不再读环境变量） */
export interface ServerConfig {
  /** 平台工作目录 {workspace}（数据五类分根的根） */
  workspace: string;
  /** 系统级日志级别 */
  log_level: "error" | "warn" | "info" | "debug";
  /** 系统级日志开关 */
  log_enabled: boolean;
  /** 派生事件 hop 上限（入口循环判循环） */
  hop_limit: number;
  /** 入口业务闸门 */
  task_concurrency: number;
  /** 出口闸门 */
  result_concurrency: number;
  /** run 超时全局默认（分钟；业务可覆盖，runtime 解析） */
  task_timeout_minutes: number;
  /** agent 调用配额全局默认（同上） */
  max_agent_calls: number;
  /** pi 可执行文件绝对路径 */
  pi_cli_path: string;
  /** PI_CODING_AGENT_DIR（models.json 所在，模型凭据由该文件承载） */
  pi_agent_dir: string;
  /** pi 子进程基础环境：{ PATH, HOME }；模型凭据一律走 pi_agent_dir/models.json */
  pi_env: Record<string, string>;
}

const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** config.json 的扁平形态：键名与环境变量同名（含 AGENT_ 前缀），值为 string/number/boolean */
type FileConfig = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 委托 env 包解析单个环境变量值：env 包的三个函数只读 process.env，
 *  这里把 envMap 中的单键值临时桥接进 process.env（调用后原样恢复），
 *  保证字符串/数字/布尔的解析规则与错误格式与 env 包完全一致。
 *  本文件是全包唯一允许接触 process.env 的地方（config.ts 例外条款） */
function parseViaEnvPackage<T>(name: string, value: string, fn: () => T): T {
  const hadOwn = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (hadOwn && previous !== undefined) {
      process.env[name] = previous;
    } else {
      delete process.env[name];
    }
  }
}

/** 读取 {workspace}/config.json：不存在 = 空；不可读/非法 JSON/非扁平 object → 记问题返回空 */
function readFileConfig(workspace: string, problems: string[]): FileConfig {
  const path = join(workspace, "config.json");
  if (!existsSync(path)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    problems.push(`config.json 不可读: ${path}: ${errorMessage(err)}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push(`config.json 非法 JSON: ${path}`);
    return {};
  }
  if (!isPlainObject(parsed)) {
    problems.push(`config.json 必须是扁平 JSON object: ${path}`);
    return {};
  }
  return parsed;
}

/** 逐键解析器：env 优先、config.json 次之、默认兜底；问题全量收集（不遇一错即停） */
class KeyResolver {
  constructor(
    /** env 来源（envMap 注入或 process.env） */
    private readonly env: Record<string, string | undefined>,
    /** config.json 内容 */
    private readonly file: FileConfig,
    /** 问题收集桶（最终合并进一个 EnvError） */
    private readonly problems: string[],
  ) {}

  /** env 来源取值：undefined 或 trim 后空串 = 未设置（与 env 包约定一致） */
  private envRaw(name: string): string | undefined {
    const raw = this.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    return raw;
  }

  /** 字符串键。oneOf 限定取值域（如 log_level 四值） */
  string(
    name: string,
    options: {
      required?: boolean;
      default?: string;
      oneOf?: readonly string[];
    } = {},
  ): string | undefined {
    const raw = this.envRaw(name);
    if (raw !== undefined) {
      try {
        const value = parseViaEnvPackage(name, raw, () =>
          getString(name, { required: true }),
        );
        if (options.oneOf && !options.oneOf.includes(value)) {
          this.problems.push(
            `环境变量 ${name} 非法取值: "${value}"（允许: ${options.oneOf.join("/")}）`,
          );
          return undefined;
        }
        return value;
      } catch (err) {
        this.problems.push(errorMessage(err));
        return undefined;
      }
    }
    const fileValue = this.file[name];
    if (fileValue !== undefined) {
      if (typeof fileValue !== "string") {
        this.problems.push(`config.json ${name} 类型不符: 期望 string`);
        return undefined;
      }
      if (options.oneOf && !options.oneOf.includes(fileValue)) {
        this.problems.push(
          `config.json ${name} 非法取值: "${fileValue}"（允许: ${options.oneOf.join("/")}）`,
        );
        return undefined;
      }
      return fileValue;
    }
    if (options.default !== undefined) return options.default;
    if (options.required) {
      this.problems.push(`环境变量 ${name} 未设置`);
    }
    return undefined;
  }

  /** 数字键。min 下界（含） */
  number(
    name: string,
    options: { required?: boolean; default?: number; min?: number } = {},
  ): number | undefined {
    const raw = this.envRaw(name);
    if (raw !== undefined) {
      try {
        return parseViaEnvPackage(name, raw, () =>
          getNumber(name, { required: true, min: options.min }),
        );
      } catch (err) {
        this.problems.push(errorMessage(err));
        return undefined;
      }
    }
    const fileValue = this.file[name];
    if (fileValue !== undefined) {
      if (typeof fileValue !== "number") {
        this.problems.push(`config.json ${name} 类型不符: 期望 number`);
        return undefined;
      }
      if (options.min !== undefined && fileValue < options.min) {
        this.problems.push(
          `config.json ${name} 越界: ${fileValue} 小于 min ${options.min}`,
        );
        return undefined;
      }
      return fileValue;
    }
    if (options.default !== undefined) return options.default;
    if (options.required) {
      this.problems.push(`环境变量 ${name} 未设置`);
    }
    return undefined;
  }

  /** 布尔键 */
  boolean(name: string, options: { default: boolean }): boolean | undefined {
    const raw = this.envRaw(name);
    if (raw !== undefined) {
      try {
        return parseViaEnvPackage(name, raw, () =>
          getBoolean(name, { required: true }),
        );
      } catch (err) {
        this.problems.push(errorMessage(err));
        return undefined;
      }
    }
    const fileValue = this.file[name];
    if (fileValue !== undefined) {
      if (typeof fileValue !== "boolean") {
        this.problems.push(`config.json ${name} 类型不符: 期望 boolean`);
        return undefined;
      }
      return fileValue;
    }
    return options.default;
  }
}

/** 解析配置。优先级：环境变量 > {workspace}/config.json 同名键 > 代码默认；
 *  AGENT_WORKSPACE 只能来自环境变量（config.json 栖身于 workspace，鸡生蛋）；
 *  pi_env 固定组 { PATH, HOME }，仅取自 envMap。
 *  envMap 可注入（测试用），缺省 process.env；
 *  缺失必填项 / 非法值 → 抛 EnvError（message 列出全部问题） */
export function resolveServerConfig(
  envMap?: Record<string, string | undefined>,
): ServerConfig {
  // config.ts 是全包唯一允许接触 process.env 的地方（env 包调用方例外条款）
  const env = envMap ?? process.env;
  const problems: string[] = [];

  // 1. AGENT_WORKSPACE 仅环境变量
  const workspaceRaw = env.AGENT_WORKSPACE;
  const workspace =
    workspaceRaw !== undefined && workspaceRaw.trim() !== ""
      ? workspaceRaw
      : undefined;
  if (workspace === undefined) {
    problems.push("环境变量 AGENT_WORKSPACE 未设置");
  }

  // 2. config.json（workspace 未解析出来时无法定位，跳过；问题已收集）
  const file =
    workspace !== undefined ? readFileConfig(workspace, problems) : {};

  // 3. 逐键解析（env > 文件 > 默认）
  const resolver = new KeyResolver(env, file, problems);
  const logLevel = resolver.string("AGENT_LOG_LEVEL", {
    default: "info",
    oneOf: LOG_LEVELS,
  });
  const logEnabled = resolver.boolean("AGENT_LOG_ENABLED", { default: true });
  const hopLimit = resolver.number("AGENT_HOP_LIMIT", { default: 8, min: 1 });
  const taskConcurrency = resolver.number("AGENT_TASK_CONCURRENCY", {
    default: 4,
    min: 1,
  });
  const resultConcurrency = resolver.number("AGENT_RESULT_CONCURRENCY", {
    default: 16,
    min: 1,
  });
  const taskTimeoutMinutes = resolver.number("AGENT_TASK_TIMEOUT_MINUTES", {
    default: 60,
    min: 1,
  });
  const maxAgentCalls = resolver.number("AGENT_MAX_AGENT_CALLS", {
    default: 20,
    min: 1,
  });
  const piCliPath = resolver.string("AGENT_PI_CLI_PATH", { required: true });
  const piAgentDir = resolver.string("AGENT_PI_AGENT_DIR", { required: true });

  // 4. pi_env 固定组 { PATH, HOME }（仅取自 envMap；模型凭据走 pi_agent_dir/models.json）
  const piEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME"] as const) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") {
      problems.push(`环境变量 ${name} 未设置（pi 子进程基础环境必需）`);
    } else {
      piEnv[name] = raw;
    }
  }

  if (problems.length > 0) {
    throw new EnvError(`配置解析失败:\n- ${problems.join("\n- ")}`);
  }

  // 全部键已验过（problems 为空即全部有值），此处断言收窄
  return {
    workspace: workspace as string,
    log_level: (logLevel ?? "info") as LogLevel,
    log_enabled: logEnabled ?? true,
    hop_limit: hopLimit as number,
    task_concurrency: taskConcurrency as number,
    result_concurrency: resultConcurrency as number,
    task_timeout_minutes: taskTimeoutMinutes as number,
    max_agent_calls: maxAgentCalls as number,
    pi_cli_path: piCliPath as string,
    pi_agent_dir: piAgentDir as string,
    pi_env: piEnv,
  };
}
