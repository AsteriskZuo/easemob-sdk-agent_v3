import { sdk } from "@asteriskzuo/agent-sdk";

// 流程程序骨架（单轮审查工单形态）：入口检查 → 取数/脱敏 → 大模型 → 出口校验 → 唯一出口。
// 约束四条：stdin 一段 JSON 进、stdout 一段 JSON 出（sdk.return/sdk.fail）、
// 失败语义机械（任何一步失败 = 整体失败）、日志走 sdk.log（stderr，平台采集）。
const { event } = sdk.input();
sdk.log("info", "run started");

// 1. 入口检查（程序校验，不过大模型，确定性可测试）：输入形状不合规 = 直接失败（不扇出、下游不触发）。
//    报错统一前缀「入口检查未通过：」，便于日志检索与按失败类型归类。
const payload = (event as { payload?: { text?: unknown } }).payload;
if (typeof payload?.text !== "string" || payload.text === "") {
  sdk.fail("入口检查未通过：缺少 payload.text（非空字符串）");
}

// 2. 取数/脱敏：sdk.run('your-fetch', { input: ... }) —— 调本包或业务绑定工具资产的子程序，按需启用
// 3. 大模型：skills 来自业务绑定的 skill 集合（可多个、可跨集合），清单 requires.skills 声明、控制台配置期校验；模型凭据平台持有
const answer = await sdk.agent({ skills: ["your-skill"], input: payload.text });

// 4. 出口校验（程序校验，不过大模型）：对产出形状做校验，与包内 CONTRACT.md 的输出契约保持一致。
//    校验失败的处置（直接失败 / 修正后重试）是业务内部逻辑，平台不参与；本示例演示直接失败。
const output = { answer };
if (typeof output.answer !== "string" || output.answer.length === 0) {
  sdk.fail("出口校验未通过：结果为空");
}

// 5. 唯一出口：结果由平台扇出（下游关注 + 出口绑定投递），业务不做投递
sdk.return(output);
