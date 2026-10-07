/**
 * 调研用 demo extension：验证 pi 0.87.1 的 hook 能力。
 *
 * 功能：
 * 1. 把每个 hook 的触发时机与收到的参数记录为 JSONL（路径由环境变量 PI_HOOK_LOG 指定）。
 * 2. 前置检查：input 事件中，输入包含 "BLOCK_THIS_INPUT" 时返回 { action: "handled" } 阻断整个 run。
 * 3. 中间处理：
 *    - tool_call：bash 命令包含 "FORBIDDEN" 时返回 { block: true, reason } 阻断；
 *      包含 "REWRITE_ME" 时原地修改 event.input.command（验证入参可改写）。
 *    - tool_result：给 bash 结果追加审计标记（验证结果可改写）。
 * 4. 后置检查：message_end 中，若环境变量 PI_HOOK_REWRITE_OUTPUT=1，
 *    给最终 assistant 消息追加一段文本（验证输出可改写）。
 *
 * 加载方式（按次注入，不影响全局）：
 *   PI_HOOK_LOG=... pi -p -e ./hook-logger.ts "..."
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const LOG = process.env.PI_HOOK_LOG ?? "./hook-events.jsonl";

function rec(event: string, data: unknown) {
	appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, data }) + "\n");
}

/** 从消息 content 中提取纯文本，便于日志记录 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: string; text: string } => c && c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	rec("extension_loaded", { pid: process.pid, log: LOG });

	pi.on("session_start", (e) => rec("session_start", { reason: e.reason }));

	// ---- ① 前置检查：会话输入进入 agent 之前，可放行/改写/阻断 ----
	pi.on("input", (e) => {
		rec("input", { text: e.text, source: e.source });
		if (e.text.includes("BLOCK_THIS_INPUT")) {
			rec("input_blocked", { text: e.text });
			return { action: "handled" as const }; // 阻断：不进入 agent 循环
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", (e) => rec("before_agent_start", { prompt: e.prompt }));
	pi.on("agent_start", () => rec("agent_start", {}));

	// ---- ② 中间处理：工具调用前，可审计/阻断/改写入参 ----
	pi.on("tool_call", (e) => {
		rec("tool_call", { toolName: e.toolName, input: e.input });
		if (e.toolName === "bash") {
			const cmd = (e.input as { command?: string }).command ?? "";
			if (cmd.includes("FORBIDDEN")) {
				rec("tool_call_blocked", { command: cmd });
				return { block: true, reason: "demo-hook: 命令包含 FORBIDDEN，已被阻断" };
			}
			if (cmd.includes("THROW_ME")) {
				// 验证 fail-safe：handler 抛错时工具是否被阻断
				throw new Error("demo-hook: 故意抛错，验证 fail-safe 阻断");
			}
			if (cmd.includes("REWRITE_ME")) {
				const rewritten = cmd.replace("REWRITE_ME", "rewritten-by-hook");
				(e.input as { command: string }).command = rewritten; // 原地改写入参
				rec("tool_call_rewritten", { from: cmd, to: rewritten });
			}
		}
		return undefined;
	});

	pi.on("tool_execution_start", (e) => rec("tool_execution_start", { toolName: e.toolName, args: e.args }));
	pi.on("tool_execution_end", (e) => rec("tool_execution_end", { toolName: e.toolName, isError: e.isError }));

	// ---- ② 中间处理：工具调用后，可改写结果（结果会送回给模型） ----
	pi.on("tool_result", (e) => {
		rec("tool_result", {
			toolName: e.toolName,
			isError: e.isError,
			contentText: textOf(e.content).slice(0, 200),
		});
		if (e.toolName === "bash" && !e.isError) {
			return {
				content: [...e.content, { type: "text" as const, text: "\n[hook-audit: 本次工具调用已被审计]" }],
			};
		}
		return undefined;
	});

	// ---- ③ 后置检查：消息/轮次/run 结束 ----
	pi.on("message_end", (e) => {
		rec("message_end", {
			role: e.message.role,
			text: textOf((e.message as { content?: unknown }).content).slice(0, 200),
		});
		// 输出门禁演示：改写最终 assistant 消息
		if (process.env.PI_HOOK_REWRITE_OUTPUT === "1" && e.message.role === "assistant") {
			const msg = e.message as { content?: unknown };
			if (Array.isArray(msg.content)) {
				return {
					message: {
						...e.message,
						content: [...msg.content, { type: "text", text: "\n[hook-gate: 输出已被后置检查标记]" }],
					},
				};
			}
		}
		return undefined;
	});

	pi.on("turn_end", (e) => rec("turn_end", { turnIndex: e.turnIndex, outcome: e.outcome }));
	pi.on("agent_end", (e) => rec("agent_end", { messageCount: e.messages.length }));
	pi.on("agent_settled", () => rec("agent_settled", {}));
	pi.on("session_shutdown", (e) => rec("session_shutdown", { reason: e.reason }));
}
