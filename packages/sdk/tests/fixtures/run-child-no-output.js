import { sdk } from "../../dist/index.js";

// 子程序：无产出（无参 return——结果行缺 output 键，JSON.stringify 丢弃 undefined 键）
sdk.runInput(); // 消费信封（保持子程序读口一致）
sdk.return();
