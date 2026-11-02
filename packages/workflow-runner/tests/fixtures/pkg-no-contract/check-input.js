// 本目录刻意不放 contract.json：有 check 程序但找不到契约 ⇒ 按旧结构资产跳过（两个 check 恒失败，若执行则测试红）。
// 注意：本目录的祖先目录（tests/fixtures、tests、包根……上探 5 级内）都不得出现 contract.json，否则本 fixture 失效
import "../checks/impl-fail.js";
