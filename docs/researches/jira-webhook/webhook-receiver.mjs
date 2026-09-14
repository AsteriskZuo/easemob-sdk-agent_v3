#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number.parseInt(process.env.PORT || '8097', 10);
const expectedToken = process.env.JIRA_WEBHOOK_TOKEN || 'local-test-token';
const logDir = process.env.JIRA_WEBHOOK_LOG_DIR || join(process.cwd(), 'docs/research/jira-webhook/logs');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getChangedFields(payload) {
  const items = payload?.changelog?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    field: item?.field,
    fromString: item?.fromString,
    toString: item?.toString
  }));
}

function summarizePayload(payload) {
  return {
    webhookEvent: payload?.webhookEvent,
    issueEventTypeName: payload?.issue_event_type_name,
    timestamp: payload?.timestamp,
    issueId: payload?.issue?.id,
    issueKey: payload?.issue?.key,
    userName: payload?.user?.name,
    userKey: payload?.user?.key,
    changedFields: getChangedFields(payload)
  };
}

async function persistPayload(body) {
  await mkdir(logDir, { recursive: true });
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filePath = join(logDir, fileName);
  await writeFile(filePath, body, 'utf8');
  return filePath;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/jira/webhook') {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (url.searchParams.get('token') !== expectedToken) {
    sendJson(res, 401, { error: 'invalid_token' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: 'read_body_failed', message: String(error) });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const summary = summarizePayload(payload);
  const filePath = await persistPayload(JSON.stringify(payload, null, 2));

  console.log(JSON.stringify({ receivedAt: new Date().toISOString(), filePath, summary }, null, 2));

  res.writeHead(204);
  res.end();
});

server.on('error', (error) => {
  console.error(`Failed to start Jira webhook receiver: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Jira webhook receiver listening on http://127.0.0.1:${port}`);
  console.log(`POST /jira/webhook?token=${expectedToken}`);
  console.log(`Payload logs: ${logDir}`);
});
