#!/usr/bin/env node
/**
 * codex 工单脱敏 hook（调研用）：PreToolUse 访问控制 + PostToolUse 结果替换
 *
 * 设计要点（由实测踩坑驱动）：
 *   - 信任边界按「命令是否触碰受保护路径」判定，而不是按工具输出内容判定——
 *     首版按输出哨兵判定，被模型用 grep/jq/python 切片读取绕过（原文不含哨兵照样泄漏）。
 *   - PreToolUse：命令触及受保护文件时，只允许一种形态 `cat <绝对路径>`（整文件读取），
 *     其余一律 deny（grep/head/python/wildcard/重定向等全部挡下）。
 *   - PostToolUse：对触及受保护文件的命令结果做脱敏，返回
 *     {"decision":"block","reason":<脱敏后JSON>} —— block 语义是「用 hook 反馈
 *     替换模型可见的工具结果」，不是报错。
 *   - first-mask-wins：hook 每次是新进程，token 编号无法跨进程延续；同一次 run
 *     内（run-all 跑前清理 kv/masked）首次脱敏结果落盘后直接复用。
 *   - fail-closed：解析失败/脱敏失败/来源异常一律 block，且 reason 不含任何原文。
 *
 * 用法（由 hooks.json 的 command 携带参数）：
 *   node mask_tool_output.mjs <RESULTS_DIR> <ISSUE_KEY> <PROTECTED_JSON_PATH>
 * 事件 JSON 从 stdin 读；审计日志追加到 <RESULTS_DIR>/hooks.jsonl。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssueMaskerWithKv } from "../../masking-with-kv.ts";

const resultsDir = process.argv[2];
const issueKey = process.argv[3];
const protectedPath = process.argv[4];
if (!resultsDir || !issueKey || !protectedPath) {
	console.error("用法: node mask_tool_output.mjs <RESULTS_DIR> <ISSUE_KEY> <PROTECTED_JSON_PATH>");
	process.exit(2);
}

const logPath = join(resultsDir, "hooks.jsonl");
const maskedPath = join(resultsDir, "masked.json");
const kvPath = join(resultsDir, "kv.json");
const hashPath = join(resultsDir, ".masked-sha256");

function log(record) {
	appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
}

/** 命中受保护文件的判定：命令文本引用了文件名或所在目录名 */
function touchesProtected(command) {
	const fileName = protectedPath.split("/").pop(); // original.json
	const dirName = protectedPath.split("/").slice(-2, -1)[0]; // protected
	return command.includes(fileName) || command.includes(dirName);
}

/** 唯一允许的读取形态：cat <受保护文件绝对路径> */
function isAllowedRead(command) {
	return command.trim() === `cat ${protectedPath}`;
}

function denyPreToolUse(reason) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}) + "\n",
	);
	process.exit(0);
}

function blockPostToolUse(reason) {
	process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
	process.exit(0);
}

const raw = readFileSync(0, "utf8"); // stdin
let event;
try {
	event = JSON.parse(raw);
} catch {
	// 协议层面都解析不了：无法判断内容，fail-closed 宁可误拦
	log({ event: "hook_input_parse_error_blocked" });
	blockPostToolUse("[平台审计] hook 输入解析失败，结果已被拦截。");
}

const command = String(event.tool_input?.command ?? "");

if (event.hook_event_name === "PreToolUse") {
	if (!touchesProtected(command)) process.exit(0); // 与受保护文件无关，放行
	if (isAllowedRead(command)) {
		log({ event: "pretool_allow_full_cat", tool: event.tool_name });
		process.exit(0);
	}
	log({ event: "pretool_deny", tool: event.tool_name, command: command.slice(0, 200) });
	denyPreToolUse(
		`[平台审计] 工单 ${issueKey} 原文文件只允许整文件读取（cat ${protectedPath}），该访问形态被策略拒绝。`,
	);
}

if (event.hook_event_name === "PostToolUse") {
	if (!touchesProtected(command)) process.exit(0);

	const responseText = typeof event.tool_response === "string" ? event.tool_response : "";
	const sha = createHash("sha256").update(responseText).digest("hex");

	// first-mask-wins：同 run 内复用首次脱敏结果，保证 token 编号一致
	if (existsSync(kvPath) && existsSync(maskedPath)) {
		log({
			event: "posttool_reuse_masked",
			tool: event.tool_name,
			sha: sha.slice(0, 12),
			sameContent: existsSync(hashPath) && readFileSync(hashPath, "utf8") === sha,
		});
		blockPostToolUse(readFileSync(maskedPath, "utf8"));
	}

	let issue;
	try {
		// codex 会在 shell 工具输出前加包装头（如 "Warning: truncated output..."），
		// 剥掉首个 "{" 之前的包装部分再按完整 JSON 解析
		issue = JSON.parse(responseText.slice(responseText.indexOf("{")));
	} catch {
		// 输出不是完整工单 JSON（截断/切片/非预期内容）：fail-closed 硬阻断
		log({ event: "posttool_unparsable_blocked", tool: event.tool_name, sha: sha.slice(0, 12) });
		blockPostToolUse(
			`[平台审计] 工单 ${issueKey} 的读取结果不完整或形态异常，已被拦截。请用 cat ${protectedPath} 一次性读取完整文件。`,
		);
	}
	if (issue.key !== issueKey) {
		// 触及受保护路径但内容不是目标工单（异常）：fail-closed
		log({ event: "posttool_unexpected_content_blocked", tool: event.tool_name, sha: sha.slice(0, 12) });
		blockPostToolUse(`[平台审计] 受保护路径返回了非预期内容，已被拦截。`);
	}

	try {
		const masker = createIssueMaskerWithKv();
		const masked = masker.sanitize(issue);
		const maskedText = JSON.stringify(masked, null, 2);
		writeFileSync(maskedPath, maskedText + "\n");
		writeFileSync(kvPath, JSON.stringify(masker.dumpKv(), null, 2) + "\n");
		writeFileSync(hashPath, sha);
		const kvCount = Object.values(masker.dumpKv()[issueKey] ?? {}).reduce(
			(n, cat) => n + Object.keys(cat).length,
			0,
		);
		log({
			event: "posttool_masked",
			tool: event.tool_name,
			issueKey,
			sha: sha.slice(0, 12),
			originalBytes: responseText.length,
			maskedBytes: maskedText.length,
			kvCount,
		});
		blockPostToolUse(maskedText);
	} catch (err) {
		// fail-closed：脱敏失败绝不允许原文通过
		log({ event: "posttool_mask_error_blocked", tool: event.tool_name, error: String(err) });
		blockPostToolUse(`[平台审计] 工单 ${issueKey} 脱敏失败，原始内容已被拦截，任务终止。`);
	}
}

process.exit(0); // 其他事件不关心
