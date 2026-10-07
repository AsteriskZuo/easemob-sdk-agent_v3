// 子程序：直读 stdin 信封原始字段，回信封键清单（断言 sdk.run 注入的信封不含 programs——工具是叶子，不能再按名组合）
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
        has_programs: "programs" in envelope,
        keys: Object.keys(envelope).sort(),
      },
    }),
  );
});
