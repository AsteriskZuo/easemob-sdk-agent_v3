import { sdk } from "../../dist/index.js";

// dataDir 读口探测：注入则回显路径，未注入则捕获抛错消息（两种形态一个 fixture 覆盖）
let out;
try {
  out = { dataDir: sdk.dataDir() };
} catch (err) {
  out = {
    threw: true,
    message: err instanceof Error ? err.message : String(err),
  };
}
sdk.return(out);
