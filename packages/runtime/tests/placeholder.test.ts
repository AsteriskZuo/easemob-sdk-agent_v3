import { openDatabase } from "@asteriskzuo/agent-database";
import {
  createEnvProvider,
  extractPlaceholderKeys,
  PlaceholderError,
  resolveConfigPlaceholders,
  resolveString,
} from "../src/index.js";
import type { EnvProvider } from "../src/index.js";

function newProvider(): { env: EnvProvider; close: () => void } {
  const db = openDatabase(":memory:");
  return { env: createEnvProvider(db), close: () => db.close() };
}

describe("EnvProvider.lookup", () => {
  it("四级顺序：业务 secrets → 业务 vars → 全局 secrets → 全局 vars", () => {
    const { env, close } = newProvider();
    env.set(null, "vars", "k", "global-var");
    expect(env.lookup("b1", "k")).toBe("global-var");

    env.set(null, "secrets", "k", "global-secret");
    expect(env.lookup("b1", "k")).toBe("global-secret");

    env.set("b1", "vars", "k", "biz-var");
    expect(env.lookup("b1", "k")).toBe("biz-var");

    env.set("b1", "secrets", "k", "biz-secret");
    expect(env.lookup("b1", "k")).toBe("biz-secret");
    close();
  });

  it("业务隔离：同名 key 不同业务各自取值，不串桶", () => {
    const { env, close } = newProvider();
    env.set("b1", "secrets", "jira_password", "pw-b1");
    env.set("b2", "secrets", "jira_password", "pw-b2");
    expect(env.lookup("b1", "jira_password")).toBe("pw-b1");
    expect(env.lookup("b2", "jira_password")).toBe("pw-b2");
    // b3 无业务层配置 → 全局兜底；全局也无 → undefined
    expect(env.lookup("b3", "jira_password")).toBeUndefined();
    close();
  });

  it("业务未命中时全局兜底", () => {
    const { env, close } = newProvider();
    env.set(null, "secrets", "token", "global");
    expect(env.lookup("b9", "token")).toBe("global");
    close();
  });
});

describe("extractPlaceholderKeys", () => {
  it("提取全部字符串值的占位 key（去重、排序）", () => {
    const keys = extractPlaceholderKeys({
      a: "{{z_key}}",
      b: "prefix-{{a_key}}-{{a_key}}",
      c: 42,
      d: "no placeholder",
      e: "{{}}",
    });
    expect(keys).toEqual(["a_key", "z_key"]);
  });

  it("key trim 后计入；空白占位忽略", () => {
    expect(extractPlaceholderKeys({ a: "{{ spaced }}" })).toEqual(["spaced"]);
  });
});

describe("resolveString", () => {
  it("整值占位与内嵌占位都替换", () => {
    const { env, close } = newProvider();
    env.set("b1", "secrets", "wecom_key", "9d4a");
    env.set("b1", "vars", "host", "qyapi.weixin.qq.com");
    expect(resolveString("{{wecom_key}}", env, "b1")).toBe("9d4a");
    expect(
      resolveString(
        "https://{{host}}/cgi-bin/webhook/send?key={{wecom_key}}",
        env,
        "b1",
      ),
    ).toBe("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=9d4a");
    close();
  });

  it("缺失 key 抛 PlaceholderError，message 不含任何桶值", () => {
    const { env, close } = newProvider();
    env.set("b1", "secrets", "present", "secret-value-xyz");
    try {
      resolveString("{{missing_a}}-{{present}}-{{missing_b}}", env, "b1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PlaceholderError);
      const pe = err as PlaceholderError;
      expect(pe.keys).toEqual(["missing_a", "missing_b"]);
      expect(pe.message).not.toContain("secret-value-xyz");
    }
    close();
  });

  it("不递归：替换进来的值里的 {{}} 不二次展开", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "outer", "{{inner}}");
    env.set("b1", "vars", "inner", "deep");
    expect(resolveString("{{outer}}", env, "b1")).toBe("{{inner}}");
    close();
  });

  it("空占位 {{}} 原样保留", () => {
    const { env, close } = newProvider();
    expect(resolveString("a{{}}b", env, "b1")).toBe("a{{}}b");
    close();
  });
});

describe("resolveConfigPlaceholders", () => {
  it("仅第一层字符串值参与；非字符串透传；不改入参", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "x", "X");
    const input: Record<string, unknown> = {
      s: "{{x}}",
      n: 7,
      nested: { deep: "{{x}}" },
    };
    const out = resolveConfigPlaceholders(input, env, "b1");
    expect(out).toEqual({ s: "X", n: 7, nested: { deep: "{{x}}" } });
    expect(input.s).toBe("{{x}}");
    close();
  });

  it("多字段缺失 key 汇总一次抛出", () => {
    const { env, close } = newProvider();
    env.set("b1", "vars", "ok", "v");
    try {
      resolveConfigPlaceholders(
        { a: "{{miss1}}", b: "{{ok}}", c: "{{miss2}}" },
        env,
        "b1",
      );
      expect.unreachable();
    } catch (err) {
      expect((err as PlaceholderError).keys).toEqual(["miss1", "miss2"]);
    }
    close();
  });
});
