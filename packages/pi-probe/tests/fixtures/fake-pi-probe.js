#!/usr/bin/env node
// fake pi：pi-probe 测试夹具（plain JS）。行为由环境变量驱动：
//  - 默认：session header + user message_end + assistant message_end（text 非空）→ 非流式成功
//  - FAKE_PI_STREAM_DELTA=1：先发 text_delta 增量，随后常驻（探针应立即取消）
//  - FAKE_PI_EMPTY_DELTA=1：只发空 delta 后退出（不算真实生成）
//  - FAKE_PI_NO_ASSISTANT=1：只有 header/session，无 assistant 消息
//  - FAKE_PI_ASSISTANT_ERROR=1：assistant stopReason=error，退出码仍为 0
//  - FAKE_PI_EXIT=N：stderr 写故障文本后非零退出
//  - FAKE_PI_SLEEP_MS=N：先挂起 N 毫秒（超时测试）
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS ?? 0);

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function main() {
  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  const exitCode = Number(process.env.FAKE_PI_EXIT ?? 0);
  if (exitCode !== 0) {
    process.stderr.write(`fake pi 故障: FAKE_PI_EXIT=${exitCode}\n`);
    process.exit(exitCode);
  }

  write({ type: "session", session_id: "fake-session" });
  write({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "ping" }] },
  });

  if (process.env.FAKE_PI_STREAM_DELTA === "1") {
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "你" },
    });
    // 常驻：探针应在收到首个 delta 后立即取消本进程
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return;
  }

  if (process.env.FAKE_PI_EMPTY_DELTA === "1") {
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "" },
    });
    process.exit(0);
  }

  if (process.env.FAKE_PI_ASSISTANT_ERROR === "1") {
    write({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "模型拒绝了请求",
        content: [],
      },
    });
    process.exit(0);
  }

  if (!process.env.FAKE_PI_NO_ASSISTANT) {
    write({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
      },
    });
  }
  process.exit(0);
}

main();
