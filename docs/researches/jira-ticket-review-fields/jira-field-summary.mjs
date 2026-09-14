const USEFULNESS_BY_FIELD_ID = new Map([
  ["issuetype", "routing"],
  ["summary", "core_evidence"],
  ["description", "core_evidence"],
  ["environment", "core_evidence"],
  ["customfield_11901", "core_evidence"],
  ["comment", "supporting_evidence"],
  ["customfield_11906", "supporting_evidence"],
  ["customfield_10306", "context"],
  ["priority", "context"],
  ["components", "context"],
  ["labels", "context"],
  ["versions", "context"],
  ["fixVersions", "context"],
  ["status", "context"],
  ["resolution", "context"],
  ["project", "context"],
  ["reporter", "context"],
  ["assignee", "context"],
  ["created", "timeline"],
  ["updated", "timeline"],
  ["resolutiondate", "timeline"],
  ["attachment", "attachment_metadata"],
]);

const TEMPLATE_ONLY_PATTERNS = [
  /^\s*待补充\s*$/i,
  /^\s*n\/a\s*$/i,
  /^\s*none\s*$/i,
  /^\s*无\s*$/i,
  /^\s*暂无\s*$/i,
];

const MAX_PREVIEW_LENGTH = 1080;
const SELECTED_FIELD_IDS = [
  "issuetype",
  "summary",
  "description",
  "environment",
  "customfield_11901",
  "customfield_11906",
  "customfield_10306",
  "priority",
  "components",
  "labels",
  "versions",
  "fixVersions",
  "status",
  "resolution",
  "project",
  "reporter",
  "assignee",
  "created",
  "updated",
  "resolutiondate",
  "attachment",
];

export function summarizeIssueFields({ issue, fieldDefinitions }) {
  const fields = issue?.fields;
  if (!issue || typeof issue !== "object" || !fields || typeof fields !== "object") {
    throw new Error("issue.fields must be an object");
  }
  if (!Array.isArray(fieldDefinitions)) {
    throw new Error("fieldDefinitions must be an array");
  }

  const definitionsById = new Map(
    fieldDefinitions
      .filter(
        (definition) =>
          definition &&
          typeof definition === "object" &&
          typeof definition.id === "string",
      )
      .map((definition) => [definition.id, definition]),
    );

  return {
    issueKey: typeof issue.key === "string" ? issue.key : "",
    positioning:
      "本调研面向 Jira 工单审查：只判断工单是否说清楚、是否具备进入后续处理的最低信息；不分析根因，不下载或解析附件，不替代问题分析。",
    selectedFieldValues: selectedFieldValues(fields),
    comments: summarizeComments(fields.comment),
    fields: Object.entries(fields)
      .map(([id, value]) => summarizeField(id, value, definitionsById.get(id)))
      .sort(compareFieldSummary),
  };
}

export function renderMarkdownReport(summary) {
  const lines = [
    `# Jira 字段调研：${summary.issueKey}`,
    "",
    "## 定位",
    "",
    summary.positioning ??
      "本调研面向 Jira 工单审查：只判断工单是否说清楚、是否具备进入后续处理的最低信息；不分析根因，不下载或解析附件，不替代问题分析。",
    "",
    "附件处理边界：第一版只记录附件元信息，不下载、不读取、不分析附件内容。日志如有关键证据，需要提交人在工单正文或评论中摘录。",
    "",
    "## 字段摘要",
    "",
    "说明：本报告只展示字段摘要和短预览，不下载附件，也不输出完整长文本。",
    "",
    "| 字段 ID | 字段名 | 类型 | 空值 | 仅模板 | 价值分类 | 预览 |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const field of summary.fields) {
    lines.push(
      [
        field.id,
        field.name,
        field.valueKind,
        field.empty ? "是" : "否",
        field.templateOnly ? "是" : "否",
        field.usefulness,
        truncatePreview(field.preview),
      ]
        .map(escapeMarkdownCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }

  lines.push("");
  if (Array.isArray(summary.comments) && summary.comments.length > 0) {
    lines.push("## 评论摘要", "");
    lines.push("| 序号 | 作者 | 创建时间 | 更新时间 | 预览 |");
    lines.push("|---:|---|---|---|---|");
    for (const comment of summary.comments) {
      lines.push(
        [
          comment.index,
          comment.author,
          comment.created,
          comment.updated,
          truncatePreview(comment.preview),
        ]
          .map(escapeMarkdownCell)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function summarizeField(id, value, definition) {
  const valueKind = detectValueKind(value);
  const preview = buildPreview(value, valueKind);
  return {
    id,
    name: typeof definition?.name === "string" ? definition.name : id,
    valueKind,
    empty: isEmptyValue(value),
    templateOnly: isTemplateOnly(value),
    usefulness: USEFULNESS_BY_FIELD_ID.get(id) ?? "unknown",
    preview,
  };
}

function detectValueKind(value) {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isAttachmentLike)) {
      return "attachments";
    }
    return "array";
  }
  if (value === null || value === undefined) {
    return "empty";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (typeof value === "object") {
    if (typeof value.displayName === "string") {
      return "user";
    }
    if (typeof value.name === "string") {
      return "named";
    }
    if (Array.isArray(value.comments)) {
      return "comments";
    }
    return "object";
  }
  return "unknown";
}

function buildPreview(value, valueKind) {
  if (isEmptyValue(value)) {
    return "";
  }
  if (valueKind === "attachments") {
    return value.map(formatAttachment).join("; ");
  }
  if (valueKind === "named") {
    return value.name;
  }
  if (valueKind === "user") {
    return value.displayName;
  }
  if (valueKind === "comments") {
    return `${value.comments.length} comments`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => buildPreview(item, detectValueKind(item))).join(", ");
  }
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}

function selectedFieldValues(fields) {
  const result = {};
  for (const id of SELECTED_FIELD_IDS) {
    if (Object.prototype.hasOwnProperty.call(fields, id)) {
      result[id] = normalizeValue(fields[id]);
    }
  }
  return result;
}

function summarizeComments(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.comments)) {
    return [];
  }
  return value.comments.map((comment, index) => {
    const body = typeof comment.body === "string" ? comment.body : "";
    return {
      index: index + 1,
      author: readUserName(comment.author),
      created: typeof comment.created === "string" ? comment.created : "",
      updated: typeof comment.updated === "string" ? comment.updated : "",
      preview: body.replace(/\s+/g, " ").trim(),
      body,
    };
  });
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (!value || typeof value !== "object") {
    return value ?? null;
  }
  if (Array.isArray(value.comments)) {
    return {
      total: value.total ?? value.comments.length,
      comments: summarizeComments(value),
    };
  }
  if (typeof value.displayName === "string") {
    return {
      displayName: value.displayName,
      name: typeof value.name === "string" ? value.name : undefined,
      key: typeof value.key === "string" ? value.key : undefined,
    };
  }
  if (typeof value.name === "string") {
    return value.name;
  }
  if (isAttachmentLike(value)) {
    return {
      filename: typeof value.filename === "string" ? value.filename : "",
      mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
      size: typeof value.size === "number" ? value.size : null,
    };
  }
  return value;
}

function readUserName(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  return (
    (typeof value.displayName === "string" && value.displayName) ||
    (typeof value.name === "string" && value.name) ||
    (typeof value.key === "string" && value.key) ||
    ""
  );
}

function formatAttachment(value) {
  const filename = typeof value.filename === "string" ? value.filename : "unnamed";
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : "unknown";
  const size = typeof value.size === "number" ? value.size : 0;
  return `${filename} (${mimeType}, ${size} bytes)`;
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
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

function isTemplateOnly(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return TEMPLATE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function compareFieldSummary(left, right) {
  const leftRank = usefulnessRank(left.usefulness);
  const rightRank = usefulnessRank(right.usefulness);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.id.localeCompare(right.id);
}

function usefulnessRank(value) {
  return (
    {
      routing: 0,
      core_evidence: 1,
      supporting_evidence: 2,
      context: 3,
      timeline: 4,
      attachment_metadata: 5,
      unknown: 6,
    }[value] ?? 6
  );
}

function truncatePreview(value) {
  if (value.length <= MAX_PREVIEW_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
