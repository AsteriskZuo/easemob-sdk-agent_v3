// main fixture：按 config.case 产出各种非法形状的 metrics 保留键（形状护栏用例；
// 走 config 传参是因为业务进程 env 被清空，只有信封能带参数）
import { readFileSync, writeSync } from "node:fs";

const env = JSON.parse(readFileSync(0, "utf8"));
const c = env.config?.case;
let metrics;
switch (c) {
  case "not-object":
    metrics = "oops";
    break;
  case "array":
    metrics = ["a"];
    break;
  case "null":
    metrics = null;
    break;
  case "bad-key":
    metrics = { "Bad-Key": 1 };
    break;
  case "too-many":
    metrics = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [
        `k${String(i).padStart(2, "0")}`,
        i,
      ]),
    );
    break;
  case "bool-value":
    metrics = { flag: true };
    break;
  case "nested-value":
    metrics = { detail: { a: 1 } };
    break;
  case "long-string":
    metrics = { note: "x".repeat(201) };
    break;
  default:
    throw new Error(`unknown case: ${c}`);
}

writeSync(
  1,
  JSON.stringify({
    contract_version: "v1",
    ok: true,
    output: { content: "正文内容", metrics },
  }) + "\n",
);
process.exit(0);
