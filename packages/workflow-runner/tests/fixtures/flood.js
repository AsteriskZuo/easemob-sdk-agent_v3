import { sdk } from "../../../sdk/dist/index.js";

// 输出上限：先写远超上限的垃圾 stdout，再尝试 return（runner 超限即杀即判）
for (let i = 0; i < 2000; i++) console.log("x".repeat(200));
sdk.return({ done: true });
