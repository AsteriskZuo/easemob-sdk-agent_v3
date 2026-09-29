// 只认一次：手写三个 stdout 行——合法结果(first) / 垃圾 / 合法结果(second)
// 不用 sdk.return（它会立即 exit）；自然结束让管道 flush 后 exit 0
process.stdout.write(
  JSON.stringify({ contract_version: "v1", ok: true, output: "first" }) + "\n",
);
process.stdout.write("garbage line\n");
process.stdout.write(
  JSON.stringify({ contract_version: "v1", ok: true, output: "second" }) + "\n",
);
