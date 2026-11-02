import { sdk } from "@asteriskzuo/agent-sdk";

// 主流程薄壳（单轮审查形态）：取数/脱敏 → 大模型 → 组装产出 → 唯一出口。
// 入口检查/出口校验是独立程序（apps/check-input、apps/check-output），由平台三段编排自动调用，
// main 不自查——check 只判过/不过、不做转换，解析归 main（此处按 contract.json 声明的形状直接取用）。
// 约束四条：stdin 一段 JSON 进、stdout 一段 JSON 出（sdk.return/sdk.fail）、
// 失败语义机械（任何一步失败 = 整体失败）、日志走 sdk.log（stderr，平台采集）。
const { event } = sdk.input();
sdk.log("info", "run started");

// 1. 取数/脱敏：sdk.run('your-fetch', { input: ... }) —— 调本包或业务绑定工具资产的子程序，按需启用
const payload = (event as { payload?: { text?: unknown } }).payload;
const text = payload?.text as string; // contract.json input 契约保证存在且为 string（check-input 已拦）

// 2. 大模型：skills 来自业务绑定的 skill 集合（可多个、可跨集合），清单 requires.skills 声明、控制台配置期校验；模型凭据平台持有
const answer = await sdk.agent({ skills: ["your-skill"], input: text });

// 3. 组装产出（形状 = contract.json 的 output 契约，check-output 会复核）→ 唯一出口：
//    结果由平台扇出（下游关注 + 出口绑定投递），业务不做投递
sdk.return({ answer });
