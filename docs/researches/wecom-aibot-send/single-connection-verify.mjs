#!/usr/bin/env node

// 企微智能机器人「同一 botId 单连接」互踢验证（2026-10-03）。
//
// 背景问题：出口工具是否可以自己持有 SDK 对象（与入口 trigger 各持一个连接）？
// 官方规则 + bot-to-bot 调研：同一机器人同时只能保持一个有效长连接，新连接踢旧连接。
// 本脚本实测该行为：先后用同一 botId 建两个 WSClient，观察先建者是否收到
// event.disconnected_event（服务端主动断开旧连接）。
//
// 凭证从 config JSON 读取（--config，键 WECOM__BOT_ID / WECOM__BOT_SECRET），
// 不打印任何凭证值。全程不发任何消息，只建/断连接。
//
// 用法：
//   node docs/researches/wecom-aibot-send/single-connection-verify.mjs [--config <path>] [--bot-index <n>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// SDK 仅 v2 仓库已安装（v3 尚未引入），直接引用 v2 的构建产物
const sdkPath = '/Users/asterisk/Codes/ai/easemob-sdk-agent_v2/node_modules/@wecom/aibot-node-sdk/dist/index.cjs.js';
const { WSClient } = require(sdkPath);

function parseArgs(argv) {
  const args = { config: '.easemob-agent/config.json', botIndex: 1 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--bot-index') args.botIndex = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function loadCredentials(configPath, botIndex) {
  const full = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(full, 'utf8'));
  const suffix = botIndex > 1 ? `_${String(botIndex).padStart(2, '0')}` : '';
  const botId = config[`WECOM__BOT_ID${suffix}`];
  const secret = config[`WECOM__BOT_SECRET${suffix}`];
  if (!botId || !secret) throw new Error(`Missing WECOM__BOT_ID/SECRET${suffix} in ${full}`);
  return { botId, secret };
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function connectClient(label, creds) {
  const client = new WSClient({
    botId: creds.botId,
    secret: creds.secret,
    maxReconnectAttempts: 0, // 被踢后不自动重连，便于观察
    maxAuthFailureAttempts: 1,
    logger: silentLogger(),
  });
  const events = [];
  client.on('connected', () => events.push(`${label}: connected`));
  client.on('authenticated', () => events.push(`${label}: authenticated`));
  client.on('event.disconnected_event', (frame) => {
    events.push(`${label}: event.disconnected_event (被新连接踢下线)`, frame);
  });
  client.on('disconnected', (reason) => events.push(`${label}: disconnected (reason=${reason})`));
  client.on('reconnecting', (attempt) => events.push(`${label}: reconnecting attempt=${attempt}`));
  client.connect();
  return { client, events };
}

function waitFor(list, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    const check = () => {
      const hit = list.filter(predicate);
      if (hit.length > 0) {
        clearTimeout(timer);
        resolve(hit);
      } else setTimeout(check, 200);
    };
    check();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const creds = loadCredentials(args.config, args.botIndex);
  console.log('[config] botId=' + creds.botId.slice(0, 6) + '...（已脱敏）');

  // A 先建连（模拟入口 trigger 持有）
  const a = connectClient('A(先连)', creds);
  await waitFor(a.events, (e) => typeof e === 'string' && e.endsWith('authenticated'), 20000, 'A authenticated');
  console.log('[step 1] A 已认证（模拟入口 trigger 持有连接）');

  // B 同一 botId 再建连（模拟出口工具自持）
  const b = connectClient('B(后连)', creds);
  await waitFor(b.events, (e) => typeof e === 'string' && e.endsWith('authenticated'), 20000, 'B authenticated');
  console.log('[step 2] B 已认证（模拟出口工具自持连接）');

  // 观察 A 是否被踢
  try {
    await waitFor(
      a.events,
      (e) => typeof e === 'string' && (e.includes('disconnected_event') || e.startsWith('A(先连): disconnected')),
      15000,
      'A kicked',
    );
    console.log('[step 3] A 收到断开事件 → 互踢确认');
  } catch {
    console.log('[step 3] 15s 内 A 未被踢（与官方规则不符，需复查）');
  }

  console.log('--- event log ---');
  for (const e of a.events) if (typeof e === 'string') console.log(' ', e);
  for (const e of b.events) if (typeof e === 'string') console.log(' ', e);

  const kicked = a.events.some((e) => typeof e === 'string' && e.includes('disconnected'));
  console.log(kicked
    ? 'RESULT: PASS（同一 botId 双连接互踢实测确认：入口/出口必须共享同一 SDK 实例，不能各自持有）'
    : 'RESULT: FAIL（未观察到互踢）');

  a.client.disconnect();
  b.client.disconnect();
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exitCode = 1;
});
