// 测试 fixture：读 stdin 信封 → 回显 input/config/workspace 作为业务产出（不经 sdk，纯 stdin/stdout 契约）
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
});
process.stdin.on("end", () => {
  const envelope = JSON.parse(buf);
  process.stdout.write(
    JSON.stringify({
      contract_version: "v1",
      ok: true,
      output: {
        input: envelope.input,
        config: envelope.config,
        workspace: envelope.workspace,
      },
    }),
  );
});
