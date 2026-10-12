import { sdk } from "../../../sdk/dist/index.js";

// 业务日志：结构化（含对象 fields / JSON 字符串 / 数字形字符串）+ 非结构化 + 一次 secret 值泄漏（断言日志文件中被脱敏）
sdk.log("info", " masked ", { k: 1 });
sdk.log("info", "nested", { payload: '{"a":1}', id: "12345" });
process.stderr.write("raw noise line\n");
process.stderr.write(sdk.secret("api_key") + "\n");
sdk.return("ok");
