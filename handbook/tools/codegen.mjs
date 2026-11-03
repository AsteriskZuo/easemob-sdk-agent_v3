#!/usr/bin/env node
/**
 * handbook codegen：content/**\/*.yaml → generated/**（镜像同构的 .md + .json）
 *
 * 单入口两段式：
 *   ① parse + validate（schema 校验 / ID 全局查重 / 引用检查，规则见 handbook/META.md §12）
 *   ② render-md（人看）+ render-json（控制台/程序消费）
 *
 * 用法：
 *   node handbook/tools/codegen.mjs           生成（写入 generated/，清理失源产物）
 *   node handbook/tools/codegen.mjs --check   校验（不写文件；源与产物不一致即报错，双向覆盖：
 *                                             源变了没重新生成 / 手改了生成物）
 * 退出码：有 error 为 1（warning 不阻断）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HANDBOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(HANDBOOK_DIR, "..");
const CONTENT_DIR = join(HANDBOOK_DIR, "content");
const GENERATED_DIR = join(HANDBOOK_DIR, "generated");

const KINDS = ["section", "field", "concept", "guide"];
const STATUSES = ["draft", "stable", "deprecated"];
const FIELD_TYPES = ["string", "number", "boolean", "object", "array"];
const DISPLAYS = ["tip", "drawer"];
const NAMESPACES = ["bizpkg", "console", "platform"];
const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const AT_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const KNOWN_ENTRY_KEYS = new Set([
  "id",
  "kind",
  "title",
  "body",
  "surfaces",
  "status",
  "related",
  "verify",
  "name",
  "type",
  "required",
]);

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

// ---------- ① parse ----------

function listYamlFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listYamlFiles(p));
    else if (e.isFile() && e.name.endsWith(".yaml")) out.push(p);
  }
  return out.sort();
}

function isLangMap(v) {
  return v && typeof v === "object" && !Array.isArray(v) && typeof v.cn === "string" && v.cn.trim() !== "";
}

/** surfaces 归一化为 [{ type: "doc"|"console", at, display? }] */
function normalizeSurface(where, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err(where, `surface 必须是单键对象（{ doc: ... } 或 { console: ... }），得到 ${JSON.stringify(raw)}`);
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || !["doc", "console"].includes(keys[0])) {
    err(where, `surface 有且仅有一个键（doc | console），得到 ${JSON.stringify(keys)}`);
    return null;
  }
  const type = keys[0];
  const value = raw[type];
  if (type === "doc") {
    if (typeof value !== "string" || value.trim() === "") {
      err(where, "doc surface 的值必须是非空字符串（页面路径，可带 #锚点）");
      return null;
    }
    return { type, at: value.trim() };
  }
  // console
  if (typeof value === "string") {
    if (!AT_PATTERN.test(value)) {
      err(where, `console surface 简写值 "${value}" 非法（应为 页面.区域 点分格式）`);
      return null;
    }
    return { type, at: value, display: "tip" };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const unknown = Object.keys(value).filter((k) => !["at", "display"].includes(k));
    if (unknown.length > 0) err(where, `console surface 含未知键：${unknown.join(", ")}`);
    if (typeof value.at !== "string" || !AT_PATTERN.test(value.at)) {
      err(where, `console surface 的 at "${value.at}" 非法（应为 页面.区域 点分格式）`);
      return null;
    }
    const display = value.display ?? "tip";
    if (!DISPLAYS.includes(display)) {
      err(where, `display "${display}" 非法（${DISPLAYS.join(" | ")}）`);
      return null;
    }
    return { type, at: value.at, display };
  }
  err(where, "console surface 的值必须是字符串或 { at, display } 对象");
  return null;
}

const files = listYamlFiles(CONTENT_DIR);
const allEntries = new Map(); // id -> { entry, file, surfaces(归一化) }

for (const file of files) {
  const rel = relative(HANDBOOK_DIR, file);
  const namespace = relative(CONTENT_DIR, file).split("/")[0];
  let doc;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    err(rel, `YAML 解析失败：${e.message}`);
    continue;
  }
  if (!doc || typeof doc !== "object") {
    err(rel, "文件内容必须是对象");
    continue;
  }
  if (doc.version !== 1) {
    err(rel, `version 必须为 1，得到 ${JSON.stringify(doc.version)}`);
    continue;
  }
  if (!Array.isArray(doc.entries)) {
    err(rel, "缺少 entries 数组");
    continue;
  }

  doc.entries.forEach((entry, i) => {
    const where = `${rel} → entries[${i}]${entry && entry.id ? ` (${entry.id})` : ""}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      err(where, "条目必须是对象");
      return;
    }
    for (const k of Object.keys(entry)) {
      if (!KNOWN_ENTRY_KEYS.has(k)) err(where, `未知字段 "${k}"（合法字段见 META.md §2）`);
    }
    // id
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
      err(where, `id "${entry.id}" 非法（小写点分、段内 kebab，如 bizpkg.contract.overview）`);
      return;
    }
    if (allEntries.has(entry.id)) {
      err(where, `id "${entry.id}" 与 ${allEntries.get(entry.id).file} 重复`);
      return;
    }
    if (!entry.id.startsWith(`${namespace}.`)) {
      err(where, `id 命名空间与文件路径不符：位于 ${namespace}/ 的条目，id 须以 "${namespace}." 开头`);
    }
    // kind
    if (!KINDS.includes(entry.kind)) {
      err(where, `kind "${entry.kind}" 非法（${KINDS.join(" | ")}）`);
    }
    // title / body
    if (!isLangMap(entry.title)) err(where, "title 必须是含非空 cn 的语言字典");
    if (!isLangMap(entry.body)) err(where, "body 必须是含非空 cn 的语言字典");
    // surfaces
    const surfaces = [];
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0) {
      err(where, "surfaces 必须是非空数组");
    } else {
      entry.surfaces.forEach((s, j) => {
        const n = normalizeSurface(`${where} surfaces[${j}]`, s);
        if (n) surfaces.push(n);
      });
    }
    // status
    const status = entry.status ?? "stable";
    if (!STATUSES.includes(status)) err(where, `status "${entry.status}" 非法（${STATUSES.join(" | ")}）`);
    // related（引用存在性在全局阶段校验）
    const related = entry.related ?? {};
    if (entry.related !== undefined && (typeof entry.related !== "object" || Array.isArray(entry.related))) {
      err(where, "related 必须是对象");
    }
    if (related.replaced_by && status !== "deprecated") {
      warn(where, `replaced_by 出现在非 deprecated 条目（status=${status}）`);
    }
    if (status === "deprecated" && !related.replaced_by) {
      warn(where, "deprecated 条目建议填 related.replaced_by 指向继任条目");
    }
    // field 专属
    if (entry.kind === "field") {
      if (typeof entry.name !== "string" || entry.name.trim() === "") err(where, "kind=field 必须有非空 name");
      if (!FIELD_TYPES.includes(entry.type)) err(where, `kind=field 的 type "${entry.type}" 非法（${FIELD_TYPES.join(" | ")}）`);
      if (!entry.verify) err(where, "kind=field 必须填 verify（META.md §9）");
    }
    // verify 存在性（warning）
    if (entry.verify !== undefined) {
      if (typeof entry.verify !== "string" || entry.verify.trim() === "") {
        err(where, "verify 必须是非空字符串（相对仓库根的路径）");
      } else if (!existsSync(join(REPO_ROOT, entry.verify))) {
        warn(where, `verify 指向的文件不存在：${entry.verify}`);
      }
    }
    allEntries.set(entry.id, { entry, file: rel, absFile: file, docTitle: doc.title ?? null, surfaces, status, related });
  });
}

// 引用全局校验
for (const [id, rec] of allEntries) {
  for (const ref of rec.related.see_also ?? []) {
    if (!allEntries.has(ref)) err(`${rec.file} → ${id}`, `see_also 悬空引用：${ref}`);
  }
  if (rec.related.replaced_by && !allEntries.has(rec.related.replaced_by)) {
    err(`${rec.file} → ${id}`, `replaced_by 悬空引用：${rec.related.replaced_by}`);
  }
}

// ---------- ② render ----------

const GENERATED_HEADER = "<!-- 本文件由 handbook/tools/codegen.mjs 生成，禁止手改；请编辑 content/ 下的 YAML 源 -->\n\n";

function renderMd(docTitle, records) {
  const lines = [GENERATED_HEADER, `# ${docTitle ?? records[0].file}\n`];
  for (const { entry, surfaces, status, related } of records) {
    const badge = status === "stable" ? "" : status === "draft" ? "（草稿）" : "（已作废）";
    lines.push(`\n## ${entry.title.cn}${badge}\n`);
    lines.push(`> \`${entry.id}\``);
    if (entry.kind === "field") {
      const req = entry.required ? "必填" : "可选";
      lines.push(`\n**字段** \`${entry.name}\` · 类型 \`${entry.type}\` · ${req}\n`);
    }
    lines.push(`\n${entry.body.cn.trim()}\n`);
    const refs = related.see_also ?? [];
    if (related.replaced_by) lines.push(`\n> ⚠️ 本条目已作废，继任：\`${related.replaced_by}\``);
    if (refs.length > 0) lines.push(`\n_参见：${refs.map((r) => `\`${r}\``).join("、")}_\n`);
    void surfaces;
  }
  return lines.join("\n");
}

function renderJson(records) {
  const out = {};
  for (const { entry, surfaces, status, related } of records) {
    const item = {
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      surfaces,
      status,
    };
    if (entry.kind === "field") {
      item.name = entry.name;
      item.type = entry.type;
      item.required = entry.required === true;
    }
    if (related.see_also?.length) item.see_also = related.see_also;
    if (related.replaced_by) item.replaced_by = related.replaced_by;
    out[entry.id] = item;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

/** 产出全部生成物（内存形态）：Map<绝对路径, 文件内容> */
function produceAll() {
  const outputs = new Map();
  const byFile = new Map(); // yaml 绝对路径 -> records
  for (const rec of allEntries.values()) {
    if (!byFile.has(rec.absFile)) byFile.set(rec.absFile, []);
    byFile.get(rec.absFile).push(rec);
  }
  for (const [absFile, records] of byFile) {
    const base = join(GENERATED_DIR, relative(CONTENT_DIR, absFile)).replace(/\.yaml$/, "");
    outputs.set(`${base}.md`, renderMd(records[0].docTitle, records));
    outputs.set(`${base}.json`, renderJson(records));
  }
  return outputs;
}

const checkOnly = process.argv.includes("--check");

if (errors.length === 0 && !checkOnly) {
  const outputs = produceAll();
  for (const [absPath, content] of outputs) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  // 清理失源产物（源文件删除/改名后残留的生成物）
  const stale = listGeneratedFiles(GENERATED_DIR).filter((f) => !outputs.has(f));
  for (const f of stale) rmSync(f);
  if (stale.length > 0) console.log(`已清理失源产物 ${stale.length} 个：${stale.map((f) => relative(HANDBOOK_DIR, f)).join(", ")}`);
}

if (errors.length === 0 && checkOnly) {
  // --check：内存渲染并与磁盘比对，不写任何文件。
  // 同时覆盖两个方向的漂移：源变了没重新生成 / 手改了生成物。
  const outputs = produceAll();
  const drifted = [];
  for (const [absPath, content] of outputs) {
    if (!existsSync(absPath) || readFileSync(absPath, "utf8") !== content) drifted.push(absPath);
  }
  const stale = listGeneratedFiles(GENERATED_DIR).filter((f) => !outputs.has(f));
  for (const f of [...drifted, ...stale]) {
    err(relative(HANDBOOK_DIR, f), "生成物与源不一致（请运行 yarn docs:gen 重新生成并提交；禁止手改生成物）");
  }
}

function listGeneratedFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listGeneratedFiles(p));
    else if (e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".json"))) out.push(p);
  }
  return out;
}

// ---------- 报告 ----------

for (const w of warnings) console.warn(`⚠️  ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`❌ ${e}`);
  console.error(`\n校验失败：${errors.length} 个 error，${warnings.length} 个 warning`);
  process.exit(1);
}
console.log(
  checkOnly
    ? `✅ handbook 校验通过：${allEntries.size} 个条目源与产物一致，${warnings.length} 个 warning`
    : `✅ handbook 生成完成：${allEntries.size} 个条目，${files.length} 个源文件，${warnings.length} 个 warning`,
);
