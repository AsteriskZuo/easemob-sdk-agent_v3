import { sdk } from "@asterisk/agent-sdk";

// 流程程序骨架（单轮审查工单形态）：检查 → 取数/脱敏 → 大模型 → 还原/门禁 → 唯一出口。
// 约束四条：stdin 一段 JSON 进、stdout 一段 JSON 出（sdk.return/sdk.fail）、
// 失败语义机械（任何一步失败 = 整体失败）、日志走 sdk.log（stderr，平台采集）。
const { event } = sdk.input();
sdk.log("info", "run started");

// 1. 检查：输入不合规 = 直接失败（不扇出、下游不触发）
const payload = (event as { payload?: { text?: string } }).payload;
if (!payload?.text) {
  sdk.fail("检查未通过：缺少 payload.text");
}

// 2. 取数/脱敏：sdk.run('your-fetch', { input: ... }) —— 调本包或业务绑定工具资产的子程序，按需启用
// 3. 大模型：skills 来自业务绑定的 skill 集合（可多个、可跨集合），清单 requires.skills 声明、控制台配置期校验；模型凭据平台持有
const answer = await sdk.agent({ skills: ["your-skill"], input: payload.text });

// 4. 门禁：机械校验结果，不合格 = 失败（不重做）
if (typeof answer !== "string" || answer.length === 0) {
  sdk.fail("门禁未通过：结果为空");
}

// 5. 唯一出口：结果由平台扇出（下游关注 + 出口绑定投递），业务不做投递
sdk.return({ answer });
