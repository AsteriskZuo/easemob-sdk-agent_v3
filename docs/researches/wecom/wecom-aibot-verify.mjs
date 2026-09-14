#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const defaultConfigPath = '/Users/asterisk/Codes/ai/easemob-sdk-agent/.easemob-agent/config.json';

function printHelp() {
  console.log(`Usage:
  node docs/research/wecom/wecom-aibot-verify.mjs [options]

Options:
  --config <path>           Config JSON path. Default: ${defaultConfigPath}
  --bot-index <n>           Use WECOM__BOT_ID[_NN] and WECOM__BOT_SECRET[_NN]. Default: 1
  --connect                 Connect to WeCom long-connection gateway with @wecom/aibot-node-sdk.
  --listen-seconds <n>      Seconds to keep the connection open. Default: 30
  --reply-echo              When connected, echo text messages back with replyStream.
  --ws-url <url>            Override SDK wsUrl, useful for private deployment.
  --verify-callback <json>  Verify URL callback query fields and echostr.
                            JSON shape: {"token":"...","encodingAesKey":"...","corpId":"...","msg_signature":"...","timestamp":"...","nonce":"...","echostr":"..."}
  --help                    Show this help.

Default mode only validates local config shape and does not connect or send messages.
`);
}

function parseArgs(argv) {
  const args = {
    config: defaultConfigPath,
    botIndex: 1,
    connect: false,
    listenSeconds: 30,
    replyEcho: false,
    wsUrl: '',
    verifyCallback: '',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      args.help = true;
    } else if (arg === '--config') {
      args.config = requireValue(argv, ++i, arg);
    } else if (arg === '--bot-index') {
      args.botIndex = Number.parseInt(requireValue(argv, ++i, arg), 10);
    } else if (arg === '--connect') {
      args.connect = true;
    } else if (arg === '--listen-seconds') {
      args.listenSeconds = Number.parseInt(requireValue(argv, ++i, arg), 10);
    } else if (arg === '--reply-echo') {
      args.replyEcho = true;
    } else if (arg === '--ws-url') {
      args.wsUrl = requireValue(argv, ++i, arg);
    } else if (arg === '--verify-callback') {
      args.verifyCallback = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.botIndex) || args.botIndex < 1) {
    throw new Error('--bot-index must be a positive integer');
  }
  if (!Number.isInteger(args.listenSeconds) || args.listenSeconds < 1) {
    throw new Error('--listen-seconds must be a positive integer');
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function botKey(base, index) {
  if (index === 1) {
    return base;
  }
  return `${base}_${String(index).padStart(2, '0')}`;
}

function getBotCredentials(config, index) {
  const botIdKey = botKey('WECOM__BOT_ID', index);
  const secretKey = botKey('WECOM__BOT_SECRET', index);
  return {
    botIdKey,
    secretKey,
    botId: config[botIdKey] || '',
    secret: config[secretKey] || '',
  };
}

function maskSecret(value) {
  if (!value) return '<missing>';
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sha1Signature(parts) {
  return crypto.createHash('sha1').update(parts.sort().join('')).digest('hex');
}

function decodeEncodingAesKey(encodingAesKey) {
  if (encodingAesKey.length !== 43) {
    throw new Error('encodingAesKey must be 43 characters');
  }
  return Buffer.from(`${encodingAesKey}=`, 'base64');
}

function decryptCallbackPayload(encryptedPayload, encodingAesKey) {
  const aesKey = decodeEncodingAesKey(encodingAesKey);
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([
    decipher.update(Buffer.from(encryptedPayload, 'base64')),
    decipher.final(),
  ]);
  const plain = pkcs7Unpad(padded);
  const msgLength = plain.readUInt32BE(16);
  const message = plain.subarray(20, 20 + msgLength).toString('utf8');
  const receiveId = plain.subarray(20 + msgLength).toString('utf8');
  return { message, receiveId };
}

function pkcs7Unpad(buffer) {
  if (buffer.length === 0) {
    throw new Error('empty decrypted payload');
  }
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 32) {
    throw new Error(`invalid PKCS#7 padding: ${pad}`);
  }
  return buffer.subarray(0, buffer.length - pad);
}

function verifyCallback(input) {
  const required = ['token', 'encodingAesKey', 'msg_signature', 'timestamp', 'nonce', 'echostr'];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`callback verification requires ${key}`);
    }
  }

  const signature = sha1Signature([
    input.token,
    input.timestamp,
    input.nonce,
    input.echostr,
  ]);
  const signatureOk = signature === input.msg_signature;
  const decrypted = signatureOk
    ? decryptCallbackPayload(input.echostr, input.encodingAesKey)
    : null;

  return {
    signatureOk,
    expectedSignature: signature,
    receivedSignature: input.msg_signature,
    decrypted,
    corpIdMatched: decrypted && input.corpId ? decrypted.receiveId === input.corpId : undefined,
  };
}

async function connectLongConnection({ botId, secret, listenSeconds, replyEcho, wsUrl }) {
  let sdk;
  try {
    sdk = await import('@wecom/aibot-node-sdk');
  } catch (error) {
    throw new Error(
      `Cannot load @wecom/aibot-node-sdk. Install it before --connect verification. Original error: ${error.message}`,
    );
  }

  const AiBot = sdk.default || sdk;
  const WSClient = sdk.WSClient || AiBot.WSClient;
  const generateReqId = sdk.generateReqId || AiBot.generateReqId;
  if (!WSClient) {
    throw new Error('@wecom/aibot-node-sdk does not export WSClient');
  }

  const events = [];
  const client = new WSClient({
    botId,
    secret,
    ...(wsUrl ? { wsUrl } : {}),
    maxReconnectAttempts: 0,
    logger: {
      debug: () => {},
      info: (...args) => console.log('[sdk:info]', ...args),
      warn: (...args) => console.warn('[sdk:warn]', ...args),
      error: (...args) => console.error('[sdk:error]', ...args),
    },
  });

  client.on('connected', () => {
    events.push('connected');
    console.log('[event] connected');
  });
  client.on('authenticated', () => {
    events.push('authenticated');
    console.log('[event] authenticated');
  });
  client.on('disconnected', (reason) => {
    events.push('disconnected');
    console.log('[event] disconnected', reason);
  });
  client.on('error', (error) => {
    events.push('error');
    console.error('[event] error', error.message);
  });
  client.on('message.text', async (frame) => {
    const content = frame.body?.text?.content || '';
    const msgid = frame.body?.msgid || '';
    const chattype = frame.body?.chattype || '';
    const from = frame.body?.from?.userid || '';
    console.log('[event] message.text', JSON.stringify({ msgid, chattype, from, content }));

    if (replyEcho) {
      const streamId = generateReqId ? generateReqId('research') : `research_${Date.now()}`;
      await client.replyStream(frame, streamId, `echo: ${content}`, true);
      console.log('[action] replied echo');
    }
  });
  client.on('message', (frame) => {
    const msgtype = frame.body?.msgtype || frame.cmd || 'unknown';
    if (msgtype !== 'text') {
      console.log('[event] message', JSON.stringify({ msgtype, msgid: frame.body?.msgid }));
    }
  });
  client.on('event', (frame) => {
    console.log('[event] callback', JSON.stringify({ event: frame.body?.event, msgid: frame.body?.msgid }));
  });

  client.connect();
  await new Promise((resolve) => setTimeout(resolve, listenSeconds * 1000));
  client.disconnect();
  return { events };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = readConfig(args.config);
  const creds = getBotCredentials(config, args.botIndex);

  console.log('[config]', JSON.stringify({
    path: args.config,
    botIdKey: creds.botIdKey,
    secretKey: creds.secretKey,
    botId: maskSecret(creds.botId),
    secret: maskSecret(creds.secret),
    hasBotId: Boolean(creds.botId),
    hasSecret: Boolean(creds.secret),
  }, null, 2));

  if (!creds.botId || !creds.secret) {
    throw new Error(`Missing ${creds.botIdKey} or ${creds.secretKey}`);
  }

  if (args.verifyCallback) {
    const callbackInput = JSON.parse(args.verifyCallback);
    console.log('[callback]', JSON.stringify(verifyCallback(callbackInput), null, 2));
  }

  if (args.connect) {
    console.log('[connect]', JSON.stringify({
      listenSeconds: args.listenSeconds,
      replyEcho: args.replyEcho,
      wsUrl: args.wsUrl || '<sdk-default>',
    }, null, 2));
    const result = await connectLongConnection({
      botId: creds.botId,
      secret: creds.secret,
      listenSeconds: args.listenSeconds,
      replyEcho: args.replyEcho,
      wsUrl: args.wsUrl,
    });
    console.log('[summary]', JSON.stringify(result, null, 2));
  } else {
    console.log('[summary] config shape is valid. Use --connect to verify the WeCom long connection.');
  }
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exitCode = 1;
});
