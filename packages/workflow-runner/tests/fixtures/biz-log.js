import { sdk } from "../../../sdk/dist/index.js";

// 业务日志：一条结构化 + 一条非结构化 + 一次 secret 值泄漏（断言日志文件中被脱敏）
sdk.log("info", " masked ", { k: 1 });
process.stderr.write("raw noise line\n");
process.stderr.write(sdk.secret("api_key") + "\n");
sdk.return("ok");
