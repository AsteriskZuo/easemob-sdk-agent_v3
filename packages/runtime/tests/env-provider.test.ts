import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@asterisk/agent-database";
import { createEnvProvider } from "../src/index.js";
import type { EnvProvider } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-runtime-env-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newProvider(): { env: EnvProvider; close: () => void } {
  const db = openDatabase(":memory:");
  return { env: createEnvProvider(db), close: () => db.close() };
}

describe("set / getFor", () => {
  it("vars 与 secrets 各自隔离，往返一致", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "region", "cn");
    env.set("b1", "secrets", "api_key", "sk-1");
    const cfg = env.getFor("b1");
    expect(cfg.vars).toEqual({ region: "cn" });
    expect(cfg.secrets).toEqual({ api_key: "sk-1" });
    close();
  });

  it("通用层 + 业务层合并，同名 key 业务优先", () => {
    const { env, close } = newProvider();
    env.set(null, "vars", "region", "global");
    env.set(null, "vars", "lang", "zh");
    env.set(null, "secrets", "token", "global-token");
    env.set("b1", "vars", "region", "cn");
    env.set("b2", "vars", "region", "us");

    expect(env.getFor("b1")).toEqual({
      vars: { region: "cn", lang: "zh" },
      secrets: { token: "global-token" },
    });
    expect(env.getFor("b2")).toEqual({
      vars: { region: "us", lang: "zh" },
      secrets: { token: "global-token" },
    });
    // 无业务层配置的业务 → 只看到通用层
    expect(env.getFor("b3")).toEqual({
      vars: { region: "global", lang: "zh" },
      secrets: { token: "global-token" },
    });
    close();
  });

  it("set 同 key 重复写 = upsert 覆盖", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "k", "v1");
    env.set("b1", "vars", "k", "v2");
    expect(env.getFor("b1").vars).toEqual({ k: "v2" });
    close();
  });
});

describe("remove / list", () => {
  it("remove 生效且幂等", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "k", "v");
    env.remove("b1", "vars", "k");
    expect(env.getFor("b1").vars).toEqual({});
    env.remove("b1", "vars", "k"); // 不存在幂等不抛错
    env.remove("b1", "vars", "never-existed");
    close();
  });

  it("remove 只删指定层：业务层删除后通用层仍在", () => {
    const { env, close } = newProvider();
    env.set(null, "vars", "k", "global");
    env.set("b1", "vars", "k", "cn");
    env.remove("b1", "vars", "k");
    expect(env.getFor("b1").vars).toEqual({ k: "global" });
    close();
  });

  it("list：vars 明文返回、secrets 只给键名", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "region", "cn");
    env.set("b1", "secrets", "api_key", "sk-1");
    env.set("b1", "secrets", "token", "t-1");
    expect(env.list("b1")).toEqual({
      vars: { region: "cn" },
      secret_keys: ["api_key", "token"],
    });
    // 通用层与业务层隔离展示
    env.set(null, "vars", "lang", "zh");
    expect(env.list(null)).toEqual({ vars: { lang: "zh" }, secret_keys: [] });
    expect(env.list("b1").vars).toEqual({ region: "cn" });
    close();
  });
});

describe("key 校验", () => {
  it("空白/空串 key → 抛错；value 空串允许", () => {
    const { env, close } = newProvider();
    expect(() => env.set("b1", "vars", "", "v")).toThrow(/^invalid_env_key/);
    expect(() => env.set("b1", "vars", "  ", "v")).toThrow(/^invalid_env_key/);
    expect(() => env.set("b1", "vars", " k", "v")).toThrow(/^invalid_env_key/);
    expect(() => env.set("b1", "vars", "k ", "v")).toThrow(/^invalid_env_key/);
    env.set("b1", "vars", "empty_ok", "");
    expect(env.getFor("b1").vars).toEqual({ empty_ok: "" });
    close();
  });
});

describe("持久化", () => {
  it("close 重开后 getFor 一致", () => {
    const dbPath = join(tmpDir, "platform.db");
    const db1 = openDatabase(dbPath);
    const env1 = createEnvProvider(db1);
    env1.set(null, "vars", "lang", "zh");
    env1.set("b1", "vars", "region", "cn");
    env1.set("b1", "secrets", "api_key", "sk-1");
    db1.close();

    const db2 = openDatabase(dbPath);
    const env2 = createEnvProvider(db2);
    expect(env2.getFor("b1")).toEqual({
      vars: { lang: "zh", region: "cn" },
      secrets: { api_key: "sk-1" },
    });
    db2.close();
  });
});
