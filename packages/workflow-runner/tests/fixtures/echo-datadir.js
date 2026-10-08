import { existsSync } from "node:fs";
import { sdk } from "../../../sdk/dist/index.js";

// 回显平台注入的 dataDir 及其存在性（断言 runner 已建目录）
const dataDir = sdk.dataDir();
sdk.return({ dataDir, exists: existsSync(dataDir) });
