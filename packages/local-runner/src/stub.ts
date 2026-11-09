/**
 * stub 替身程序文件内容生成器（出口副作用护栏，见 spec §9 与实施计划「关键跨任务契约」stub 协议）。
 *
 * `applyStubTools`（T4）为每个被 stub 的工具调用本函数生成独立 js 文件，
 * 落盘 `{local_root}/.local-run-stubs/{工具名}.js`（每次 run 前重新生成），
 * 并把 `programs[工具名]` 替换为该文件路径。业务经 sdk.run 调该工具时实际执行替身，
 * 出口副作用（发企微、回写 Jira 等）因此不会真实外发。
 */

/** 生成指定工具的 stub 替身程序文件内容（可被 `node` 直接执行的独立 js）。
 *
 *  生成的程序协议（与计划「关键跨任务契约」逐字对齐）：
 *  - 消费 stdin 全部内容后忽略（读法对齐 packages/sdk/src/stdin.ts：runner 写完即关、EOF 立达；
 *    目的是消费掉防止上游 broken pipe，内容不参与结果）；
 *  - stdout 只写一行结果信封 `{"contract_version":"v1","ok":true,"output":<固定输出>}`；
 *  - stderr 写一行 `[stub] <工具名> input=<stdin 内容截断 200 字符>`；
 *  - 然后 process.exit(0)。
 *
 *  @param tool 被 stub 的工具名，经 JSON.stringify 内联进生成代码（stderr 标记用）
 *  @param output 该工具的固定输出（来自 config.stub_outputs，调用方负责未配置时传 {}），
 *                经 JSON.stringify 内联为 JS 表达式字面量（JSON 是合法 JS 表达式）
 *  @returns stub 文件内容。不含任何 import/require 语句，无论就近 package.json 的
 *           type 字段如何（模块/脚本）都能被 node 直接执行 */
export function stubFileContent(tool: string, output: unknown): string {
  const toolLiteral = JSON.stringify(tool);
  // JSON.stringify(undefined) 返回 undefined（非字符串），拼进模板即字面量 undefined，仍是合法 JS 表达式
  const outputLiteral = JSON.stringify(output);
  return `// 本文件由 agent-local 自动生成的 stub 替身程序（工具：${tool}），每次 run 前重新生成，请勿手改。
// 协议：消费 stdin 后忽略；stdout 只写一行结果信封 JSON；stderr 写 [stub] 标记；退出码 0。
const STUB_TOOL = ${toolLiteral};
const STUB_OUTPUT = ${outputLiteral};

let input = "";
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  const summary = input.slice(0, 200);
  process.stdout.write(
    JSON.stringify({ contract_version: "v1", ok: true, output: STUB_OUTPUT }) + "\\n",
    () => {
      process.stderr.write("[stub] " + STUB_TOOL + " input=" + summary + "\\n", () => {
        process.exit(0);
      });
    },
  );
}

if (process.stdin.isTTY) {
  finish();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
}
`;
}
