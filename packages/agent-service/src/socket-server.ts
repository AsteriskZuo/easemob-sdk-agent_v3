import { rmSync } from "node:fs";
import net from "node:net";

/** socket 响应（spec §5.3，与 T10 spec §5.4 锚定同形）：服务端回完即关连接 */
export type ServiceResponse =
  | { contract_version: "v1"; ok: true; output: unknown }
  | { contract_version: "v1"; ok: false; error: string };

/** socket 服务端配置 */
export interface SocketServerOptions {
  /** unix socket 监听路径（os.tmpdir() 下，close 时删除） */
  socketPath: string;
  /** 是否已关闭：关闭后新到的请求立即回 service_closed（不进串行链） */
  isClosed(): boolean;
  /** 请求处理器：入参为已解析的 JSON（解析失败本层直接回 invalid_request）；
   *  实现必须自行兜住异常，本层仍再兜底一次保证每个请求都有响应 */
  onRequest(raw: unknown): Promise<ServiceResponse>;
}

/** socket 服务端运行句柄 */
export interface RunningSocketServer {
  /** 停止接受新连接；已受理请求按串行链回完；销毁残余连接；删除 socket 文件 */
  drainAndClose(): Promise<void>;
}

const SERVICE_CLOSED: ServiceResponse = {
  contract_version: "v1",
  ok: false,
  error: "service_closed",
};

const INVALID_REQUEST: ServiceResponse = {
  contract_version: "v1",
  ok: false,
  error: "invalid_request",
};

const INTERNAL_ERROR: ServiceResponse = {
  contract_version: "v1",
  ok: false,
  error: "agent_failed: 服务内部错误",
};

/** 写一行 JSON 响应并结束连接（协议：服务端回完即关）；连接已断则静默销毁 */
function respond(conn: net.Socket, resp: ServiceResponse): void {
  try {
    conn.write(JSON.stringify(resp) + "\n", () => conn.end());
  } catch {
    conn.destroy();
  }
}

/** unix socket 服务端：一行一条 JSON 请求，一次调用一条连接；
 *  同一 endpoint 的请求经 promise 链串行处理（防并发写同一 pi 会话文件）。
 *  listen 就绪后 resolve。 */
export function createSocketServer(
  opts: SocketServerOptions,
): Promise<RunningSocketServer> {
  return new Promise((resolveListen, rejectListen) => {
    rmSync(opts.socketPath, { force: true }); // 清掉上次 run 可能残留的 socket 文件
    const conns = new Set<net.Socket>(); // 全部活连接
    const pending = new Set<net.Socket>(); // 已收请求、等响应的连接
    let chain: Promise<void> = Promise.resolve(); // 请求串行链

    const server = net.createServer((conn) => {
      conns.add(conn);
      conn.on("close", () => {
        conns.delete(conn);
        pending.delete(conn);
      });
      conn.on("error", () => {
        // 客户端中途断开：响应写不进由 respond 兜底销毁
      });

      let buffer = "";
      let handled = false; // 一次连接只处理一行请求
      conn.on("data", (chunk) => {
        if (handled) return;
        buffer += chunk.toString("utf8");
        const idx = buffer.indexOf("\n");
        if (idx < 0) return;
        handled = true;
        pending.add(conn);
        const line = buffer.slice(0, idx);
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          respond(conn, INVALID_REQUEST);
          return;
        }
        if (opts.isClosed()) {
          respond(conn, SERVICE_CLOSED);
          return;
        }
        chain = chain.then(async () => {
          if (opts.isClosed()) {
            respond(conn, SERVICE_CLOSED);
            return;
          }
          let resp: ServiceResponse;
          try {
            resp = await opts.onRequest(raw);
          } catch {
            resp = INTERNAL_ERROR; // 兜底：任何处理器异常都不能让连接无响应
          }
          respond(conn, resp);
        });
      });
    });

    server.on("error", rejectListen);
    server.listen(opts.socketPath, () => {
      resolveListen({
        async drainAndClose(): Promise<void> {
          // 先停新连接；server 的 close 事件在全部连接销毁后触发
          const closedEvent = new Promise<void>((res) => {
            server.close(() => res());
          });
          // 空闲连接（未发请求）直接销毁；已收请求的留给串行链回完
          for (const conn of conns) {
            if (!pending.has(conn)) conn.destroy();
          }
          // 关闭后不再有新任务入链（data 处理器直接回 service_closed），await 即排空
          await chain;
          for (const conn of conns) conn.destroy(); // 兜底清理残余
          rmSync(opts.socketPath, { force: true });
          await closedEvent;
        },
      });
    });
  });
}
