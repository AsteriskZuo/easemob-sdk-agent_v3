/**
 * jira 工单拉取工具（独立单文件，调研用）
 *
 * 用法：
 *   node jira-tool.ts <ISSUE-KEY>            # 输出工单结构化 JSON 到 stdout
 *   node jira-tool.ts HIM-23706 > results/original.json
 *
 * 凭据从 .easemob-agent/config.json 读取（TOOL__JIRA__URL/USERNAME/PASSWORD/
 * REDIRECT_USERNAME/REDIRECT_PASSWORD），配置路径可用环境变量 EASEMOB_CONFIG 覆盖。
 * 本文件不包含任何凭据，也不打印凭据。
 *
 * 输出字段形态与 docs/refs/jira/jira-client.ts 的 mapIssue 一致
 * （key/summary/description/himBugContent/comments/...），即 masking 的输入契约。
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraClient } from "../../refs/jira/jira-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
// 默认指向仓库根下的 .easemob-agent/config.json（本目录在 docs/researches/jira-review-masking-hooks/）
const configPath =
	process.env.EASEMOB_CONFIG ?? resolve(here, "../../../.easemob-agent/config.json");

async function main() {
	const issueKey = process.argv[2];
	if (!issueKey) {
		console.error("用法: node jira-tool.ts <ISSUE-KEY>");
		process.exit(2);
	}

	const config = JSON.parse(await readFile(configPath, "utf8"));
	for (const key of ["TOOL__JIRA__URL", "TOOL__JIRA__USERNAME", "TOOL__JIRA__PASSWORD"]) {
		if (!config[key]) {
			console.error(`配置缺少 ${key}（来自 ${configPath}）`);
			process.exit(2);
		}
	}

	const client = new JiraClient({
		jiraUrl: config["TOOL__JIRA__URL"],
		username: config["TOOL__JIRA__USERNAME"],
		password: config["TOOL__JIRA__PASSWORD"],
		redirectUsername: config["TOOL__JIRA__REDIRECT_USERNAME"],
		redirectPassword: config["TOOL__JIRA__REDIRECT_PASSWORD"],
	});

	// 注意：这里不传 sanitizeIssueData —— 本工具输出原始工单，
	// 脱敏发生在 pi 的前置 hook（信任边界）里，这是本调研要验证的链路。
	const result = await client.getIssue(issueKey, { includeComments: true });
	if (result.status === "error") {
		console.error(`拉取失败: ${result.code}: ${result.message}`);
		process.exit(1);
	}
	process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
}

await main();
