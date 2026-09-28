import "../src/index.js";

describe("smoke", () => {
  it("esbuild → jest 编译态链路可用", () => {
    expect(1 + 1).toBe(2);
  });
});
