#!/usr/bin/env node
// 调研脚本：枚举 HIM 项目 Jira status 字段的实际取值。
// 输出：1) 项目工作流配置的全部状态（/project/HIM/statuses）
//       2) HIM Bug 工单中实际出现的状态分布（JQL 分页统计）
// 认证方式与 fetch-jira-issue-fields.mjs 一致（表单登录 + 网关 Basic）。
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_KEYS = [
  "TOOL__JIRA__URL",
  "TOOL__JIRA__USERNAME",
  "TOOL__JIRA__PASSWORD",
  "TOOL__JIRA__REDIRECT_USERNAME",
  "TOOL__JIRA__REDIRECT_PASSWORD",
];

const PROJECT = process.argv[2] ?? "HIM";
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = await readJiraConfig();
  const client = new JiraResearchClient(config);

  const projectStatuses = await client.getJson(
    `/rest/api/2/project/${encodeURIComponent(PROJECT)}/statuses`,
  );

  const distribution = new Map();
  let startAt = 0;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.getJson("/rest/api/2/search", {
      jql: `project = ${PROJECT} AND issuetype = Bug`,
      fields: "status,resolution",
      maxResults: String(PAGE_SIZE),
      startAt: String(startAt),
    });
    total = result.total ?? 0;
    for (const issue of result.issues ?? []) {
      const status = issue.fields?.status?.name ?? "(empty)";
      const category = issue.fields?.status?.statusCategory?.name ?? "?";
      const resolution = issue.fields?.resolution?.name ?? "(unresolved)";
      const key = `${status} | ${category} | ${resolution}`;
      distribution.set(key, (distribution.get(key) ?? 0) + 1);
    }
    startAt += (result.issues ?? []).length;
    if (startAt >= total || (result.issues ?? []).length === 0) {
      break;
    }
  }

  const summary = {
    project: PROJECT,
    collectedAt: new Date().toISOString(),
    workflowStatuses: (Array.isArray(projectStatuses) ? projectStatuses : []).map(
      (issueType) => ({
        issueType: issueType.name,
        statuses: (issueType.statuses ?? []).map((s) => ({
          name: s.name,
          statusCategory: s.statusCategory?.name,
        })),
      }),
    ),
    bugStatusDistribution: {
      total,
      fetched: startAt,
      rows: [...distribution.entries()]
        .map(([key, count]) => {
          const [status, statusCategory, resolution] = key.split(" | ");
          return { status, statusCategory, resolution, count };
        })
        .sort((a, b) => b.count - a.count),
    },
  };

  const outputDir = resolve(here, "runs");
  await mkdir(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, `status-values-${PROJECT}.json`);
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`JSON: ${jsonPath}`);
  console.log(`\n== ${PROJECT} 工作流状态配置（按 issueType）==`);
  for (const it of summary.workflowStatuses) {
    console.log(`\n[${it.issueType}]`);
    for (const s of it.statuses) {
      console.log(`  - ${s.name} (${s.statusCategory ?? "?"})`);
    }
  }
  console.log(`\n== ${PROJECT} Bug 工单实际状态分布（共 ${total} 单，抓取 ${startAt} 单）==`);
  for (const row of summary.bugStatusDistribution.rows) {
    console.log(
      `  ${String(row.count).padStart(6)}  ${row.status}  [category=${row.statusCategory}] [resolution=${row.resolution}]`,
    );
  }
}

async function readJiraConfig() {
  const configFile = resolve(
    process.cwd(),
    process.env.APP_CONFIG_FILE ?? ".easemob-agent/config.json",
  );
  const fileConfig = existsSync(configFile)
    ? JSON.parse(await readFile(configFile, "utf8"))
    : {};

  const config = {};
  for (const key of CONFIG_KEYS) {
    const value = process.env[key] ?? fileConfig[key];
    if (typeof value === "string" && value.length > 0) {
      config[key] = value;
    }
  }

  const missing = CONFIG_KEYS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new SafeError(`Missing Jira config: ${missing.join(", ")}`);
  }

  return {
    jiraUrl: config.TOOL__JIRA__URL.replace(/\/+$/, ""),
    username: config.TOOL__JIRA__USERNAME,
    password: config.TOOL__JIRA__PASSWORD,
    redirectUsername: config.TOOL__JIRA__REDIRECT_USERNAME,
    redirectPassword: config.TOOL__JIRA__REDIRECT_PASSWORD,
  };
}

class JiraResearchClient {
  constructor(config) {
    this.config = config;
    this.cookies = new Map();
    this.authenticated = false;
  }

  async getJson(path, query = {}) {
    await this.ensureAuthenticated();
    const url = new URL(`${this.config.jiraUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchText(url.toString(), {
      Accept: "application/json",
      Cookie: this.cookieHeader(),
    });
    if (!response.ok) {
      throw new SafeError(`Jira request failed: HTTP_${response.status}`);
    }
    return JSON.parse(response.body);
  }

  async ensureAuthenticated() {
    if (this.authenticated) {
      return;
    }

    const loginPage = await this.fetchText(`${this.config.jiraUrl}/login.jsp`);
    if (!loginPage.ok) {
      throw new SafeError(`Jira login page failed: HTTP_${loginPage.status}`);
    }
    const form = extractLoginForm(
      loginPage.body,
      loginPage.url ?? `${this.config.jiraUrl}/login.jsp`,
    );
    if (!form) {
      throw new SafeError("Jira login form was not found");
    }

    const payload = new URLSearchParams(form.hiddenFields);
    payload.set("os_username", this.config.username);
    payload.set("os_password", this.config.password);
    payload.set("os_cookie", "true");
    if (!payload.get("os_destination")) {
      payload.set("os_destination", "/secure/Dashboard.jspa");
    }

    const loginPost = await this.fetchText(
      form.actionUrl,
      {
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      payload.toString(),
    );
    if (loginPost.status >= 300 && loginPost.status < 400) {
      const location = loginPost.headers.get("location");
      if (location) {
        await this.fetchText(new URL(location, form.actionUrl).toString(), {
          Cookie: this.cookieHeader(),
        });
      }
    } else if (!loginPost.ok) {
      throw new SafeError(`Jira login failed: HTTP_${loginPost.status}`);
    }

    const verify = await this.fetchText(
      `${this.config.jiraUrl}/secure/Dashboard.jspa`,
      { Cookie: this.cookieHeader() },
    );
    if (!verify.ok || isAnonymous(verify)) {
      throw new SafeError("Jira authentication failed");
    }
    this.authenticated = true;
  }

  async fetchText(url, headers = {}, body) {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...gatewayHeaders(this.config),
        ...headers,
      },
      body,
      redirect: "manual",
    });
    this.storeCookies(response.headers);
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: response.headers,
      body: await response.text(),
    };
  }

  storeCookies(headers) {
    for (const value of collectSetCookieHeaders(headers)) {
      const separator = value.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const name = value.slice(0, separator).trim();
      const cookieValue = value.slice(separator + 1).split(";", 1)[0].trim();
      this.cookies.set(name, cookieValue);
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function gatewayHeaders(config) {
  if (!config.redirectUsername || !config.redirectPassword) {
    return {};
  }
  return {
    Authorization: `Basic ${Buffer.from(
      `${config.redirectUsername}:${config.redirectPassword}`,
    ).toString("base64")}`,
  };
}

function extractLoginForm(html, responseUrl) {
  const formMatch =
    findLoginForm(html) ??
    html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*>/i);
  if (!formMatch) {
    return undefined;
  }

  const actionMatch = formMatch[0].match(/\saction=["']([^"']*)["']/i);
  const actionUrl = new URL(
    actionMatch?.[1] ?? "/login.jsp",
    responseUrl,
  ).toString();
  const hiddenFields = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = input.match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) {
      continue;
    }
    hiddenFields[name] = input.match(/\svalue=["']([^"']*)["']/i)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields };
}

function findLoginForm(html) {
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const formMatch of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(formMatch[0])) {
      return formMatch[0];
    }
  }
  return undefined;
}

function isAnonymous(response) {
  const headerUser = response.headers.get("x-ausername")?.trim().toLowerCase();
  if (headerUser === "anonymous") {
    return true;
  }
  if (headerUser) {
    return false;
  }
  return response.body.toLowerCase().includes('name="os_username"');
}

function collectSetCookieHeaders(headers) {
  const getSetCookie = headers.getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }
  const value = headers.get("set-cookie");
  if (!value) {
    return [];
  }
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

class SafeError extends Error {}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
