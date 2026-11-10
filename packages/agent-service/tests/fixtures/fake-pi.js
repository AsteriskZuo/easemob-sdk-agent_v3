#!/usr/bin/env node
// fake pi：agent-service 测试夹具（plain JS，可执行）。
// 行为：
//  - 启动即把 {ts, pid, argv, cwd, env:{PI_CODING_AGENT_DIR, AUDIT_LOG_PATH}} 追加写进
//    FAKE_PI_CAPTURE 指向的文件（一行 JSON）；
//  - FAKE_PI_SLEEP_MS：挂起指定毫秒后再干活（测 close 强杀 / 请求串行化）；
//  - FAKE_PI_EXIT：非零退出（先向 stderr 写故障文本）；
//  - --mode json：输出 session header + 两条 message_end，最后一条 assistant 文本来自
//    FAKE_PI_REPLY（缺省 "fake 回复"）；FAKE_PI_NO_ASSISTANT 置位时不回 assistant 消息；
//    assistant 消息 usage 缺省为非 pi 旧形状（{input_tokens,output_tokens}，触发"usage 缺失"路径），
//    FAKE_PI_USAGE 置位时取其 JSON.parse 结果（可注入真实 pi Usage 形状）；
//  - --mode rpc：读 stdin 行，{type:'compact'} → 回 {id 原样, type:'response',
//    command:'compact', success:true, data:{}}，随后保持存活直到 stdin 关闭或被 kill。
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const capturePath = process.env.FAKE_PI_CAPTURE;
if (capturePath) {
  appendFileSync(
    capturePath,
    JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      argv: args,
      cwd: process.cwd(),
      env: {
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
        AUDIT_LOG_PATH: process.env.AUDIT_LOG_PATH ?? null,
      },
    }) + "\n",
  );
}

const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS ?? 0);

async function main() {
  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  const exitCode = Number(process.env.FAKE_PI_EXIT ?? 0);
  if (exitCode !== 0) {
    process.stderr.write(`fake pi 故障: FAKE_PI_EXIT=${exitCode}\n`);
    process.exit(exitCode);
  }

  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : undefined;

  if (mode === "json") {
    const reply = process.env.FAKE_PI_REPLY ?? "fake 回复";
    process.stdout.write(
      JSON.stringify({ type: "session", session_id: "fake-session" }) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "输入" }] },
      }) + "\n",
    );
    if (!process.env.FAKE_PI_NO_ASSISTANT) {
      const usage = process.env.FAKE_PI_USAGE
        ? JSON.parse(process.env.FAKE_PI_USAGE)
        : { input_tokens: 1, output_tokens: 2 };
      process.stdout.write(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: reply }],
            usage,
          },
        }) + "\n",
      );
    }
    process.exit(0);
  }

  if (mode === "rpc") {
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "compact") {
          process.stdout.write(
            JSON.stringify({
              id: msg.id,
              type: "response",
              command: "compact",
              success: true,
              data: {},
            }) + "\n",
          );
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
    return; // 保持存活：stdin 长开
  }

  process.exit(0);
}

main();
