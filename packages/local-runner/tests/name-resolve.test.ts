import { describe, expect, it } from "@jest/globals";
import { resolveResource } from "../src/name-resolve.js";
import type { ResolvedAsset } from "../src/name-resolve.js";

/**
 * 名解析测试：与平台 packages/asset-registry/src/resolve.ts 的行为逐条对齐——
 * 按资产数组顺序首个命中、program 路径 = join(root, 清单相对路径)、
 * skill 路径 = join(root, 技能目录相对路径)（叶子级 rel = "."）、
 * 全无抛 `resource_not_found: <kind> <name>`。
 */

/** 构造资产视图项的便捷函数（缺省空 programs / 空 skills）。 */
function asset(partial: Partial<ResolvedAsset> & { name: string }): ResolvedAsset {
  return { root: `/assets/${partial.name}`, programs: {}, skills: {}, ...partial };
}

describe("resolveResource 与平台 resolve.ts 语义对齐", () => {
  it("program：命中后路径 = join(root, 清单相对路径)", () => {
    const assets = [
      asset({ name: "pkg", programs: { main: "dist/main.js" } }),
    ];
    expect(resolveResource(assets, "program", "main")).toEqual({
      asset_name: "pkg",
      name: "main",
      path: "/assets/pkg/dist/main.js",
    });
  });

  it("program：按资产数组顺序首个命中（同名程序取靠前资产）", () => {
    const assets = [
      asset({ name: "pkg", programs: { shared: "dist/pkg-shared.js" } }),
      asset({ name: "tool", programs: { shared: "dist/tool-shared.js" } }),
    ];
    const hit = resolveResource(assets, "program", "shared");
    expect(hit.asset_name).toBe("pkg");
    expect(hit.path).toBe("/assets/pkg/dist/pkg-shared.js");
  });

  it("program：靠前资产未命中时取靠后资产", () => {
    const assets = [
      asset({ name: "pkg", programs: { main: "dist/main.js" } }),
      asset({ name: "tool", programs: { "wecom-notify": "dist/notify.js" } }),
    ];
    const hit = resolveResource(assets, "program", "wecom-notify");
    expect(hit.asset_name).toBe("tool");
    expect(hit.path).toBe("/assets/tool/dist/notify.js");
  });

  it("skill：命中后路径 = join(root, 技能目录相对路径)（集合级 = 目录名）", () => {
    const assets = [
      asset({ name: "pkg", programs: { main: "dist/main.js" } }),
      asset({ name: "skills", skills: { "review-guide": "review-guide" } }),
    ];
    expect(resolveResource(assets, "skill", "review-guide")).toEqual({
      asset_name: "skills",
      name: "review-guide",
      path: "/assets/skills/review-guide",
    });
  });

  it("skill：叶子级资产（rel = '.'）路径 = 资产根本身", () => {
    const assets = [
      asset({
        name: "skill-one",
        root: "/assets/skill-one/skills/review-guide",
        skills: { "review-guide": "." },
      }),
    ];
    expect(resolveResource(assets, "skill", "review-guide")).toEqual({
      asset_name: "skill-one",
      name: "review-guide",
      path: "/assets/skill-one/skills/review-guide",
    });
  });

  it("skill：同名技能按资产顺序首个命中", () => {
    const assets = [
      asset({ name: "skill-a", skills: { dup: "dup", alpha: "alpha" } }),
      asset({ name: "skill-b", skills: { dup: "dup", beta: "beta" } }),
    ];
    const hit = resolveResource(assets, "skill", "dup");
    expect(hit.asset_name).toBe("skill-a");
    expect(hit.path).toBe("/assets/skill-a/dup");
  });

  it("kind 区分：skill 资产的同名目录不算 program 命中，反之亦然", () => {
    const assets = [
      asset({ name: "skill-asset", skills: { "wecom-notify": "wecom-notify" } }),
      asset({ name: "tool-asset", programs: { "review-guide": "dist/x.js" } }),
    ];
    expect(() =>
      resolveResource(assets, "program", "wecom-notify"),
    ).toThrow("resource_not_found: program wecom-notify");
    expect(() => resolveResource(assets, "skill", "review-guide")).toThrow(
      "resource_not_found: skill review-guide",
    );
  });

  it("全无命中：错误消息格式与平台逐字一致 resource_not_found: <kind> <name>", () => {
    expect(() => resolveResource([], "program", "main")).toThrow(
      /^resource_not_found: program main$/,
    );
    expect(() => resolveResource([], "skill", "guide")).toThrow(
      /^resource_not_found: skill guide$/,
    );
  });
});
