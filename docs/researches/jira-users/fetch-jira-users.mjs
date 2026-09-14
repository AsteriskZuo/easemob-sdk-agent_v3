#!/usr/bin/env node

/**
 * 从 Jira 抓取所有用户信息（name / emailAddress / displayName / key）。
 *
 * 用途：为 matchesAssignee 提供完整的用户映射表，
 *       解决只用邮箱配置 reviewAssignees 时匹配不上的问题。
 *
 * Jira Server REST API: /rest/api/2/user/search?username=.
 * username=. 是 Jira Server 的通配符，匹配所有用户。
 *
 * 用法:
 *   node docs/researches/jira-users/fetch-jira-users.mjs
 *   node docs/researches/jira-users/fetch-jira-users.mjs --output=./custom-output.json
 *   node docs/researches/jira-users/fetch-jira-users.mjs --dry-run
 *
 * 环境变量:
 *   配置文件路径可通过 --config 指定，默认读取项目 config.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── 配置 ──────────────────────────────────────────────────────

const DEFAULT_CONFIG =
  "/Users/asterisk/Codes/ai/easemob-sdk-agent/.easemob-agent/config.json";
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = join(THIS_DIR, "jira-users.json");

// ── 命令行参数解析 ────────────────────────────────────────────

/**
 * @typedef {Object} Options
 * @property {string}  configPath
 * @property {boolean} dryRun
 * @property {number}  maxResults
 * @property {string}  output
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG,
    dryRun: false,
    maxResults: 1000,
    output: DEFAULT_OUTPUT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--config") {
      options.configPath = requireValue(arg, next);
      i++;
    } else if (arg === "--max-results") {
      options.maxResults = Number.parseInt(requireValue(arg, next), 10);
      i++;
    } else if (arg === "--output") {
      options.output = requireValue(arg, next);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// ── 配置加载 ──────────────────────────────────────────────────

/**
 * @param {string} configPath
 * @returns {Promise<{
 *   jiraUrl: string,
 *   username: string,
 *   password: string,
 *   redirectUsername?: string,
 *   redirectPassword?: string
 * }>}
 */
async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  return {
    jiraUrl: requireConfig(config, "TOOL__JIRA__URL"),
    username: requireConfig(config, "TOOL__JIRA__USERNAME"),
    password: requireConfig(config, "TOOL__JIRA__PASSWORD"),
    redirectUsername: readConfig(config, "TOOL__JIRA__REDIRECT_USERNAME"),
    redirectPassword: readConfig(config, "TOOL__JIRA__REDIRECT_PASSWORD"),
  };
}

function readConfig(config, key) {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireConfig(config, key) {
  const value = readConfig(config, key);
  if (!value) throw new Error(`${key} is missing in config`);
  return value;
}

// ── 认证 ──────────────────────────────────────────────────────

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

/**
 * @param {import('./types').JiraConfig} config
 * @returns {Record<string, string>}
 */
function gatewayHeaders(config) {
  if (!config.redirectUsername || !config.redirectPassword) return {};
  return {
    Authorization: `Basic ${basicAuth(
      config.redirectUsername,
      config.redirectPassword,
    )}`,
  };
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function storeCookies(cookies, headers) {
  for (const raw of collectSetCookie(headers)) {
    const cookie = parseSetCookie(raw);
    if (!cookie) continue;
    const idx = cookies.findIndex((c) => c.name === cookie.name);
    if (idx >= 0) cookies.splice(idx, 1, cookie);
    else cookies.push(cookie);
  }
}

function collectSetCookie(headers) {
  if (typeof headers.getSetCookie === "function")
    return headers.getSetCookie();
  const v = headers.get("set-cookie");
  if (!v) return [];
  return v.split(/,(?=\s*[^;,\s]+=)/).map((s) => s.trim()).filter(Boolean);
}

function parseSetCookie(value) {
  const [pair] = value.split(";");
  const sep = pair.indexOf("=");
  if (sep <= 0) return undefined;
  return { name: pair.slice(0, sep).trim(), value: pair.slice(sep + 1).trim() };
}

function extractLoginForm(html, responseUrl) {
  const match =
    findLoginForm(html) ??
    html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*>/i);
  if (!match) return undefined;

  const action = match[0].match(/\saction=["']([^"']*)["']/i)?.[1];
  const actionUrl = new URL(
    action ?? "/login.jsp",
    responseUrl,
  ).toString();

  const hidden = {};
  for (const input of match[0].matchAll(
    /<input\b[^>]*type=["']hidden["'][^>]*>/gi,
  )) {
    const name = input[0].match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    hidden[name] =
      input[0].match(/\svalue=["']([^"']*)["']/i)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields: hidden };
}

function findLoginForm(html) {
  for (const m of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    if (/\sid=["']login-form["']/i.test(m[0])) return m;
  }
  return undefined;
}

function isAnonymous(response, body) {
  const headerUser = response.headers.get("x-ausername")?.trim().toLowerCase();
  if (headerUser === "anonymous") return true;
  if (headerUser) return false;

  const remoteUser = body.match(
    /<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i,
  );
  if (remoteUser) return remoteUser[1].trim() === "";

  const lowered = body.toLowerCase();
  return (
    lowered.includes("log in - easemob jira") ||
    lowered.includes('name="os_username"')
  );
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

async function fetchText(
  url,
  { method = "GET", headers = {}, body, cookies = [] } = {},
) {
  const res = await fetch(url, {
    method,
    headers: body ? { ...headers, "Content-Length": String(body.length) } : headers,
    body,
    redirect: "manual",
  });
  storeCookies(cookies, res.headers);
  return { response: res, body: await res.text() };
}

/**
 * 表单登录认证
 * @param {import('./types').JiraConfig} config
 * @param {Array<{name: string, value: string}>} cookies
 */
async function authenticate(config, cookies) {
  const jiraUrl = config.jiraUrl.replace(/\/+$/, "");
  const loginPage = await fetchText(`${jiraUrl}/login.jsp`, {
    headers: gatewayHeaders(config),
    cookies,
  });
  if (!loginPage.response.ok)
    throw new Error(`Login page failed: HTTP ${loginPage.response.status}`);

  const form = extractLoginForm(
    loginPage.body,
    loginPage.response.url ?? `${jiraUrl}/login.jsp`,
  );
  if (!form) throw new Error("Login form not found");

  const payload = new URLSearchParams(form.hiddenFields);
  payload.set("os_username", config.username);
  payload.set("os_password", config.password);
  payload.set("os_cookie", "true");
  if (!payload.get("os_destination"))
    payload.set("os_destination", "/secure/Dashboard.jspa");

  const loginPost = await fetchText(form.actionUrl, {
    method: "POST",
    headers: {
      ...gatewayHeaders(config),
      Cookie: cookieHeader(cookies),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
    cookies,
  });
  if (!loginPost.response.ok && !isRedirect(loginPost.response.status))
    throw new Error(`Login POST failed: HTTP ${loginPost.response.status}`);

  if (isRedirect(loginPost.response.status)) {
    const location = loginPost.response.headers.get("location");
    if (location) {
      const redirected = await fetchText(
        new URL(location, form.actionUrl).toString(),
        {
          headers: {
            ...gatewayHeaders(config),
            Cookie: cookieHeader(cookies),
          },
          cookies,
        },
      );
      if (!redirected.response.ok)
        throw new Error(`Login redirect failed: HTTP ${redirected.response.status}`);
    }
  }

  const verify = await fetchText(`${jiraUrl}/secure/Dashboard.jspa`, {
    headers: {
      ...gatewayHeaders(config),
      Cookie: cookieHeader(cookies),
    },
    cookies,
  });
  if (!verify.response.ok)
    throw new Error(`Auth verify failed: HTTP ${verify.response.status}`);
  if (isAnonymous(verify.response, verify.body))
    throw new Error("Still anonymous after login");
}

// ── 用户数据提取 ──────────────────────────────────────────────

/**
 * Jira 6.3.6 不支持 username=. 通配符。
 * 改用遍历 a-z 单字符前缀的方式获取全部用户，通过 name 去重。
 *
 * @param {string} jiraUrl
 * @param {Record<string, string>} gatewayHeaders
 * @param {string} cookieHeader
 * @param {number} maxResults
 * @returns {Promise<unknown[]>}
 */
async function fetchAllUsers(jiraUrl, gwHeaders, cookie, maxResults) {
  const seen = new Set();
  const all = [];

  for (let c = 97; c <= 122; c++) {
    const char = String.fromCharCode(c);
    const params = new URLSearchParams({
      username: char,
      includeActive: "true",
      includeInactive: "true",
      maxResults: String(maxResults),
    });
    const url = `${jiraUrl}/rest/api/2/user/search?${params}`;

    const res = await fetchText(url, {
      headers: { ...gwHeaders, Accept: "application/json", Cookie: cookie },
    });

    if (!res.response.ok) {
      console.error(`  prefix "${char}" failed: HTTP ${res.response.status}`);
      continue;
    }

    const users = JSON.parse(res.body);
    if (!Array.isArray(users)) continue;

    console.error(`  prefix "${char}": ${users.length} user(s)`);

    for (const user of users) {
      if (seen.has(user.name)) continue;
      seen.add(user.name);
      all.push(user);
    }
  }

  return all;
}

/**
 * 从 Jira User 对象中提取关键字段
 * @param {Record<string, unknown>} user
 * @returns {{ name: string, key?: string, displayName?: string, emailAddress?: string, active: boolean }}
 */
function extractUser(user) {
  return {
    name: readStr(user.name) ?? "",
    key: readStr(user.key),
    displayName: readStr(user.displayName),
    emailAddress: readStr(user.emailAddress),
    active: user.active === true,
  };
}

function readStr(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── 主流程 ────────────────────────────────────────────────────

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const jiraUrl = config.jiraUrl.replace(/\/+$/, "");

  // 构造搜索 URL（dry-run 用，实际使用 prefix 遍历）
  const params = new URLSearchParams({
    username: ".",
    includeActive: "true",
    includeInactive: "true",
    maxResults: String(options.maxResults),
  });
  const searchUrl = `${jiraUrl}/rest/api/2/user/search?${params}`;

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          method: "prefix-iteration",
          note: "Jira 6.3.6 不支持 username=. 通配符，实际执行时会遍历 a-z 前缀",
          exampleUrl: searchUrl,
          output: options.output,
        },
        null,
        2,
      ),
    );
    return;
  }

  // 认证 + 请求
  const cookies = /** @type {Array<{name: string, value: string}>} */ ([]);
  console.error("Authenticating...");
  await authenticate(config, cookies);

  console.error("Fetching users by prefix iteration (a-z)...");
  const users = await fetchAllUsers(
    jiraUrl,
    gatewayHeaders(config),
    cookieHeader(cookies),
    options.maxResults,
  );

  // 提取 + 统计
  const extracted = users.map(extractUser);
  const active = extracted.filter((u) => u.active).length;

  const result = {
    fetchedAt: new Date().toISOString(),
    jiraUrl,
    total: extracted.length,
    active,
    inactive: extracted.length - active,
    "name→email": Object.fromEntries(
      extracted.filter((u) => u.emailAddress).map((u) => [u.name, u.emailAddress]),
    ),
    "email→name": Object.fromEntries(
      extracted.filter((u) => u.emailAddress).map((u) => [u.emailAddress, u.name]),
    ),
    "name→displayName": Object.fromEntries(
      extracted.filter((u) => u.displayName).map((u) => [u.name, u.displayName]),
    ),
    users: extracted,
  };

  // 输出
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(result, null, 2), "utf8");

  console.error(
    `Done! ${extracted.length} users (${active} active) → ${options.output}`,
  );

  // 也打印一份到 stdout 方便管道使用
  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
