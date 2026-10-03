#!/usr/bin/env node
/**
 * Jira 认证链路只读冒烟验证（可反复运行，全程只读，无副作用）。
 *
 * 用途：反复验证「网关 Basic + login.jsp 表单登录 + cookie 会话」认证链路对
 * Jira 6.3.6（j1.private.easemob.com）仍然有效，逻辑移植自 v2 生产代码
 * easemob-sdk-agent_v2/src/jira/jira-client.ts（表单解析/登录验证/cookie 管理）。
 *
 * 流程：
 *   1. --config 读取 JSON 配置中的 TOOL__JIRA__* 键（缺省 .easemob-agent/config.json）
 *   2. GET login.jsp，解析登录表单（id="login-form" 优先，首个 <form> 兜底），
 *      提取全部 hidden input（含 xsrf/atl_token 类隐藏字段），填入
 *      os_username/os_password/os_cookie/os_destination 后 POST 表单 action
 *   3. 登录 POST 3xx 手动跟随一次；再 GET /secure/Dashboard.jspa 验证非匿名
 *      （x-ausername 头 / ajs-remote-user meta / 登录页特征三重判据）
 *   4. 带 cookie 会话依次只读 GET /rest/api/2/serverInfo 与
 *      /rest/api/2/search?maxResults=1，两者 2xx 即认证链路验证通过
 *
 * 全程不打印任何凭证；失败以非零码退出并打印失败步骤与 HTTP 状态。
 *
 * 用法：node docs/researches/jira-write-ops/jira-readonly-verify.mjs [--config <path>]
 */

import { readFile } from "node:fs/promises";

const TIMEOUT_MS = 30000;

// ---- 配置读取 ----

function parseArgs(argv) {
  const args = { config: ".easemob-agent/config.json" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1]) {
      args.config = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function loadConfig(configPath) {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const get = (key) => {
    const value = raw[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const config = {
    jiraUrl: get("TOOL__JIRA__URL"),
    username: get("TOOL__JIRA__USERNAME"),
    password: get("TOOL__JIRA__PASSWORD"),
    redirectUsername: get("TOOL__JIRA__REDIRECT_USERNAME"),
    redirectPassword: get("TOOL__JIRA__REDIRECT_PASSWORD"),
  };
  const missing = ["jiraUrl", "username", "password"].filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `配置 ${configPath} 缺少必需的 TOOL__JIRA__* 键：${missing.join(", ")}`,
    );
  }
  config.jiraUrl = config.jiraUrl.replace(/\/+$/, "");
  return config;
}

// ---- cookie 管理（移植自 v2 jira-client.ts storeCookies/cookieHeader/parseSetCookie）----

const cookies = [];

function cookieHeader() {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function collectSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  if (!value) return [];
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function parseSetCookie(value) {
  const [pair] = value.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  };
}

function storeCookies(headers) {
  for (const header of collectSetCookieHeaders(headers)) {
    const cookie = parseSetCookie(header);
    if (!cookie) continue;
    for (let i = cookies.length - 1; i >= 0; i -= 1) {
      if (cookies[i].name === cookie.name) cookies.splice(i, 1);
    }
    cookies.push(cookie);
  }
}

// ---- HTTP 底层（redirect: manual，超时 AbortController）----

function gatewayHeaders(config) {
  if (!config.redirectUsername || !config.redirectPassword) return {};
  return {
    Authorization: `Basic ${Buffer.from(
      `${config.redirectUsername}:${config.redirectPassword}`,
    ).toString("base64")}`,
  };
}

async function fetchText(config, url, headers = {}, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: Object.fromEntries(
        Object.entries({
          ...gatewayHeaders(config),
          ...headers,
          Cookie: cookieHeader(),
        }).filter(([, value]) => value !== ""),
      ),
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    storeCookies(response.headers);
    return { response, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

// ---- 登录表单解析（移植自 v2 extractLoginForm/findLoginForm）----

function findLoginForm(html) {
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const formMatch of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(formMatch[0])) {
      return formMatch;
    }
  }
  return undefined;
}

function extractLoginForm(html, responseUrl) {
  const formMatch =
    findLoginForm(html) ??
    html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*>/i);
  if (!formMatch) return undefined;

  const actionMatch = formMatch[0].match(/\saction=["']([^"']*)["']/i);
  const actionUrl = new URL(actionMatch?.[1] ?? "/login.jsp", responseUrl).toString();
  const hiddenFields = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = input.match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    hiddenFields[name] = input.match(/\svalue=["']([^"']*)["']/i)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields };
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

// ---- 认证流程（移植自 v2 ensureAuthenticated/followRedirect，只保留登录必需路径）----

async function ensureAuthenticated(config) {
  const loginPage = await fetchText(config, `${config.jiraUrl}/login.jsp`);
  if (!loginPage.response.ok) {
    throw new Error(
      `获取 login.jsp 失败：HTTP ${loginPage.response.status} ${loginPage.response.statusText}`,
    );
  }

  const form = extractLoginForm(
    loginPage.body,
    loginPage.response.url ?? `${config.jiraUrl}/login.jsp`,
  );
  if (!form) {
    throw new Error("login.jsp 中未找到登录表单");
  }

  const payload = new URLSearchParams(form.hiddenFields);
  payload.set("os_username", config.username);
  payload.set("os_password", config.password);
  payload.set("os_cookie", "true");
  if (!payload.get("os_destination")) {
    payload.set("os_destination", "/secure/Dashboard.jspa");
  }

  const loginPost = await fetchText(
    config,
    form.actionUrl,
    { "Content-Type": "application/x-www-form-urlencoded" },
    payload.toString(),
  );
  if (isRedirect(loginPost.response.status)) {
    const location = loginPost.response.headers.get("location");
    if (!location) {
      throw new Error(`登录 POST 返回 ${loginPost.response.status} 但无 Location 头`);
    }
    const followed = await fetchText(
      config,
      new URL(location, form.actionUrl).toString(),
    );
    if (!followed.response.ok) {
      throw new Error(
        `跟随登录重定向失败：HTTP ${followed.response.status} ${followed.response.statusText}`,
      );
    }
  } else if (!loginPost.response.ok) {
    throw new Error(
      `登录 POST 失败：HTTP ${loginPost.response.status} ${loginPost.response.statusText}`,
    );
  }

  const verify = await fetchText(config, `${config.jiraUrl}/secure/Dashboard.jspa`);
  if (!verify.response.ok) {
    throw new Error(
      `登录验证请求 Dashboard 失败：HTTP ${verify.response.status} ${verify.response.statusText}`,
    );
  }
  if (isAnonymous(verify.response, verify.body)) {
    throw new Error("登录验证失败：Dashboard 页面仍显示为匿名用户（凭证错误或登录被拒）");
  }
}

async function getAuthedJson(config, path) {
  const url = `${config.jiraUrl}${path}`;
  let result = await fetchText(config, url, { Accept: "application/json" });
  if (result.response.status === 401) {
    cookies.length = 0; // 会话过期：清 cookie 重登一次（对应 v2 fetchAuthed 自愈）
    await ensureAuthenticated(config);
    result = await fetchText(config, url, { Accept: "application/json" });
  }
  if (!result.response.ok) {
    throw new Error(`GET ${path} 失败：HTTP ${result.response.status} ${result.response.statusText}`);
  }
  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(`GET ${path} 返回非法 JSON`);
  }
}

// ---- 主流程 ----

async function main() {
  const { config } = { config: await loadConfig(parseArgs(process.argv).config) };

  process.stdout.write(`[1/3] login.jsp 表单登录（${new URL(config.jiraUrl).host}）... `);
  await ensureAuthenticated(config);
  process.stdout.write("OK\n");

  process.stdout.write("[2/3] GET /rest/api/2/serverInfo ... ");
  const serverInfo = await getAuthedJson(config, "/rest/api/2/serverInfo");
  process.stdout.write(`OK（baseUrl=${serverInfo.baseUrl ?? "未知"}）\n`);

  process.stdout.write("[3/3] GET /rest/api/2/search?maxResults=1 ... ");
  const search = await getAuthedJson(config, "/rest/api/2/search?maxResults=1");
  const total = typeof search.total === "number" ? search.total : "未知";
  process.stdout.write(`OK（total=${total}）\n`);

  process.stdout.write("\n认证链路只读验证通过。\n");
}

main().catch((err) => {
  process.stderr.write(`\n验证失败：${err.message}\n`);
  process.exit(1);
});
