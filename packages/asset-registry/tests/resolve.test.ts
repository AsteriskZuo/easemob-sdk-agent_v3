import { join } from "node:path";
import { resolveResource } from "../src/index.js";
import type { ResolvedAsset } from "../src/index.js";

const pkgA: ResolvedAsset = {
  asset_id: "ast_a",
  root: "/cache/ast_a",
  programs: { main: "src/main.js", shared: "a/shared.js" },
  skills: [],
};

const toolB: ResolvedAsset = {
  asset_id: "ast_b",
  root: "/cache/ast_b",
  programs: { shared: "b/shared.js", fetch: "tools/fetch.js" },
  skills: [],
};

const skillC: ResolvedAsset = {
  asset_id: "ast_c",
  root: "/cache/ast_c",
  programs: {},
  skills: ["review", "shared-skill"],
};

const skillD: ResolvedAsset = {
  asset_id: "ast_d",
  root: "/cache/ast_d",
  programs: {},
  skills: ["shared-skill", "deploy"],
};

describe("resolveResource", () => {
  it("kind='program' 解析正确，返回绝对路径 = join(root, 相对路径)", () => {
    expect(resolveResource([pkgA], "program", "main")).toEqual({
      asset_id: "ast_a",
      name: "main",
      path: join("/cache/ast_a", "src/main.js"),
    });
  });

  it("kind='skill' 解析正确，返回技能目录路径", () => {
    expect(resolveResource([skillC], "skill", "review")).toEqual({
      asset_id: "ast_c",
      name: "review",
      path: join("/cache/ast_c", "review"),
    });
  });

  it("按传入顺序首个命中：前面的资产覆盖后面的同名资源", () => {
    expect(resolveResource([pkgA, toolB], "program", "shared")).toEqual({
      asset_id: "ast_a",
      name: "shared",
      path: join("/cache/ast_a", "a/shared.js"),
    });
    expect(resolveResource([toolB, pkgA], "program", "shared")).toEqual({
      asset_id: "ast_b",
      name: "shared",
      path: join("/cache/ast_b", "b/shared.js"),
    });
    expect(
      resolveResource([skillC, skillD], "skill", "shared-skill").asset_id,
    ).toBe("ast_c");
  });

  it("跨资产命中：前面的资产没有时命中后面的", () => {
    expect(resolveResource([pkgA, toolB], "program", "fetch")).toEqual({
      asset_id: "ast_b",
      name: "fetch",
      path: join("/cache/ast_b", "tools/fetch.js"),
    });
  });

  it("资源全无 → resource_not_found", () => {
    expect(() => resolveResource([pkgA, skillC], "program", "nope")).toThrow(
      /^resource_not_found: program nope$/,
    );
    expect(() => resolveResource([pkgA, skillC], "skill", "nope")).toThrow(
      /^resource_not_found: skill nope$/,
    );
    expect(() => resolveResource([], "program", "x")).toThrow(
      /^resource_not_found: program x$/,
    );
  });
});
