/**
 * pi extension：工单审查场景的脱敏/还原 hooks（调研用）
 *
 * 链路：
 *   input hook（前置，信任边界）——从 prompt 中提取 <<<ISSUE_JSON ... >>> 包裹的工单 JSON，
 *     调 masking 脱敏，kv 落盘 results/kv.json、脱敏结果落盘 results/masked.json，
 *     返回 {action:"transform"} 使 LLM 只看到脱敏内容。
 *   before_provider_request hook —— 把每次发给 LLM 的请求体落盘 results/llm-payload.jsonl，
 *     作为「LLM 上下文中无原始敏感值」的直接证据。
 *   message_end hook（后置）——对 assistant 消息读 kv.json 还原 token，返回替换后的消息，
 *     还原结果同时落盘 results/restored.txt。
 *
 * 配置（环境变量）：
 *   MASK_RESULTS_DIR  产物目录，默认 ./results（相对 pi 的 cwd）
 *
 * 加载：pi -p --no-extensions -e ./extension/masking-hooks.ts ...
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createIssueMaskerWithKv } from "../masking-with-kv.ts";
import { restoreText, flattenKv } from "../restore.ts";

const RESULTS_DIR = process.env.MASK_RESULTS_DIR ?? "./results";
const KV_PATH = join(RESULTS_DIR, "kv.json");
const MASKED_PATH = join(RESULTS_DIR, "masked.json");
const HOOK_LOG = join(RESULTS_DIR, "hooks.jsonl");
const PAYLOAD_LOG = join(RESULTS_DIR, "llm-payload.jsonl");
const RESTORED_PATH = join(RESULTS_DIR, "restored.txt");

const BEGIN = "<<<ISSUE_JSON";
const END = ">>>";

function rec(event: string, data: unknown) {
	mkdirSync(RESULTS_DIR, { recursive: true });
	appendFileSync(HOOK_LOG, JSON.stringify({ t: new Date().toISOString(), event, data }) + "\n");
}

/** 从 prompt 中提取工单 JSON 块：BEGIN/END 必须独占一行（避免指令文本提及标记造成误匹配） */
function extractIssueBlock(text: string): { json: string; start: number; end: number } | undefined {
	const beginLine = BEGIN + "\n";
	const start = text.indexOf(beginLine);
	if (start < 0) return undefined;
	const jsonStart = start + beginLine.length;
	const endMarker = "\n" + END;
	const end = text.indexOf(endMarker, jsonStart);
	if (end < 0) return undefined;
	return { json: text.slice(jsonStart, end), start, end: end + endMarker.length };
}

export default function (pi: ExtensionAPI) {
	const masker = createIssueMaskerWithKv();
	rec("extension_loaded", { resultsDir: RESULTS_DIR });

	// ---- 前置：脱敏 + kv 落盘 + transform ----
	pi.on("input", (event) => {
		const block = extractIssueBlock(event.text);
		if (!block) {
			rec("input_no_issue_block", { textSnippet: event.text.slice(0, 100) });
			return { action: "continue" as const };
		}

		let issue: Record<string, unknown>;
		try {
			issue = JSON.parse(block.json);
		} catch (e) {
			rec("input_parse_error", { error: String(e) });
			return { action: "continue" as const };
		}

		const masked = masker.sanitize(issue);
		const kv = masker.dumpKv();

		writeFileSync(KV_PATH, JSON.stringify(kv, null, 2));
		writeFileSync(MASKED_PATH, JSON.stringify(masked, null, 2));

		const maskedJson = JSON.stringify(masked, null, 2);
		const transformed = event.text.slice(0, block.start) + BEGIN + "\n" + maskedJson + "\n" + END + event.text.slice(block.end);

		rec("input_masked", {
			issueKey: issue.key,
			originalBytes: block.json.length,
			maskedBytes: maskedJson.length,
			kvCategories: Object.fromEntries(
				Object.entries(kv[String(issue.key)] ?? {}).map(([cat, tokens]) => [cat, Object.keys(tokens).length]),
			),
		});
		return { action: "transform" as const, text: transformed };
	});

	// ---- 证据：发给 LLM 的请求体落盘（还原发生在 message_end，请求体应只见 token）----
	pi.on("before_provider_request", (event) => {
		mkdirSync(RESULTS_DIR, { recursive: true });
		appendFileSync(PAYLOAD_LOG, JSON.stringify(event.payload) + "\n");
	});

	// ---- 后置：还原 assistant 输出 ----
	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
			return undefined;
		}

		let kv: Record<string, string>;
		try {
			kv = flattenKv(JSON.parse(readFileSync(KV_PATH, "utf8")));
		} catch {
			return undefined; // 无 kv（本 run 没走脱敏），不动消息
		}

		const missingAll: string[] = [];
		const restoredParts: string[] = [];
		const newContent = (msg.content as { type: string; text?: string }[]).map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const { text, missing } = restoreText(part.text, kv);
			missingAll.push(...missing);
			restoredParts.push(text);
			return { ...part, text };
		});

		writeFileSync(RESTORED_PATH, restoredParts.join("\n"));
		rec("message_end_restored", {
			restoredBytes: restoredParts.join("\n").length,
			missingTokens: missingAll,
		});
		return { message: { ...event.message, content: newContent } };
	});
}
