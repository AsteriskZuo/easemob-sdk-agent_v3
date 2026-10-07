// 回显 stdin 信封的 programs 映射（名→物化绝对路径）；不经 sdk，直读信封原始字段
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
      output: { programs: envelope.programs },
    }),
  );
});
