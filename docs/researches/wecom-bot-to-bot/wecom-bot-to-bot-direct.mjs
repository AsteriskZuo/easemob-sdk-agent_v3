/**
 * 补充实验：AI 机器人能否直接给「另一个机器人」发消息？
 *
 * sendMessage(chatid, body) 的 chatid 官方语义是「会话 id」（群聊 chatid 或单聊用户 userid）。
 * 本实验把对方机器人的 aibotid 当作 chatid 传入，验证是否可行。
 *
 * 用法：
 *   node docs/researches/wecom-bot-to-bot/wecom-bot-to-bot-direct.mjs
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import AiBot from "@wecom/aibot-node-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(resolve(__dirname, "../../../.easemob-agent/config.json"), "utf-8"),
);

const sender = {
  botId: config["WECOM__BOT_ID"],
  secret: config["WECOM__BOT_SECRET"],
};
const targetAibotId = config["WECOM__BOT_ID_02"];

const client = new AiBot.WSClient({
  botId: sender.botId,
  secret: sender.secret,
  maxReconnectAttempts: 0,
});

client.on("message", (frame) => {
  console.log("📩 发送方收到消息回调:", JSON.stringify(frame?.body ?? {}).slice(0, 200));
});
client.on("error", (err) => console.log("⚠️ 错误:", err?.message ?? err));

client.on("authenticated", async () => {
  console.log(`✅ 发送方 (${sender.botId.slice(0, 10)}...) 已认证`);
  try {
    const frame = await client.sendMessage(targetAibotId, {
      msgtype: "markdown",
      markdown: { content: `BOT2BOT-DIRECT-${Date.now().toString(36)} 机器人直发机器人测试` },
    });
    console.log("📤 sendMessage(对方 aibotid) 返回:", JSON.stringify(frame?.body ?? frame).slice(0, 300));
  } catch (err) {
    console.log("❌ sendMessage(对方 aibotid) 失败:", JSON.stringify(err).slice(0, 300));
  }
  setTimeout(() => {
    client.disconnect();
    process.exit(0);
  }, 3000);
});

client.connect();
setTimeout(() => {
  console.log("⏰ 超时退出");
  process.exit(1);
}, 30_000);
