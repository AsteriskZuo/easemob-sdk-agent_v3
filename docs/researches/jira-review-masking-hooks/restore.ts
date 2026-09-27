/**
 * 还原工具（独立单文件，调研用）
 *
 * 把脱敏文本中的 token 替换回 kv 映射里的原值。
 * [REDACTED] 无映射（Bearer/秘钥值脱敏时不编号），保持原样。
 *
 * 用法：
 *   库调用:  import { restoreText, loadKv } from "./restore.ts"
 *   命令行:  node restore.ts <kv.json> < input.txt > output.txt
 *            kv.json 即 masking-with-kv dumpKv() 的产物
 *            （{ issueKey: { 类别: { token: 原值 } } }，多 issue 会被拍平合并）
 *
 * 实现说明：用单次正则精确匹配完整 token（[类别_数字]），查表替换，
 * 天然规避 "[IP_1] 吃掉 [IP_10]" 这类前缀误替换——不存在逐个 token 串行替换。
 */
import { readFile } from "node:fs/promises";

/** token 格式：[ACCOUNT_n]/[URL_n]/[IP_n]/[HOST_n]/[PHONE_n]/[APPKEY_n] */
const TOKEN_PATTERN = /\[(ACCOUNT|URL|IP|HOST|PHONE|APPKEY)_(\d+)\]/g;

type KvDump = Record<string, Record<string, Record<string, string>>>;

/** 拍平 kv 转储为 token → 原值（多 issue 合并；同名 token 跨 issue 冲突时后者覆盖，调用方应避免此场景） */
export function flattenKv(dump: KvDump): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const categories of Object.values(dump)) {
		for (const tokens of Object.values(categories)) {
			Object.assign(flat, tokens);
		}
	}
	return flat;
}

/** 还原文本：返回 { text, missing } —— missing 为 kv 中无映射的 token（正常应为空，[REDACTED] 不在此列） */
export function restoreText(
	text: string,
	kv: Record<string, string>,
): { text: string; missing: string[] } {
	const missing = new Set<string>();
	const restored = text.replace(TOKEN_PATTERN, (match) => {
		const original = kv[match];
		if (original === undefined) {
			missing.add(match);
			return match; // 无映射保持原样（便于校验步骤发现还原失败）
		}
		return original;
	});
	return { text: restored, missing: [...missing] };
}

export async function loadKv(path: string): Promise<Record<string, string>> {
	return flattenKv(JSON.parse(await readFile(path, "utf8")) as KvDump);
}

// 命令行模式：node restore.ts <kv.json>，stdin → stdout
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const kvPath = process.argv[2];
	if (!kvPath) {
		console.error("用法: node restore.ts <kv.json> < input.txt > output.txt");
		process.exit(2);
	}
	const kv = await loadKv(kvPath);
	const input = await new Response(process.stdin).text();
	const { text, missing } = restoreText(input, kv);
	process.stdout.write(text);
	if (missing.length > 0) {
		console.error(`\n[restore] 警告: ${missing.length} 个 token 无映射未还原: ${missing.join(", ")}`);
		process.exit(1);
	}
}
