#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const defaultConfigPath = '/Users/asterisk/Codes/ai/easemob-sdk-agent/.easemob-agent/config.json';

const defaultFields = [
  'summary',
  'status',
  'assignee',
  'reporter',
  'updated',
  'created',
  'priority',
  'issuetype',
  'project'
];

function parseArgs(argv) {
  const options = {
    assignees: [],
    projects: [],
    since: undefined,
    maxResults: 50,
    dryRun: false,
    unresolvedOnly: false,
    configPath: defaultConfigPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--unresolved-only') {
      options.unresolvedOnly = true;
      continue;
    }
    if (arg === '--assignee') {
      options.assignees.push(requireValue(arg, next));
      index += 1;
      continue;
    }
    if (arg === '--project') {
      options.projects.push(requireValue(arg, next));
      index += 1;
      continue;
    }
    if (arg === '--since') {
      options.since = requireValue(arg, next);
      index += 1;
      continue;
    }
    if (arg === '--max-results') {
      options.maxResults = Number.parseInt(requireValue(arg, next), 10);
      index += 1;
      continue;
    }
    if (arg === '--config') {
      options.configPath = requireValue(arg, next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.since) {
    throw new Error('--since is required, for example: --since "2026-07-11 00:00"');
  }
  if (!Number.isInteger(options.maxResults) || options.maxResults < 1) {
    throw new Error('--max-results must be a positive integer');
  }

  return options;
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  return {
    jiraUrl: requireConfig(config, 'TOOL__JIRA__URL'),
    username: requireConfig(config, 'TOOL__JIRA__USERNAME'),
    password: requireConfig(config, 'TOOL__JIRA__PASSWORD'),
    project: readConfig(config, 'TOOL__JIRA__PROJECT'),
    redirectUsername: readConfig(config, 'TOOL__JIRA__REDIRECT_USERNAME'),
    redirectPassword: readConfig(config, 'TOOL__JIRA__REDIRECT_PASSWORD')
  };
}

function readConfig(config, key) {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireConfig(config, key) {
  const value = readConfig(config, key);
  if (!value) {
    throw new Error(`${key} is missing in config`);
  }
  return value;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function quoteJqlValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function listClause(field, values) {
  if (values.length === 1) {
    return `${field} = ${quoteJqlValue(values[0])}`;
  }
  return `${field} in (${values.map(quoteJqlValue).join(', ')})`;
}

function buildJql(options) {
  const clauses = [];

  if (options.projects.length > 0) {
    clauses.push(listClause('project', options.projects));
  }

  clauses.push(listClause('assignee', options.assignees));

  if (options.unresolvedOnly) {
    clauses.push('resolution = Unresolved');
  }

  clauses.push(`updated >= ${quoteJqlValue(options.since)}`);

  return `${clauses.join(' AND ')} ORDER BY updated ASC, key ASC`;
}

function buildSearchBody(options) {
  return {
    jql: buildJql(options),
    startAt: 0,
    maxResults: options.maxResults,
    fields: defaultFields
  };
}

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function gatewayHeaders(config) {
  if (!config.redirectUsername || !config.redirectPassword) {
    return {};
  }
  return {
    Authorization: `Basic ${basicAuth(config.redirectUsername, config.redirectPassword)}`
  };
}

function cookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function storeCookies(cookies, headers) {
  for (const cookieHeaderValue of collectSetCookieHeaders(headers)) {
    const cookie = parseSetCookie(cookieHeaderValue);
    if (!cookie) {
      continue;
    }
    const existingIndex = cookies.findIndex((existing) => existing.name === cookie.name);
    if (existingIndex >= 0) {
      cookies.splice(existingIndex, 1, cookie);
    } else {
      cookies.push(cookie);
    }
  }
}

function collectSetCookieHeaders(headers) {
  const getSetCookie = headers.getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers);
  }

  const value = headers.get('set-cookie');
  if (!value) {
    return [];
  }
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function parseSetCookie(value) {
  const [pair] = value.split(';');
  const separator = pair.indexOf('=');
  if (separator <= 0) {
    return undefined;
  }
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim()
  };
}

function extractLoginForm(html, responseUrl) {
  const formMatch = findLoginForm(html) || html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i) || html.match(/<form\b[^>]*>/i);
  if (!formMatch) {
    return undefined;
  }

  const actionMatch = formMatch[0].match(/\saction=["']([^"']*)["']/i);
  const actionUrl = new URL(actionMatch?.[1] || '/login.jsp', responseUrl).toString();
  const hiddenFields = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = input.match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) {
      continue;
    }
    hiddenFields[name] = input.match(/\svalue=["']([^"']*)["']/i)?.[1] || '';
  }
  return { actionUrl, hiddenFields };
}

function findLoginForm(html) {
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const formMatch of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(formMatch[0])) {
      return formMatch;
    }
  }
  return undefined;
}

function isAnonymous(response, body) {
  const headerUser = response.headers.get('x-ausername')?.trim().toLowerCase();
  if (headerUser === 'anonymous') {
    return true;
  }
  if (headerUser) {
    return false;
  }

  const remoteUser = body.match(/<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i);
  if (remoteUser) {
    return remoteUser[1].trim() === '';
  }

  const lowered = body.toLowerCase();
  return lowered.includes('log in - easemob jira') || lowered.includes('name="os_username"');
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

async function fetchText(url, { method = 'GET', headers = {}, body, cookies = [] } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual'
  });
  storeCookies(cookies, response.headers);
  return { response, body: await response.text() };
}

async function authenticate(config, cookies) {
  const jiraUrl = config.jiraUrl.replace(/\/+$/, '');
  const loginPage = await fetchText(`${jiraUrl}/login.jsp`, {
    headers: gatewayHeaders(config),
    cookies
  });
  if (!loginPage.response.ok) {
    throw new Error(`Failed to load Jira login page: HTTP ${loginPage.response.status}`);
  }

  const form = extractLoginForm(loginPage.body, loginPage.response.url || `${jiraUrl}/login.jsp`);
  if (!form) {
    throw new Error('Jira login form was not found');
  }

  const payload = new URLSearchParams(form.hiddenFields);
  payload.set('os_username', config.username);
  payload.set('os_password', config.password);
  payload.set('os_cookie', 'true');
  if (!payload.get('os_destination')) {
    payload.set('os_destination', '/secure/Dashboard.jspa');
  }

  const loginPost = await fetchText(form.actionUrl, {
    method: 'POST',
    headers: {
      ...gatewayHeaders(config),
      Cookie: cookieHeader(cookies),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: payload.toString(),
    cookies
  });
  if (!loginPost.response.ok && !isRedirect(loginPost.response.status)) {
    throw new Error(`Jira login failed: HTTP ${loginPost.response.status}`);
  }

  if (isRedirect(loginPost.response.status)) {
    const location = loginPost.response.headers.get('location');
    if (location) {
      const redirected = await fetchText(new URL(location, form.actionUrl).toString(), {
        headers: {
          ...gatewayHeaders(config),
          Cookie: cookieHeader(cookies)
        },
        cookies
      });
      if (!redirected.response.ok) {
        throw new Error(`Jira login redirect failed: HTTP ${redirected.response.status}`);
      }
    }
  }

  const verify = await fetchText(`${jiraUrl}/secure/Dashboard.jspa`, {
    headers: {
      ...gatewayHeaders(config),
      Cookie: cookieHeader(cookies)
    },
    cookies
  });
  if (!verify.response.ok) {
    throw new Error(`Jira authentication verification failed: HTTP ${verify.response.status}`);
  }
  if (isAnonymous(verify.response, verify.body)) {
    throw new Error('Jira authentication failed: still anonymous after login');
  }
}

function summarizeIssue(issue) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    id: issue.id,
    summary: fields.summary,
    updated: fields.updated,
    status: fields.status?.name,
    assignee: fields.assignee?.name,
    reporter: fields.reporter?.name,
    priority: fields.priority?.name,
    issueType: fields.issuetype?.name,
    project: fields.project?.key
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  if (options.assignees.length === 0) {
    options.assignees.push(config.username);
  }
  if (options.projects.length === 0 && config.project) {
    options.projects.push(config.project);
  }

  const body = buildSearchBody(options);
  const jiraUrl = config.jiraUrl.replace(/\/+$/, '');
  const searchUrl = `${jiraUrl}/rest/api/2/search`;

  if (options.dryRun) {
    console.log(JSON.stringify({ searchUrl, body }, null, 2));
    return;
  }

  const cookies = [];
  await authenticate(config, cookies);

  const search = await fetchText(searchUrl, {
    method: 'POST',
    headers: {
      ...gatewayHeaders(config),
      Accept: 'application/json',
      Cookie: cookieHeader(cookies),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    cookies
  });

  if (!search.response.ok) {
    console.error(`Jira search failed: HTTP ${search.response.status}`);
    console.error(search.body);
    process.exitCode = 1;
    return;
  }

  const data = JSON.parse(search.body);
  const issues = Array.isArray(data.issues) ? data.issues : [];
  console.log(
    JSON.stringify(
      {
        startAt: data.startAt,
        maxResults: data.maxResults,
        total: data.total,
        returned: issues.length,
        issues: issues.map(summarizeIssue)
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
