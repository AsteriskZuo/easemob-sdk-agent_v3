#!/usr/bin/env node
/**
 * Jira 字段调研脚本（只读，不落完整工单内容）
 *
 * 认证流程忠实移植自 src/jira/jira-client.ts（cookie 表单登录 + 网关 Basic auth）。
 * 配置读取顺序：环境变量 > APP_CONFIG_FILE 指向的文件 > 仓库根 .easemob-agent/config.json。
 *
 * 用法：
 *   node jira-field-research.mjs fields
 *       拉取全量字段定义（GET /rest/api/2/field），保存 field-definitions.json。
 *
 *   node jira-field-research.mjs sample [--project HIM] [--count 30] [--jql "..."] [--tag bug]
 *       按 updated DESC 抽样工单（search fields=*all，单请求），输出聚合统计：
 *       各字段非空率/值类型、issuetype/priority/status 分布、附件与评论概况、
 *       叙述字段长度分布；并对叙述字段做模板识别：以众数值为默认模板，
 *       统计完全等于模板的比例和“剥离模板行后的剩余内容长度”。
 *       结果保存 sample-field-stats[-tag].json（只含聚合数据与模板文本，不含完整工单内容）。
 *
 *   node jira-field-research.mjs inspect <ISSUE_KEY> [--baseline 15]
 *       单工单重复性验证：先从该项目最近工单现场学出各叙述字段的默认模板（众数），
 *       再对目标工单做逐字段分析——叙述字段给出去模板后的真实内容，
 *       HIM缺陷内容给到逐模板区块的填充情况，附件/评论只取元数据与正文。
 *       结果保存 runs/<ISSUE_KEY>.json（覆盖写，可反复运行对比）。
 *
 *   node jira-field-research.mjs titles [--jql "..."] [--count 100]
 *       拉取工单标题+模块清单（默认 HIM 最近 100 个 Bug），用于场景分类研究。
 *       只在控制台输出，不落盘。
 */
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

const REQUEST_TIMEOUT_MS = 60000;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

async function main() {
  const command = process.argv[2];
  if (command === "fields") {
    await runFields();
    return;
  }
  if (command === "sample") {
    const project = readFlag("--project") ?? "HIM";
    const count = Number.parseInt(readFlag("--count") ?? "30", 10);
    if (!Number.isFinite(count) || count <= 0 || count > 200) {
      throw new SafeError("--count must be an integer between 1 and 200");
    }
    await runSample({
      project,
      count,
      jqlOverride: readFlag("--jql"),
      tag: readFlag("--tag"),
    });
    return;
  }
  if (command === "titles") {
    const jql =
      readFlag("--jql") ??
      'project = "HIM" AND issuetype = Bug ORDER BY updated DESC';
    const count = Number.parseInt(readFlag("--count") ?? "100", 10);
    if (!Number.isFinite(count) || count <= 0 || count > 500) {
      throw new SafeError("--count must be an integer between 1 and 500");
    }
    await runTitles(jql, count);
    return;
  }
  if (command === "inspect") {
    const issueKey = process.argv[3];
    if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(issueKey)) {
      throw new SafeError("Usage: node jira-field-research.mjs inspect HIM-22543 [--baseline 15]");
    }
    const baseline = Number.parseInt(readFlag("--baseline") ?? "15", 10);
    if (!Number.isFinite(baseline) || baseline <= 0 || baseline > 100) {
      throw new SafeError("--baseline must be an integer between 1 and 100");
    }
    await runInspect(issueKey.toUpperCase(), baseline);
    return;
  }
  throw new SafeError(
    "Usage: node jira-field-research.mjs fields | sample [...] | inspect <ISSUE_KEY> [--baseline 15] | titles [--jql \"...\"] [--count 100]",
  );
}

async function runTitles(jql, count) {
  const client = new JiraResearchClient(await readJiraConfig());
  const search = await client.getJson("/rest/api/2/search", {
    jql,
    maxResults: String(count),
    fields: "summary,components",
  });
  if (!Array.isArray(search?.issues)) {
    throw new SafeError("Unexpected search response shape");
  }
  console.log(`JQL: ${jql} | 匹配 ${search.total ?? "?"}，取 ${search.issues.length}`);
  console.log("");
  for (const issue of search.issues) {
    const components = (Array.isArray(issue.fields?.components)
      ? issue.fields.components
      : []
    )
      .map((c) => c?.name)
      .filter(Boolean)
      .join("/");
    console.log(
      `${issue.key}\t[${components || "-"}]\t${issue.fields?.summary ?? ""}`,
    );
  }
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function runFields() {
  const client = new JiraResearchClient(await readJiraConfig());
  const definitions = await client.getJson("/rest/api/2/field");
  if (!Array.isArray(definitions)) {
    throw new SafeError("Unexpected /field response shape");
  }

  const output = {
    collectedAt: new Date().toISOString(),
    total: definitions.length,
    definitions,
  };
  const file = resolve(here, "field-definitions.json");
  await writeFile(file, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const custom = definitions.filter((d) => d.custom);
  const system = definitions.filter((d) => !d.custom);
  console.log(`字段总数: ${definitions.length}（系统 ${system.length} / 自定义 ${custom.length}）`);
  console.log("");
  console.log("自定义字段清单（id | 名称 | schema.type）:");
  for (const d of custom.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${d.id} | ${d.name} | ${d.schema?.type ?? "?"}`);
  }
  console.log(`\nJSON: ${file}`);
}

async function runSample({ project, count, jqlOverride, tag }) {
  const client = new JiraResearchClient(await readJiraConfig());
  const jql =
    jqlOverride ??
    `project = "${project.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" ORDER BY updated DESC`;

  const [definitions, search] = await Promise.all([
    client.getJson("/rest/api/2/field"),
    client.getJson("/rest/api/2/search", {
      jql,
      maxResults: String(count),
      fields: "*all",
    }),
  ]);
  if (!Array.isArray(definitions) || !Array.isArray(search?.issues)) {
    throw new SafeError("Unexpected Jira response shape");
  }

  const namesById = new Map(definitions.map((d) => [d.id, d.name ?? d.id]));
  const customById = new Map(definitions.map((d) => [d.id, Boolean(d.custom)]));

  const stats = createStats();
  for (const issue of search.issues) {
    consumeIssue(stats, issue, namesById, customById);
  }
  const result = finalizeStats(stats, {
    project,
    jql,
    requested: count,
    totalMatching: typeof search.total === "number" ? search.total : null,
    sampled: search.issues.length,
  });

  const file = resolve(
    here,
    tag ? `sample-field-stats-${tag}.json` : "sample-field-stats.json",
  );
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printSampleSummary(result);
  console.log(`\nJSON: ${file}`);
}

/* ---------------- 单工单验证（inspect） ---------------- */

async function runInspect(issueKey, baselineCount) {
  const client = new JiraResearchClient(await readJiraConfig());
  const project = issueKey.split("-")[0];
  const narrativeIds = [...NARRATIVE_ANALYSIS_FIELDS];

  // 现场学模板：取该项目最近工单，各叙述字段的众数值视为默认模板
  const baseline = await client.getJson("/rest/api/2/search", {
    jql: `project = "${project}" ORDER BY updated DESC`,
    maxResults: String(baselineCount),
    fields: narrativeIds.join(","),
  });
  const modes = learnModes(baseline?.issues ?? []);

  const issue = await client.getJson(
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
  );
  if (!issue?.fields || typeof issue.fields !== "object") {
    throw new SafeError(`Issue ${issueKey} not found or invalid response`);
  }

  const report = buildInspectReport(issue, modes, baseline?.issues?.length ?? 0);
  const runsDir = resolve(here, "runs");
  await mkdir(runsDir, { recursive: true });
  const file = resolve(runsDir, `${issueKey.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  printInspectReport(report);
  console.log(`\nJSON: ${file}`);
}

function learnModes(issues) {
  const valuesByField = new Map();
  for (const issue of issues) {
    const fields = issue?.fields ?? {};
    for (const id of NARRATIVE_ANALYSIS_FIELDS) {
      const value = fields[id];
      if (typeof value !== "string" || value.trim().length === 0) {
        continue;
      }
      let list = valuesByField.get(id);
      if (!list) {
        list = [];
        valuesByField.set(id, list);
      }
      list.push(value);
    }
  }

  const modes = new Map();
  for (const [id, values] of valuesByField.entries()) {
    const byNorm = new Map();
    for (const raw of values) {
      const norm = normalizeText(raw);
      const entry = byNorm.get(norm) ?? { count: 0, raw };
      entry.count += 1;
      byNorm.set(norm, entry);
    }
    const [norm, mode] = [...byNorm.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    modes.set(id, {
      norm,
      raw: mode.raw,
      count: mode.count,
      total: values.length,
      // 众数命中 >=3 才认为是共享模板，否则视为无模板基线
      reliable: mode.count >= 3,
    });
  }
  return modes;
}

const INSPECT_CONTEXT_FIELDS = [
  "issuetype",
  "status",
  "priority",
  "resolution",
  "components",
  "labels",
  "fixVersions",
  "reporter",
  "creator",
  "assignee",
  "created",
  "updated",
  "customfield_10306",
];

function buildInspectReport(issue, modes, baselineSampled) {
  const fields = issue.fields;

  const context = {};
  for (const id of INSPECT_CONTEXT_FIELDS) {
    context[id] = simplifyValue(fields[id]);
  }

  const attachments = (Array.isArray(fields.attachment) ? fields.attachment : []).map(
    (item) => ({
      filename: item?.filename ?? null,
      mimeType: item?.mimeType ?? null,
      size: item?.size ?? null,
      created: item?.created ?? null,
      author: item?.author?.displayName ?? item?.author?.name ?? null,
    }),
  );

  const comments = (Array.isArray(fields.comment?.comments)
    ? fields.comment.comments
    : []
  ).map((item) => ({
    author: item?.author?.displayName ?? item?.author?.name ?? null,
    created: item?.created ?? null,
    body: typeof item?.body === "string" ? item.body : "",
  }));

  const narratives = {};
  for (const id of NARRATIVE_ANALYSIS_FIELDS) {
    const value = fields[id];
    if (typeof value !== "string" || value.trim().length === 0) {
      narratives[id] = { state: "empty" };
      continue;
    }
    const mode = modes.get(id);
    const hasBaseline = Boolean(mode?.reliable);
    const analysis = hasBaseline
      ? analyzeAgainstTemplate(value, mode.raw)
      : {
          exactTemplate: false,
          strippedChars: value.trim().length,
          strippedText: value.trim(),
          sections: undefined,
        };
    narratives[id] = {
      state: "filled",
      templateBaseline: hasBaseline
        ? { hits: mode.count, of: mode.total }
        : null,
      ...analysis,
      raw: value,
    };
  }

  return {
    issueKey: typeof issue.key === "string" ? issue.key : "",
    fetchedAt: new Date().toISOString(),
    baselineSampled,
    context,
    summary: typeof fields.summary === "string" ? fields.summary : "",
    narratives,
    attachments,
    comments,
  };
}

/** 用模板全文做逐行比对：标签行取值、模板行剔除、自由行归属到模板区块 */
function analyzeAgainstTemplate(value, templateRaw) {
  const templateLines = templateRaw.split(/\r?\n/).map((line) => line.trim());
  const templateLineSet = new Set(templateLines.filter(Boolean));
  const templateSections = parseTemplateSections(templateLines);
  const labelByPrefix = new Map();
  for (const section of templateSections) {
    for (const label of section.labels) {
      labelByPrefix.set(label.prefix, { section: section.title, hint: label.hint });
    }
  }

  const sectionResults = new Map(
    templateSections.map((section) => [
      section.title,
      { labels: [], freeLines: [] },
    ]),
  );
  const unmatchedLines = [];
  let currentSection = null;

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const sectionMatch = line.match(/^【(.+)】$/);
    if (sectionMatch) {
      currentSection = `【${sectionMatch[1]}】`;
      if (!sectionResults.has(currentSection)) {
        sectionResults.set(currentSection, { labels: [], freeLines: [] });
      }
      continue;
    }
    if (templateLineSet.has(line)) {
      continue;
    }

    const labelMatch = matchLabelLine(line, labelByPrefix);
    if (labelMatch) {
      const bucket = sectionResults.get(labelMatch.section);
      bucket.labels.push({ prefix: labelMatch.prefix, value: labelMatch.value });
      continue;
    }

    if (currentSection && sectionResults.has(currentSection)) {
      sectionResults.get(currentSection).freeLines.push(line);
    } else {
      unmatchedLines.push(line);
    }
  }

  const sections = [...sectionResults.entries()].map(([title, result]) => {
    const labelChars = result.labels.reduce((sum, item) => sum + item.value.length, 0);
    const freeChars = result.freeLines.join("").length;
    return {
      title,
      labels: result.labels,
      freeContent: result.freeLines.join("\n"),
      contentChars: labelChars + freeChars,
      filled: result.labels.length > 0 || freeChars >= 5,
    };
  });

  const strippedParts = [];
  for (const section of sections) {
    for (const item of section.labels) {
      strippedParts.push(`${item.prefix}：${item.value}`);
    }
    if (section.freeContent) {
      strippedParts.push(section.freeContent);
    }
  }
  strippedParts.push(...unmatchedLines);
  const strippedText = strippedParts.join("\n");
  const strippedChars = strippedText.replace(/\s/g, "").length;

  return {
    exactTemplate: normalizeText(value) === normalizeText(templateRaw),
    strippedChars,
    strippedText,
    sections,
    unmatchedLines,
  };
}

function parseTemplateSections(templateLines) {
  const sections = [];
  let current = null;
  for (const line of templateLines) {
    if (!line) {
      continue;
    }
    const sectionMatch = line.match(/^【(.+)】$/);
    if (sectionMatch) {
      current = { title: `【${sectionMatch[1]}】`, labels: [], instructionLines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const colonIndex = line.search(/[:：]/);
    if (colonIndex > 0 && colonIndex <= 20) {
      current.labels.push({
        prefix: line.slice(0, colonIndex).trim(),
        hint: line.slice(colonIndex + 1).trim(),
      });
    } else {
      current.instructionLines.push(line);
    }
  }
  return sections;
}

function matchLabelLine(line, labelByPrefix) {
  for (const [prefix, meta] of labelByPrefix.entries()) {
    for (const colon of ["：", ":"]) {
      if (line.startsWith(`${prefix}${colon}`)) {
        const value = line.slice(prefix.length + colon.length).trim();
        if (value.length > 0 && value !== meta.hint) {
          return { prefix, value, section: meta.section };
        }
        return null; // 标签存在但无内容（等于提示语或为空），不算填充
      }
    }
  }
  return null;
}

function simplifyValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(simplifyValue);
  }
  if (typeof value === "object") {
    return value.displayName ?? value.name ?? value.value ?? value.key ?? null;
  }
  return null;
}

function printInspectReport(report) {
  const { context } = report;
  console.log(`工单 ${report.issueKey}（基线样本 ${report.baselineSampled} 个）`);
  console.log(
    `类型 ${context.issuetype ?? "?"} | 状态 ${context.status ?? "?"} | 优先级 ${context.priority ?? "?"} | 模块 ${(context.components ?? []).join("/") || "(空)"} | Epic Link ${context.customfield_10306 ?? "(空)"}`,
  );
  console.log(
    `reporter ${context.reporter ?? "?"} | assignee ${context.assignee ?? "?"} | created ${context.created ?? "?"} | updated ${context.updated ?? "?"}`,
  );
  console.log(`summary: ${report.summary}`);
  console.log(
    `附件 ${report.attachments.length} 个${report.attachments.length ? `（${report.attachments.map((a) => `${a.filename} [${a.mimeType}]`).join("; ")}）` : ""} | 评论 ${report.comments.length} 条`,
  );
  console.log("");
  console.log("叙述字段分析:");
  for (const [id, item] of Object.entries(report.narratives)) {
    if (item.state === "empty") {
      console.log(`  ${id}: 空/未填写`);
      continue;
    }
    const baseline = item.templateBaseline
      ? `模板基线命中 ${item.templateBaseline.hits}/${item.templateBaseline.of}`
      : "无模板基线";
    console.log(
      `  ${id}: exactTemplate=${item.exactTemplate} | 去模板后 ${item.strippedChars} 字符 | ${baseline}`,
    );
    if (item.sections) {
      for (const section of item.sections) {
        const mark = section.filled ? "✓" : "✗";
        const labelText = section.labels
          .map((l) => `${l.prefix}=${truncate(l.value, 30)}`)
          .join("; ");
        console.log(
          `    ${mark} ${section.title} (${section.contentChars} 字符)${labelText ? ` | ${labelText}` : ""}`,
        );
      }
    }
    if (item.strippedText) {
      console.log(`    去模板内容预览: ${truncate(item.strippedText.replace(/\n/g, " ⏎ "), 200)}`);
    }
  }
  if (report.comments.length > 0) {
    console.log("");
    console.log("评论预览（最新 3 条）:");
    for (const comment of report.comments.slice(-3)) {
      console.log(
        `  [${comment.created ?? "?"}] ${comment.author ?? "?"}: ${truncate(comment.body.replace(/\s+/g, " "), 120)}`,
      );
    }
  }
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/* ---------------- 聚合统计 ---------------- */

const NARRATIVE_FIELDS = new Set([
  "summary",
  "description",
  "environment",
  "customfield_11901",
  "customfield_11906",
]);

/** 需要做“默认模板 vs 人工内容”分析的叙述字段 */
const NARRATIVE_ANALYSIS_FIELDS = new Set([
  "description",
  "customfield_11900",
  "customfield_11901",
  "customfield_11906",
  "customfield_11908",
]);

/** 剥离模板行后，剩余内容达到该字符数才视为“有人工填写内容” */
const MIN_CONTENT_CHARS = 30;

const TEMPLATE_EXACT_PATTERNS = [
  /^\s*待补充\s*$/i,
  /^\s*n\/?a\s*$/i,
  /^\s*none\s*$/i,
  /^\s*无\s*$/i,
  /^\s*暂无\s*$/i,
  /^\s*tbd\s*$/i,
  /^\s*[-/]\s*$/,
];

const HEADING_LINE_PATTERN =
  /^\s*(h[1-6]\.\s*.+|#{1,6}\s+.+|\*\*[^*]+\*\*\s*|\*[^*]+\*\s*|【[^】]*】\s*|\[[^\]]{1,40}\]\s*|[^:：\s]{1,30}[:：]\s*)$/;

function createStats() {
  return {
    issueKeys: [],
    distributions: {
      issuetype: new Map(),
      priority: new Map(),
      status: new Map(),
      resolution: new Map(),
    },
    attachments: {
      issuesWith: 0,
      total: 0,
      mimeTypes: new Map(),
    },
    comments: { issuesWith: 0, totalComments: 0, max: 0 },
    fields: new Map(),
    narrativeValues: new Map(),
    perType: new Map(),
  };
}

function consumeIssue(stats, issue, namesById, customById) {
  const key = typeof issue?.key === "string" ? issue.key : "";
  if (key) {
    stats.issueKeys.push(key);
  }
  const fields = issue?.fields && typeof issue.fields === "object" ? issue.fields : {};

  const issueType = fields.issuetype?.name ?? "(empty)";
  bump(stats.distributions.issuetype, issueType);

  let typeEntry = stats.perType.get(issueType);
  if (!typeEntry) {
    typeEntry = { count: 0, narrativePresent: new Map() };
    stats.perType.set(issueType, typeEntry);
  }
  typeEntry.count += 1;

  for (const id of NARRATIVE_ANALYSIS_FIELDS) {
    const value = fields[id];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    bump(typeEntry.narrativePresent, id);
    let values = stats.narrativeValues.get(id);
    if (!values) {
      values = [];
      stats.narrativeValues.set(id, values);
    }
    values.push({ issueType, norm: normalizeText(value), raw: value });
  }

  bump(stats.distributions.priority, fields.priority?.name ?? "(empty)");
  bump(stats.distributions.status, fields.status?.name ?? "(empty)");
  bump(stats.distributions.resolution, fields.resolution?.name ?? "(unresolved)");

  const commentList = Array.isArray(fields.comment?.comments)
    ? fields.comment.comments
    : [];
  if (commentList.length > 0) {
    stats.comments.issuesWith += 1;
  }
  stats.comments.totalComments += commentList.length;
  stats.comments.max = Math.max(stats.comments.max, commentList.length);

  const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
  if (attachments.length > 0) {
    stats.attachments.issuesWith += 1;
    stats.attachments.total += attachments.length;
    for (const item of attachments) {
      bump(stats.attachments.mimeTypes, item?.mimeType ?? "unknown");
    }
  }

  for (const [id, value] of Object.entries(fields)) {
    let entry = stats.fields.get(id);
    if (!entry) {
      entry = {
        id,
        name: namesById.get(id) ?? id,
        custom: customById.get(id) ?? id.startsWith("customfield_"),
        present: 0,
        empty: 0,
        templateOnly: 0,
        kinds: new Map(),
        stringLengths: [],
        headingLines: new Map(),
      };
      stats.fields.set(id, entry);
    }

    const kind = detectValueKind(value);
    bump(entry.kinds, kind);

    if (kind === "comments") {
      // comment 对象的“有值”按评论数判断
      if (commentList.length > 0) {
        entry.present += 1;
      } else {
        entry.empty += 1;
      }
      continue;
    }

    if (isEmptyValue(value)) {
      entry.empty += 1;
      continue;
    }
    entry.present += 1;

    if (typeof value === "string") {
      entry.stringLengths.push(value.length);
      if (NARRATIVE_FIELDS.has(id)) {
        if (isTemplateOnly(value)) {
          entry.templateOnly += 1;
        }
        if (id === "customfield_11901") {
          for (const line of value.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed && HEADING_LINE_PATTERN.test(trimmed) && trimmed.length <= 40) {
              bump(entry.headingLines, trimmed);
            }
          }
        }
      }
    }
  }
}

function finalizeStats(stats, meta) {
  const fields = [...stats.fields.values()]
    .map((entry) => {
      const lengths = entry.stringLengths.sort((a, b) => a - b);
      const result = {
        id: entry.id,
        name: entry.name,
        custom: entry.custom,
        present: entry.present,
        empty: entry.empty,
        templateOnly: entry.templateOnly,
        kinds: Object.fromEntries(entry.kinds),
      };
      if (lengths.length > 0) {
        result.stringLength = {
          min: lengths[0],
          p50: percentile(lengths, 0.5),
          p90: percentile(lengths, 0.9),
          max: lengths[lengths.length - 1],
        };
      }
      if (entry.headingLines.size > 0) {
        result.headingSkeleton = [...entry.headingLines.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([line, count]) => ({ line, count }));
      }
      return result;
    })
    .sort((a, b) => b.present - a.present || a.id.localeCompare(b.id));

  return {
    sampledAt: new Date().toISOString(),
    ...meta,
    issueKeys: stats.issueKeys,
    narrativeAnalysis: analyzeNarratives(stats),
    perIssueType: Object.fromEntries(
      [...stats.perType.entries()].map(([type, entry]) => [
        type,
        {
          count: entry.count,
          narrativePresent: Object.fromEntries(entry.narrativePresent),
        },
      ]),
    ),
    distributions: {
      issuetype: Object.fromEntries(stats.distributions.issuetype),
      priority: Object.fromEntries(stats.distributions.priority),
      status: Object.fromEntries(stats.distributions.status),
      resolution: Object.fromEntries(stats.distributions.resolution),
    },
    attachments: {
      issuesWith: stats.attachments.issuesWith,
      total: stats.attachments.total,
      mimeTypes: Object.fromEntries(stats.attachments.mimeTypes),
    },
    comments: stats.comments,
    fields,
  };
}

/**
 * 叙述字段模板分析：以众数为默认模板，统计完全命中模板的比例、
 * 剥离模板行后的剩余内容长度分布，以及按 issuetype 的使用矩阵。
 */
function analyzeNarratives(stats) {
  const result = {};
  for (const [id, values] of stats.narrativeValues.entries()) {
    if (values.length === 0) {
      continue;
    }

    const byNorm = new Map();
    for (const value of values) {
      let entry = byNorm.get(value.norm);
      if (!entry) {
        entry = { count: 0, raw: value.raw, norm: value.norm };
        byNorm.set(value.norm, entry);
      }
      entry.count += 1;
    }
    const mode = [...byNorm.values()].sort((a, b) => b.count - a.count)[0];
    const templateLines = new Set(
      mode.raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );

    const strippedLengths = [];
    let exactTemplate = 0;
    let hasContent = 0;
    const perTypeMatrix = new Map();
    for (const value of values) {
      const stripped = value.raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !templateLines.has(line));
      const strippedChars = stripped.reduce((sum, line) => sum + line.length, 0);
      strippedLengths.push(strippedChars);
      if (value.norm === mode.norm) {
        exactTemplate += 1;
      }
      if (strippedChars >= MIN_CONTENT_CHARS) {
        hasContent += 1;
      }
      let typeRow = perTypeMatrix.get(value.issueType);
      if (!typeRow) {
        typeRow = { present: 0, exactTemplate: 0, hasContent: 0 };
        perTypeMatrix.set(value.issueType, typeRow);
      }
      typeRow.present += 1;
      if (value.norm === mode.norm) {
        typeRow.exactTemplate += 1;
      }
      if (strippedChars >= MIN_CONTENT_CHARS) {
        typeRow.hasContent += 1;
      }
    }
    strippedLengths.sort((a, b) => a - b);

    result[id] = {
      present: values.length,
      exactTemplate,
      hasContent,
      strippedChars: {
        min: strippedLengths[0],
        p50: percentile(strippedLengths, 0.5),
        p90: percentile(strippedLengths, 0.9),
        max: strippedLengths[strippedLengths.length - 1],
      },
      modeCount: mode.count,
      // 众数命中次数太低时可能是真实用户内容，不落盘
      modePreview:
        mode.count >= 3
          ? mode.raw.slice(0, 800)
          : "(withheld: mode count < 3, may be user content)",
      perIssueType: Object.fromEntries(perTypeMatrix),
    };
  }
  return result;
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function printSampleSummary(result) {
  console.log(
    `JQL: ${result.jql} | 匹配 ${result.totalMatching ?? "?"} 个，抽样 ${result.sampled} 个`,
  );
  console.log("");
  console.log("issuetype 分布:", JSON.stringify(result.distributions.issuetype));
  console.log("priority 分布:", JSON.stringify(result.distributions.priority));
  console.log("status 分布:", JSON.stringify(result.distributions.status));
  console.log(
    `附件: ${result.attachments.issuesWith}/${result.sampled} 个工单有附件，共 ${result.attachments.total} 个`,
  );
  console.log(
    `评论: ${result.comments.issuesWith}/${result.sampled} 个工单有评论，最多 ${result.comments.max} 条`,
  );
  console.log("");
  console.log("关键字段（present/抽样数, templateOnly, 长度 p50）:");
  const keysOfInterest = [
    "issuetype",
    "summary",
    "description",
    "environment",
    "customfield_10306",
    "customfield_11901",
    "customfield_11906",
    "comment",
    "attachment",
    "priority",
    "components",
    "labels",
    "versions",
    "fixVersions",
  ];
  for (const id of keysOfInterest) {
    const field = result.fields.find((f) => f.id === id);
    if (!field) {
      console.log(`  ${id} (${id}) | 未出现在抽样数据中`);
      continue;
    }
    const p50 = field.stringLength ? `p50=${field.stringLength.p50}` : "-";
    console.log(
      `  ${field.id} (${field.name}) | present ${field.present}/${result.sampled} | templateOnly ${field.templateOnly} | ${p50} | kinds=${JSON.stringify(field.kinds)}`,
    );
  }
  const him = result.fields.find((f) => f.id === "customfield_11901");
  if (him?.headingSkeleton?.length) {
    console.log("");
    console.log("customfield_11901 模板骨架（高频模板行）:");
    for (const item of him.headingSkeleton.slice(0, 15)) {
      console.log(`  [${item.count}] ${item.line}`);
    }
  }

  console.log("");
  console.log("叙述字段模板分析（present/exactTemplate/hasContent, 剥离模板后 p50 字符）:");
  for (const [id, analysis] of Object.entries(result.narrativeAnalysis)) {
    console.log(
      `  ${id} | present ${analysis.present} | 完全模板 ${analysis.exactTemplate} | 有人工内容 ${analysis.hasContent} | stripped p50=${analysis.strippedChars.p50} (min=${analysis.strippedChars.min}, p90=${analysis.strippedChars.p90}, max=${analysis.strippedChars.max}) | 众数命中 ${analysis.modeCount}`,
    );
  }
  console.log("");
  console.log("issuetype × 叙述字段使用矩阵（present/hasContent）:");
  const narrativeIds = Object.keys(result.narrativeAnalysis);
  for (const [type, row] of Object.entries(result.perIssueType)) {
    const cells = narrativeIds
      .map((id) => {
        const m = result.narrativeAnalysis[id].perIssueType[type];
        return m ? `${id.replace("customfield_", "cf")}=${m.present}/${m.hasContent}` : null;
      })
      .filter(Boolean)
      .join(" ");
    console.log(`  ${type} (${row.count}): ${cells || "(无叙述字段填写)"}`);
  }
}

/* ---------------- 值形态判断 ---------------- */

function detectValueKind(value) {
  if (value === null || value === undefined) {
    return "empty";
  }
  if (typeof value === "string") {
    return value.trim().length === 0 ? "empty" : "string";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isAttachmentLike)) {
      return "attachments";
    }
    return "array";
  }
  if (typeof value === "object") {
    if (Array.isArray(value.comments)) {
      return "comments";
    }
    if (typeof value.name === "string") {
      return "named";
    }
    if (typeof value.value === "string") {
      return "option";
    }
    return "object";
  }
  return "unknown";
}

function isAttachmentLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (typeof value.filename === "string" || typeof value.mimeType === "string"),
  );
}

function isEmptyValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function isTemplateOnly(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (TEMPLATE_EXACT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const lines = value.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => HEADING_LINE_PATTERN.test(line.trim()));
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function percentile(sorted, ratio) {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

/* ---------------- Jira 访问（移植自 src/jira/jira-client.ts） ---------------- */

async function readJiraConfig() {
  const candidates = [];
  if (process.env.APP_CONFIG_FILE) {
    candidates.push(resolve(process.cwd(), process.env.APP_CONFIG_FILE));
  }
  candidates.push(resolve(process.cwd(), ".easemob-agent/config.json"));
  candidates.push(resolve(repoRoot, ".easemob-agent/config.json"));

  let fileConfig = {};
  for (const file of candidates) {
    if (existsSync(file)) {
      fileConfig = JSON.parse(await readFile(file, "utf8"));
      break;
    }
  }

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
    try {
      return JSON.parse(response.body);
    } catch {
      throw new SafeError("Jira returned an invalid JSON response");
    }
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
        const followed = await this.fetchText(
          new URL(location, form.actionUrl).toString(),
          { Cookie: this.cookieHeader() },
        );
        if (!followed.ok) {
          throw new SafeError(`Jira login redirect failed: HTTP_${followed.status}`);
        }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: withoutEmptyHeaders({
          ...gatewayHeaders(this.config),
          ...headers,
        }),
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      this.storeCookies(response.headers);
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        headers: response.headers,
        body: await response.text(),
      };
    } catch {
      throw new SafeError("Failed to connect to Jira");
    } finally {
      clearTimeout(timeout);
    }
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
      return formMatch;
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
  const remoteUser = response.body.match(
    /<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i,
  );
  if (remoteUser) {
    return remoteUser[1].trim() === "";
  }
  const lowered = response.body.toLowerCase();
  return lowered.includes("log in - easemob jira") || lowered.includes('name="os_username"');
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

function withoutEmptyHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== ""),
  );
}

class SafeError extends Error {}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
