#!/usr/bin/env node

// Confluence Server 5.8.10 验证脚本（2026-10-03 调研配套）。
//
// 默认只读探测（不写任何页面）：
//   1. 匿名 GET /rest/api/space?limit=1                       —— 可达性 / 网关拦截行为
//   2. Basic Auth（应用凭证，无网关头）GET /rest/api/content    —— 网关是否消费 Authorization 头
//   3. Basic Auth（网关凭证）GET /rest/api/content?limit=1     —— 过网关；200 说明网关/应用同凭证
//   4. 应用层 401 时：login.action 表单登录取 cookie 后重试      —— 实测唯一可行链路
//
// --write 时追加真实写链路验证（在 --space 指定空间，默认 AIR）：
//   建页（POST /rest/api/content，期望 200）→ 按标题查页（期望 size=1）
//   → 改页（PUT 带 version+1，期望 200）→ 删页（DELETE；实测该账号 403 无 trash 权限，
//   此时打印管理员删除提示，并把页内容更新为「验证残留」说明）。
//   页标题带日期后缀，重复执行会产生多页残留，请谨慎运行。
//
// 2026-10-03 实测背景：c1/j1 全路径匿名 401（nginx/1.23.3 网关 Basic 挑战）；
// 应用凭证单独 Basic（无网关头）→ 401，网关消费 Authorization 头，Basic 直连不可行；
// 实测登录页是 /login.action（/login.jsp 在该实例 404），表单选择器 name="loginform"，
// POST 到 /dologin.action（os_username/os_password/os_cookie/os_destination），
// 302 → index.action 获得 seraph.confluence 会话 cookie。
//
// 凭证来源（环境变量优先于 config；不硬编码）：
//   CONFLUENCE_BASE_URL        站点地址；缺省时从 config 的 TOOL__JIRA__URL 推导（j1→c1 同构替换）
//   CONFLUENCE_USER / PASS     应用凭证；缺省时取 config 的 TOOL__JIRA__USERNAME / PASSWORD
//   CONFLUENCE_GATEWAY_USER / PASS  网关凭证；缺省时取 config 的 TOOL__JIRA__REDIRECT_USERNAME / PASSWORD
//   --config <path>            config JSON 路径，默认 .easemob-agent/config.json
//
// 用法：
//   node docs/researches/confluence-rest/confluence-verify.mjs                  # 只读探测
//   node docs/researches/confluence-rest/confluence-verify.mjs --write          # 读写全链路（真建页）
//   node docs/researches/confluence-rest/confluence-verify.mjs --help

import fs from 'node:fs';
import process from 'node:process';

const TIMEOUT_MS = 30000;
const DEFAULT_CONFIG_PATH = '.easemob-agent/config.json';
const DEFAULT_WRITE_SPACE = 'AIR';

function printHelp() {
  console.log(`Usage:
  node docs/researches/confluence-rest/confluence-verify.mjs [options]

Options:
  --config <path>   Config JSON path. Default: ${DEFAULT_CONFIG_PATH}
                    Reads TOOL__JIRA__URL (-> baseUrl, j1->c1), TOOL__JIRA__USERNAME/PASSWORD
                    (app creds), TOOL__JIRA__REDIRECT_USERNAME/PASSWORD (gateway creds).
  --space <key>     Space for --write chain. Default: ${DEFAULT_WRITE_SPACE}
  --write           Also run the real write chain (create/find/update/delete page).
                    Delete is expected to return 403 (no trash permission); the page is
                    then updated to a "verification residue" notice for admin removal.
  --help            Show this help.

Credentials: env vars (CONFLUENCE_BASE_URL / CONFLUENCE_USER / CONFLUENCE_PASS /
CONFLUENCE_GATEWAY_USER / CONFLUENCE_GATEWAY_PASS) override the config file.

Default mode is read-only: no page is created, modified, or deleted.
`);
}

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG_PATH, space: DEFAULT_WRITE_SPACE, write: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      args.help = true;
    } else if (arg === '--config') {
      args.config = requireValue(argv, ++i, arg);
    } else if (arg === '--space') {
      args.space = requireValue(argv, ++i, arg);
    } else if (arg === '--write') {
      args.write = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

function maskSecret(value) {
  if (!value) return '<missing>';
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function storeCookies(headers, cookies) {
  const getSetCookie = headers.getSetCookie?.bind(headers);
  const rawHeaders = getSetCookie ? getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  for (const header of rawHeaders) {
    for (const part of splitSetCookie(header)) {
      const cookie = parseSetCookie(part);
      if (!cookie) continue;
      const rest = cookies.filter((c) => c.name !== cookie.name);
      rest.push(cookie);
      cookies.length = 0;
      cookies.push(...rest);
    }
  }
}

function splitSetCookie(value) {
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSetCookie(value) {
  const [pair] = value.split(';');
  const idx = pair.indexOf('=');
  if (idx <= 0) return undefined;
  return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
}

async function fetchText(url, { method = 'GET', headers = {}, body, cookies } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (cookies) storeCookies(response.headers, cookies);
    return { status: response.status, headers: response.headers, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeJson(body) {
  try {
    const data = JSON.parse(body);
    if (Array.isArray(data.results)) {
      return `results=${data.results.length} size=${data.size ?? '?'}`;
    }
    return `keys=${Object.keys(data).slice(0, 8).join(',')}`;
  } catch {
    return `non-json body, ${body.length} chars`;
  }
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * 从登录页 HTML 中提取登录表单（与 v2 jira-client 的 extractLoginForm 同思路）。
 * 选择器优先级：name="loginform"（c1 实测）→ id="login-form"（v2 jira 实例）→ 首个 form。
 */
function extractLoginForm(html, responseUrl) {
  const formMatch =
    html.match(/<form\b[^>]*name=["']loginform["'][^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*id=["']login-form["'][^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i);
  if (!formMatch) return undefined;
  const actionMatch = formMatch[0].match(/\saction=["']([^"']*)["']/i);
  const actionUrl = new URL(actionMatch?.[1] ?? '/dologin.action', responseUrl).toString();
  const hiddenFields = {};
  for (const inputMatch of formMatch[0].matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const name = inputMatch[0].match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    hiddenFields[name] = inputMatch[0].match(/\svalue=["']([^"']*)["']/i)?.[1] ?? '';
  }
  return { actionUrl, hiddenFields };
}

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/** 从 jira 站点地址推导 confluence 地址：j1.xxx → c1.xxx；非 j1 前缀返回 null（需显式传 env） */
function deriveConfluenceUrl(jiraUrl) {
  if (!jiraUrl) return '';
  const url = jiraUrl.replace(/\/+$/, '');
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)(j1)(?=\.)/i, '$1c1');
}

function resolveCredentials(args) {
  const config = readConfig(args.config);
  const baseUrl = (process.env.CONFLUENCE_BASE_URL ?? deriveConfluenceUrl(config.TOOL__JIRA__URL) ?? '')
    .replace(/\/+$/, '');
  return {
    baseUrl,
    username: process.env.CONFLUENCE_USER ?? config.TOOL__JIRA__USERNAME ?? '',
    password: process.env.CONFLUENCE_PASS ?? config.TOOL__JIRA__PASSWORD ?? '',
    gatewayUser: process.env.CONFLUENCE_GATEWAY_USER ?? config.TOOL__JIRA__REDIRECT_USERNAME ?? '',
    gatewayPass: process.env.CONFLUENCE_GATEWAY_PASS ?? config.TOOL__JIRA__REDIRECT_PASSWORD ?? '',
    configPath: args.config,
    configFound: Boolean(config.TOOL__JIRA__URL),
  };
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** 实测链路的表单登录：GET /login.action → POST dologin.action → seraph.confluence cookie */
async function formLogin(baseUrl, username, password, gatewayHeaders) {
  const cookies = [];

  // 实测登录页是 /login.action（/login.jsp 在该实例 404）；/login.jsp 仅作兼容回退
  let loginPage = await fetchText(`${baseUrl}/login.action`, { headers: { ...gatewayHeaders }, cookies });
  if (loginPage.status !== 200) {
    loginPage = await fetchText(`${baseUrl}/login.jsp`, { headers: { ...gatewayHeaders }, cookies });
  }
  if (loginPage.status !== 200) {
    throw new Error(`login page not reachable (status ${loginPage.status})`);
  }

  const form = extractLoginForm(loginPage.body, `${baseUrl}/login.action`);
  if (!form) {
    throw new Error('login form not found in login page');
  }
  console.log('[auth]', JSON.stringify({ phase: 'GET login page', status: 200, formAction: form.actionUrl }));

  const payload = new URLSearchParams(form.hiddenFields);
  payload.set('os_username', username);
  payload.set('os_password', password);
  payload.set('os_cookie', 'true');
  if (!payload.get('os_destination')) {
    payload.set('os_destination', '/index.action');
  }

  const loginPost = await fetchText(form.actionUrl, {
    method: 'POST',
    headers: {
      ...gatewayHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(cookies),
    },
    body: payload.toString(),
    cookies,
  });
  console.log('[auth]', JSON.stringify({
    phase: 'POST login form',
    status: loginPost.status,
    cookieNames: cookies.map((c) => c.name),
  }));

  if (cookies.length === 0) {
    throw new Error('no session cookie issued after form login');
  }
  return cookies;
}

/** 读链路：认证 → 返回已认证的请求头；网关挑战实例走表单登录，同凭证实例走 Basic 直连 */
async function authenticate(baseUrl, creds) {
  const jsonHeaders = { Accept: 'application/json' };
  const gatewayHeaders = creds.gatewayUser
    ? { Authorization: basicAuthHeader(creds.gatewayUser, creds.gatewayPass) }
    : {};

  // 步骤 1：匿名探测可达性
  console.log('[step 1] anonymous GET /rest/api/space?limit=1');
  let anonymous;
  try {
    anonymous = await fetchText(`${baseUrl}/rest/api/space?limit=1`, { headers: jsonHeaders });
    console.log('[step 1]', JSON.stringify({ status: anonymous.status, body: summarizeJson(anonymous.body) }));
  } catch (error) {
    throw new Error(`Site unreachable: ${error.message}`);
  }

  // 步骤 2：应用凭证 Basic（不带网关头）——若 401 证明网关消费 Authorization 头
  const basicHeaders = { ...jsonHeaders, Authorization: basicAuthHeader(creds.username, creds.password) };
  console.log('[step 2] app-cred basic-auth GET /rest/api/content?limit=1 (no gateway header)');
  const basic = await fetchText(`${baseUrl}/rest/api/content?limit=1`, { headers: basicHeaders });
  console.log('[step 2]', JSON.stringify({ status: basic.status, body: summarizeJson(basic.body) }));

  if (basic.status === 200) {
    return { headers: basicHeaders, method: 'basic-direct', anonymousStatus: anonymous.status };
  }
  if (basic.status !== 401) {
    throw new Error(`app-cred basic auth returned unexpected status ${basic.status}`);
  }

  // 步骤 3：网关 Basic（应用层匿名）——200 说明网关凭证即应用凭证
  console.log('[step 3] gateway basic-auth GET /rest/api/content?limit=1');
  const gatewayBasic = await fetchText(`${baseUrl}/rest/api/content?limit=1`, {
    headers: { ...jsonHeaders, ...gatewayHeaders },
  });
  console.log('[step 3]', JSON.stringify({ status: gatewayBasic.status, body: summarizeJson(gatewayBasic.body) }));

  // 200 但 results 为空 = 仅过网关、应用层未认证（实测事实 3）；继续步骤 4 表单登录
  if (gatewayBasic.status === 200) {
    const data = parseJson(gatewayBasic.body);
    console.log('[step 3]', JSON.stringify({
      note: 'gateway passed, app layer anonymous',
      appAuthenticated: Boolean(data && Array.isArray(data.results) && data.results.length > 0),
    }));
  } else if (gatewayBasic.status !== 401) {
    throw new Error(`gateway basic auth returned unexpected status ${gatewayBasic.status}`);
  }
  if (!creds.gatewayUser) {
    throw new Error('app-level 401 and no gateway creds (CONFLUENCE_GATEWAY_USER/PASS or config TOOL__JIRA__REDIRECT_*)');
  }

  // 步骤 4：login.action 表单登录取 cookie（实测唯一可行链路）
  console.log('[step 4] app-level 401, trying login.action form login');
  const cookies = await formLogin(baseUrl, creds.username, creds.password, gatewayHeaders);

  const authedHeaders = { ...jsonHeaders, ...gatewayHeaders, Cookie: cookieHeader(cookies) };
  const session = await fetchText(`${baseUrl}/rest/api/content?limit=1`, { headers: authedHeaders, cookies });
  console.log('[step 4]', JSON.stringify({ phase: 'GET content with cookie', status: session.status, body: summarizeJson(session.body) }));
  if (session.status !== 200) {
    throw new Error(`cookie session rejected (status ${session.status})`);
  }
  return { headers: authedHeaders, method: 'form-login-cookie', cookies, anonymousStatus: anonymous.status };
}

/** --write：真实写链路（建页 → 查页 → 改页 → 删页）；删页 403 时留「验证残留」说明页 */
async function runWriteChain(baseUrl, auth, space) {
  const date = new Date().toISOString().slice(0, 10);
  const title = `【验证】出口工具写链路验证页-${date}`;
  const headers = { ...auth.headers, 'Content-Type': 'application/json' };
  const storage = (text) => JSON.stringify({
    type: 'page',
    title,
    space: { key: space },
    body: { storage: { value: `<p>${text}</p>`, representation: 'storage' } },
  });

  // a. 建页
  console.log('[write] POST /rest/api/content (create page)');
  const create = await fetchText(`${baseUrl}/rest/api/content`, {
    method: 'POST',
    headers,
    body: storage(`出口工具写链路验证（${date}）。本页由 confluence-verify.mjs --write 创建，用于验证建页/改页/查页/删页链路。`),
  });
  const created = parseJson(create.body);
  console.log('[write]', JSON.stringify({ phase: 'create', status: create.status, id: created?.id, title: created?.title }));
  if (create.status !== 200 || !created?.id) {
    throw new Error(`create page failed (status ${create.status}): ${summarizeJson(create.body)}`);
  }
  const pageId = created.id;

  // b. 按标题查页
  console.log('[write] GET /rest/api/content by title');
  const found = await fetchText(
    `${baseUrl}/rest/api/content?type=page&spaceKey=${encodeURIComponent(space)}&title=${encodeURIComponent(title)}&expand=version`,
    { headers: auth.headers },
  );
  const foundData = parseJson(found.body);
  console.log('[write]', JSON.stringify({ phase: 'find', status: found.status, size: foundData?.size }));

  // c. 改页（version+1）
  const currentVersion = foundData?.results?.[0]?.version?.number ?? 1;
  console.log('[write] PUT /rest/api/content/{id} (update page)');
  const updateBody = JSON.parse(storage(`出口工具写链路验证（${date}）—— 已更新。当前为第 ${currentVersion + 1} 版。`));
  updateBody.id = pageId;
  updateBody.version = { number: currentVersion + 1 };
  const update = await fetchText(`${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(updateBody),
  });
  console.log('[write]', JSON.stringify({ phase: 'update', status: update.status }));

  // d. 删页（实测该账号 403 无 trash 权限）
  console.log('[write] DELETE /rest/api/content/{id} (expect 403, no trash permission)');
  const del = await fetchText(`${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`, {
    method: 'DELETE',
    headers: auth.headers,
  });
  console.log('[write]', JSON.stringify({ phase: 'delete', status: del.status, body: summarizeJson(del.body) }));

  if (del.status === 200) {
    console.log('[write] page deleted, no residue');
    return { created: true, updated: true, found: foundData?.size === 1, deleted: true, residue: false };
  }

  // 删不掉：把页内容更新为「验证残留」说明，提示管理员删除
  console.log('[write] delete denied, marking page as verification residue');
  const fresh = await fetchText(
    `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?expand=version`,
    { headers: auth.headers },
  );
  const freshData = parseJson(fresh.body);
  const freshVersion = freshData?.version?.number ?? currentVersion + 1;
  const residueBody = {
    id: pageId,
    type: 'page',
    title,
    space: { key: space },
    body: {
      storage: {
        value: `<p>【验证残留，请管理员删除】出口工具写链路验证页-${date}（id=${pageId}）。本页由 confluence-verify.mjs --write 创建，因服务账号无 trash 权限（DELETE 返回 403）无法自删，内容已替换为本说明，请 Confluence 管理员手动删除。</p>`,
        representation: 'storage',
      },
    },
    version: { number: freshVersion + 1 },
  };
  const mark = await fetchText(`${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(residueBody),
  });
  console.log('[write]', JSON.stringify({ phase: 'mark-residue', status: mark.status }));
  console.log(`[write] 残留页：「${title}」(id=${pageId})，请管理员删除`);
  return { created: true, updated: true, found: foundData?.size === 1, deleted: false, residue: true, residuePageId: pageId };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const creds = resolveCredentials(args);
  console.log('[config]', JSON.stringify({
    configPath: args.config,
    configFound: creds.configFound,
    baseUrl: creds.baseUrl || '<missing: set CONFLUENCE_BASE_URL>',
    user: maskSecret(creds.username),
    hasPass: Boolean(creds.password),
    hasGateway: Boolean(creds.gatewayUser && creds.gatewayPass),
    write: args.write,
    space: args.space,
  }));

  if (!creds.baseUrl || !creds.username || !creds.password) {
    throw new Error('Missing credentials: set CONFLUENCE_BASE_URL/USER/PASS env or provide --config with TOOL__JIRA__* keys');
  }

  const auth = await authenticate(creds.baseUrl, creds);
  console.log('[summary:auth]', JSON.stringify({
    anonymousStatus: auth.anonymousStatus,
    authMethod: auth.method,
  }, null, 2));
  console.log(`RESULT: PASS (auth via ${auth.method})`);

  if (args.write) {
    console.log('[write] running real write chain (page will be created)');
    const result = await runWriteChain(creds.baseUrl, auth, args.space);
    console.log('[summary:write]', JSON.stringify(result, null, 2));
    console.log(`RESULT: ${result.created && result.updated && result.found ? 'PASS (write chain)' : 'FAIL (write chain incomplete)'}`);
  }
}

main().catch((error) => {
  console.error('[error]', error.message);
  console.log('RESULT: FAIL (exception)');
  process.exitCode = 1;
});
