import { sdk } from "../../dist/index.js";

sdk.log("info", "hello world", { k: 1 });
// fields 循环引用 → JSON.stringify 失败 → 吞掉不崩（log 永不抛错）
const circular = {};
circular.self = circular;
sdk.log("error", "circular", circular);
sdk.return("ok");
