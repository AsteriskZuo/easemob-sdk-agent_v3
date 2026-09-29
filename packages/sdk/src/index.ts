import { readStdinEnvelope } from "./stdin.js";
import type { StdinEnvelope } from "./stdin.js";
import { writeBizLog } from "./log.js";
import { exitWith } from "./result.js";
import { callService } from "./socket.js";
import type { ServiceEndpoint } from "./socket.js";
import { runSubprogram } from "./run.js";

/** input() 的返回：入口信封 + 平台注入的运行上下文 */
export interface RunInput {
  event: unknown; // 触发信封（EventEnvelope 形状；SDK 不 import contracts，结构化 typing）
  workspace: string; // 本 run 的隔离工作目录（spawn 时的 cwd）
}

/** agent() 的调用参数 */
export interface AgentCall {
  skill: string; // 必须在本业务 skill 组内（服务端白名单校验）
  input: unknown; // 给大模型的内容（业务保证已脱敏）
  mode?: "channel" | "fresh"; // 缺省 'channel'：沿用/恢复当前通道会话；'fresh'：独立会话不写映射
}

function requireEndpoint(env: StdinEnvelope): ServiceEndpoint {
  if (!env.endpoint) {
    throw new Error(
      "未注入 agent 服务端点（endpoint）：当前环境不可调用 agent/session",
    );
  }
  return env.endpoint;
}

/** 业务侧唯一编程面。一个业务进程 = 一次 run，单例形态是刻意的（无状态共享问题） */
export const sdk = {
  /** 读入口：stdin 信封的 input 作为 event + workspace。平台注入场景外（本地调试）可读 mock */
  input(): RunInput {
    const env = readStdinEnvelope();
    if (typeof env.workspace !== "string" || env.workspace.length === 0) {
      throw new Error("stdin 信封缺少 workspace（平台注入必填）");
    }
    return { event: env.input, workspace: env.workspace };
  },

  /** 子程序侧读口：sdk.run 注入的 input 与 config（契约递归同构） */
  runInput(): { input: unknown; config: Record<string, string> } {
    const env = readStdinEnvelope();
    return { input: env.input, config: env.config ?? {} };
  },

  /** 读本业务的控制台登记配置（非机密）；无配置返回空对象 */
  config(): Record<string, string> {
    return readStdinEnvelope().config ?? {};
  },

  /** 读本业务安全变量（平台注入）；未注入该名 → 抛错 */
  secret(name: string): string {
    const value = readStdinEnvelope().secrets?.[name];
    if (value === undefined) {
      throw new Error(`安全变量未注入：${name}`);
    }
    return value;
  },

  /** 调大模型服务（unix socket 到 AgentService；配额在服务端强制）。失败抛错 */
  agent(call: AgentCall): Promise<unknown> {
    const endpoint = requireEndpoint(readStdinEnvelope());
    return callService(endpoint, {
      contract_version: "v1",
      token: endpoint.token,
      op: "agent",
      skill: call.skill,
      input: call.input,
      mode: call.mode ?? "channel",
    });
  },

  /** 当前通道的 agent 会话操作（多轮业务的 /compact、/clear 类命令用；识别命令归业务） */
  session: {
    /** 压缩当前通道会话上下文 */
    async compact(): Promise<void> {
      const endpoint = requireEndpoint(readStdinEnvelope());
      await callService(endpoint, {
        contract_version: "v1",
        token: endpoint.token,
        op: "compact",
      });
    },
    /** 清空映射，之后 agent 调用用全新会话 */
    async clear(): Promise<void> {
      const endpoint = requireEndpoint(readStdinEnvelope());
      await callService(endpoint, {
        contract_version: "v1",
        token: endpoint.token,
        op: "clear",
      });
    },
  },

  /** 调子程序：spawn 独立程序，同一子进程契约。对端 ok=false / 异常退出 / 超时 → 抛错 */
  run(
    program: string,
    args: {
      input: unknown;
      config?: Record<string, string>;
      timeout_ms?: number; // 缺省 300_000
    },
  ): Promise<unknown> {
    return runSubprogram(program, args, sdk.input().workspace);
  },

  /** 写业务日志：结构化行写 stderr，平台采集进该 run 的业务日志。永不抛错 */
  log(
    level: "error" | "warn" | "info" | "debug",
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    writeBizLog(level, message, fields);
  },

  /** 唯一出口：成功返回结果。写 stdout 结果后进程 exit(0)。只生效一次（重复调 = 抛错后 exit 1） */
  return(result: unknown): never {
    return exitWith({ contract_version: "v1", ok: true, output: result }, 0);
  },

  /** 唯一出口：失败。写 stdout 结果后进程 exit(1) */
  fail(reason: string): never {
    return exitWith({ contract_version: "v1", ok: false, reason }, 1);
  },
};
