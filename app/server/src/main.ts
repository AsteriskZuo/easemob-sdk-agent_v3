import { logger } from "@asteriskzuo/agent-logger";
import { bootstrap } from "./bootstrap.js";

/** 运行期兜底日志：logger 可用走 system error，不可用（极端时序）退到 stderr */
function logRuntimeFault(message: string, err: unknown): void {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    logger.for({ module: "system" }).error(message, { error: text });
  } catch {
    process.stderr.write(`${message}: ${text}\n`);
  }
}

async function main(): Promise<void> {
  // ① 装配并启动。失败：initLogger 之前（配置解析）只有 stderr；
  //    之后 bootstrap 内已记 system error 日志，这里补 stderr 后退出码 1
  let handle: Awaited<ReturnType<typeof bootstrap>>;
  try {
    handle = await bootstrap();
  } catch (err) {
    process.stderr.write(
      `平台启动失败: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // ② 信号优雅停：SIGINT/SIGTERM → await handle.stop() → exit(0)
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    handle.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logRuntimeFault(`优雅停机失败（${signal}）`, err);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ③ 未捕获兜底：记 system error 日志，不退出（运行期不崩溃，兜底保住主循环）
  process.on("uncaughtException", (err) => {
    logRuntimeFault("未捕获异常", err);
  });
  process.on("unhandledRejection", (reason) => {
    logRuntimeFault("未处理 Promise 拒绝", reason);
  });
}

void main();
