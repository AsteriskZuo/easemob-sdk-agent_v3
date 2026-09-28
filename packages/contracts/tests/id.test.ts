import { newEventId, newUlid } from "../src/id.js";

const CROCKFORD_BASE32 = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("id", () => {
  it("newUlid 为 26 字符 Crockford base32", () => {
    for (let i = 0; i < 100; i++) {
      expect(newUlid()).toMatch(CROCKFORD_BASE32);
    }
  });

  it("newEventId 带 'evt_' 前缀", () => {
    const id = newEventId();
    expect(id.startsWith("evt_")).toBe(true);
    expect(id.slice(4)).toMatch(CROCKFORD_BASE32);
  });

  it("连发 10000 个无重复", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      ids.add(newEventId());
    }
    expect(ids.size).toBe(10000);
  });
});
