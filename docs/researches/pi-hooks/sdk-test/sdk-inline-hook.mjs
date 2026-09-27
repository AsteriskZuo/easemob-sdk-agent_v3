/**
 * SDK 编程式嵌入冒烟测试（对应实验9）：
 * - 通过 DefaultResourceLoader 的 extensionFactories 注入内联 extension（无需任何文件）
 * - 内联 extension 注册 tool_call hook，按条件阻断 bash 工具
 * - 每个 createAgentSession 调用可传入不同的 factory，实现同进程内"按业务"隔离
 *
 * 运行：PI_CODING_AGENT_DIR=../tmp-agentdir node sdk-inline-hook.mjs
 */
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// 模拟"业务 A"的钩子配置：阻断包含 FORBIDDEN 的 bash 命令
const businessAHook = (pi) => {
	pi.on("tool_call", (event) => {
		console.log(`[sdk-hook] tool_call: ${event.toolName} ${JSON.stringify(event.input)}`);
		if (event.toolName === "bash" && String(event.input.command ?? "").includes("FORBIDDEN")) {
			return { block: true, reason: "sdk-hook: 业务A策略阻断" };
		}
		return undefined;
	});
	pi.on("agent_end", (e) => console.log(`[sdk-hook] agent_end, messages=${e.messages.length}`));
};

const resourceLoader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	extensionFactories: [businessAHook], // 按次注入：换个业务就换个 factory 数组
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
	model: undefined, // 使用默认解析；通过环境变量/设置选择模型
});

try {
	await session.prompt("Use the bash tool to run exactly: echo FORBIDDEN_x. Then report what happened.");
	console.log("[sdk-hook] final:", session.getLastAssistantText());
} finally {
	session.dispose();
}
