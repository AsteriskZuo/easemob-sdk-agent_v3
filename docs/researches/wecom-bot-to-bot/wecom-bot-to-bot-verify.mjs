/**
 * 企业微信机器人互发消息验证脚本
 *
 * 问题：企业微信的两个机器人之间是否可以相互发消息？
 * 即：一个机器人（AI 机器人 / 群 webhook 机器人）发到群里的消息，
 * 另一个 AI 机器人能否通过长连接收到回调？
 *
 * 实验设计：
 *   - 监听者 L1 = WECOM__BOT_ID_02、L2 = WECOM__BOT_ID__JIRA__NOTIFICATION（长连接，记录全部 message/event）
 *   - 发送者 S  = WECOM__BOT_ID（长连接 sendMessage 发 markdown 到群）
 *   - 发送者 W  = WECOM__BOT_WEBHOOK_URL（群 webhook 机器人发文本到群）
 *   - L1 自己再 sendMessage 一条（验证 L1 在群内、且验证自发消息是否回推）
 *   - 全部消息带唯一标记，最后汇总各监听者是否收到对应标记
 *
 * 注意：不要用 WECOM__BOT_ID__JIRA_REVIEW —— 它正被运行中的容器占用，
 * 同一 botId 重复建连会互相挤掉（event.disconnected_event）。
 *
 * 用法：
 *   node docs/researches/wecom-bot-to-bot/wecom-bot-to-bot-verify.mjs
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import AiBot from "@wecom/aibot-node-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(resolve(__dirname, "../../../.easemob-agent/config.json"), "utf-8"),
);

const chatId = config["WECOM__GROUP__CHAT_ID"];
const webhookUrl = config["WECOM__BOT_WEBHOOK_URL"];
if (!chatId || !webhookUrl) {
  console.error("❌ 配置缺少 WECOM__GROUP__CHAT_ID 或 WECOM__BOT_WEBHOOK_URL");
  process.exit(1);
}

const RUN_ID = Date.now().toString(36);
const MARKERS = {
  S: `BOT2BOT-${RUN_ID}-S（AI机器人 sendMessage 发出）`,
  W: `BOT2BOT-${RUN_ID}-W（群 webhook 机器人发出）`,
  L1: `BOT2BOT-${RUN_ID}-L1（监听者 L1 自己发出）`,
};

const BOTS = {
  L1: {
    botId: config["WECOM__BOT_ID_02"],
    secret: config["WECOM__BOT_SECRET_02"],
  },
  L2: {
    botId: config["WECOM__BOT_ID__JIRA__NOTIFICATION"],
    secret: config["WECOM__BOT_SECRET__JIRA__NOTIFICATION"],
  },
  S: {
    botId: config["WECOM__BOT_ID"],
    secret: config["WECOM__BOT_SECRET"],
  },
};

for (const [name, b] of Object.entries(BOTS)) {
  if (!b.botId || !b.secret) {
    console.error(`❌ 配置缺少 ${name} 的 botId/secret`);
    process.exit(1);
  }
}

const received = [];
const clients = {};

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function watch(name, client) {
  client.on("message", (frame) => {
    const body = frame?.body ?? {};
    const content =
      body?.text?.content ??
      body?.markdown?.content ??
      JSON.stringify(body).slice(0, 200);
    const item = {
      time: ts(),
      receiver: name,
      msgtype: body?.msgtype,
      chattype: body?.chattype,
      from: body?.from?.userid,
      content: String(content).slice(0, 120),
    };
    received.push(item);
    console.log(
      `[${item.time}] 📩 ${name} 收到消息 msgtype=${item.msgtype} chattype=${item.chattype} from=${item.from} content=${item.content}`,
    );
  });
  client.on("event", (frame) => {
    const body = frame?.body ?? {};
    console.log(
      `[${ts()}] 🔔 ${name} 收到事件 ${body?.event?.eventtype ?? "unknown"} ${JSON.stringify(body).slice(0, 150)}`,
    );
  });
  client.on("error", (err) => {
    console.log(`[${ts()}] ⚠️  ${name} 错误: ${err?.message ?? err}`);
  });
}

function connect(name, creds) {
  return new Promise((resolvePromise, reject) => {
    const client = new AiBot.WSClient({
      botId: creds.botId,
      secret: creds.secret,
      maxReconnectAttempts: 0,
    });
    clients[name] = client;
    watch(name, client);
    const timer = setTimeout(() => reject(new Error(`${name} 认证超时`)), 20_000);
    client.on("authenticated", () => {
      clearTimeout(timer);
      console.log(`[${ts()}] ✅ ${name} (${creds.botId.slice(0, 10)}...) 已认证`);
      resolvePromise();
    });
    client.connect();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendViaWebhook(text) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });
  const data = await resp.json();
  console.log(
    `[${ts()}] 📤 webhook 机器人发送: "${text}" → errcode=${data.errcode} ${data.errmsg ?? ""}`,
  );
}

async function sendViaAIBot(name, text) {
  try {
    const frame = await clients[name].sendMessage(chatId, {
      msgtype: "markdown",
      markdown: { content: text },
    });
    const errcode = frame?.body?.errcode ?? frame?.headers?.errcode ?? "?";
    console.log(
      `[${ts()}] 📤 AI 机器人 ${name} sendMessage: "${text}" → errcode=${errcode}`,
    );
  } catch (err) {
    console.log(`[${ts()}] ❌ AI 机器人 ${name} sendMessage 失败: ${err?.message ?? err}`);
  }
}

console.log(`实验标记 RUN_ID=${RUN_ID}，目标群 chatId=${chatId}\n`);

await connect("L1", BOTS.L1);
await connect("L2", BOTS.L2);
await connect("S", BOTS.S);

console.log("\n--- 开始发送测试消息 ---\n");

await sendViaAIBot("S", MARKERS.S);
await sleep(5_000);

await sendViaWebhook(MARKERS.W);
await sleep(5_000);

await sendViaAIBot("L1", MARKERS.L1);

console.log("\n--- 发送完毕，继续监听 45 秒 ---\n");
await sleep(45_000);

console.log("\n===== 实验结果汇总 =====\n");
console.log(`共收到 ${received.length} 条消息回调：`);
for (const r of received) {
  console.log(`  [${r.time}] ${r.receiver} ← from=${r.from} "${r.content}"`);
}
console.log("");
for (const [key, marker] of Object.entries(MARKERS)) {
  const hits = received.filter((r) => r.content.includes(`BOT2BOT-${RUN_ID}-${key}`));
  console.log(
    `标记 ${key}（${marker}）: ${hits.length === 0 ? "没有任何机器人收到" : `被 ${hits.map((h) => h.receiver).join(", ")} 收到`}`,
  );
}
console.log("\n说明：若三个标记均为“没有任何机器人收到”，");
console.log("且发送方 errcode=0（消息确实发到群里），");
console.log("即可证实：机器人发出的消息不会触发其他机器人的消息回调。");

for (const client of Object.values(clients)) {
  client.disconnect();
}
process.exit(0);
