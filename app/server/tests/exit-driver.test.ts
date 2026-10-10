import { openDatabase } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import type {
  ConfigField,
  ExitRegistry,
  ExitTool,
} from "@asteriskzuo/agent-exit-tools";
import type { ExitBinding } from "@asteriskzuo/agent-registry";
import {
  createEnvProvider,
  PlaceholderError,
} from "@asteriskzuo/agent-runtime";
import type { EnvProvider } from "@asteriskzuo/agent-runtime";
import { createExitDriver } from "../src/index.js";

const BUSINESS_ID = "b_test_exit";

let db: Database;
let env: EnvProvider;

/** 假 ExitRegistry：记录 destinationOf/bind 收到的 config，可断言占位解析行为 */
interface FakeRegistry {
  registry: ExitRegistry;
  destinationOfCalls: Array<Record<string, string>>;
  bindCalls: Array<Record<string, string>>;
  delivered: unknown[];
}

function makeFakeRegistry(schema?: ConfigField[]): FakeRegistry {
  const destinationOfCalls: Array<Record<string, string>> = [];
  const bindCalls: Array<Record<string, string>> = [];
  const delivered: unknown[] = [];
  const tool: ExitTool = {
    kind: "fake",
    name: "假工具",
    implemented: true,
    configSchema: schema ?? [
      { key: "host", label: "主机", required: true },
      { key: "pass", label: "口令", required: true, secret: true },
    ],
    resultDoc: "# 假工具：sdk.return 期望形状（测试 fixture）",
    destinationOf(config) {
      destinationOfCalls.push(config);
      return `dest:${config.host ?? "?"}`;
    },
    bind(config) {
      bindCalls.push(config);
      // 模拟真实工具的 required 校验
      for (const field of tool.configSchema) {
        if (field.required === true && !config[field.key]) {
          throw new Error(`出口工具 'fake' 缺少必需配置项 '${field.key}'`);
        }
      }
      return {
        async deliver(result) {
          delivered.push(result);
        },
      };
    },
  };
  return {
    registry: {
      get(kind) {
        if (kind !== "fake") throw new Error(`未注册的出口工具：'${kind}'`);
        return tool;
      },
      list() {
        return [tool];
      },
    },
    destinationOfCalls,
    bindCalls,
    delivered,
  };
}

function makeBinding(
  config: Record<string, string>,
  tool = "fake",
  business_id = BUSINESS_ID,
): ExitBinding {
  return { business_id, tool, config };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  env = createEnvProvider(db);
});

afterEach(() => {
  db.close();
});

describe("createExitDriver", () => {
  it("destinationOf 透传 tool.destinationOf(binding.config)", () => {
    const fake = makeFakeRegistry();
    const driver = createExitDriver({ exits: fake.registry, env });
    const binding = makeBinding({ host: "h1" });
    expect(driver.destinationOf(binding)).toBe("dest:h1");
    // 透传：收到的就是 binding.config 本体（占位解析不应发生在 destinationOf）
    expect(fake.destinationOfCalls).toHaveLength(1);
    expect(fake.destinationOfCalls[0]).toBe(binding.config);
  });

  it("destinationOf 收到含占位的 config：不解析、原样传给工具", () => {
    const fake = makeFakeRegistry();
    env.set(BUSINESS_ID, "secrets", "fake_pass", "p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    const binding = makeBinding({ host: "h1", pass: "{{fake_pass}}" });
    driver.destinationOf(binding);
    // 原始模板文本原样透传（不解析占位，secret 不进 destinationId）
    expect(fake.destinationOfCalls[0]).toBe(binding.config);
    expect(fake.destinationOfCalls[0].pass).toBe("{{fake_pass}}");
  });

  it("占位解析：config 值含 {{key}} → deliver 前解析，bind 收到明文", async () => {
    const fake = makeFakeRegistry();
    env.set(BUSINESS_ID, "secrets", "fake_pass", "p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(makeBinding({ host: "h1", pass: "{{fake_pass}}" }), {
      ok: 1,
    });
    expect(fake.bindCalls).toHaveLength(1);
    expect(fake.bindCalls[0]).toEqual({ host: "h1", pass: "p@ss" });
    expect(fake.delivered).toEqual([{ ok: 1 }]);
  });

  it("内嵌占位：值的一部分是 {{key}} → 纯字符串替换", async () => {
    const fake = makeFakeRegistry();
    env.set(BUSINESS_ID, "vars", "fake_host", "smtp.example.com");
    env.set(BUSINESS_ID, "secrets", "fake_pass", "p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(
      makeBinding({ host: "https://{{fake_host}}:465", pass: "{{fake_pass}}" }),
      null,
    );
    expect(fake.bindCalls[0]).toEqual({
      host: "https://smtp.example.com:465",
      pass: "p@ss",
    });
  });

  it("占位缺失 → 抛 PlaceholderError（含缺失键名）", async () => {
    const fake = makeFakeRegistry();
    const driver = createExitDriver({ exits: fake.registry, env });
    const err = await driver
      .deliver(makeBinding({ host: "h1", pass: "{{missing_key}}" }), null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaceholderError);
    expect((err as PlaceholderError).keys).toEqual(["missing_key"]);
    expect((err as Error).message).toContain("missing_key");
    // 解析失败即抛出，bind 不应被调用
    expect(fake.bindCalls).toHaveLength(0);
  });

  it("两业务同名 key 隔离：解析严格落在 binding.business_id 上", async () => {
    const fake = makeFakeRegistry();
    env.set("b_a", "secrets", "shared_key", "pass-a");
    env.set("b_b", "secrets", "shared_key", "pass-b");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(
      makeBinding({ host: "h1", pass: "{{shared_key}}" }, "fake", "b_a"),
      null,
    );
    await driver.deliver(
      makeBinding({ host: "h1", pass: "{{shared_key}}" }, "fake", "b_b"),
      null,
    );
    expect(fake.bindCalls[0].pass).toBe("pass-a");
    expect(fake.bindCalls[1].pass).toBe("pass-b");
  });

  it("通用层兜底：业务桶无 key 时落全局桶", async () => {
    const fake = makeFakeRegistry();
    env.set(null, "secrets", "fake_pass", "global-p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(
      makeBinding({ host: "h1", pass: "{{fake_pass}}" }),
      null,
    );
    expect(fake.bindCalls[0]).toEqual({ host: "h1", pass: "global-p@ss" });
  });

  it("无占位的 config 原样 bind（解析是恒等透传）", async () => {
    const fake = makeFakeRegistry();
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(makeBinding({ host: "h1", pass: "plain" }), null);
    expect(fake.bindCalls[0]).toEqual({ host: "h1", pass: "plain" });
  });

  it("未知 tool → exits.get 抛错透出", async () => {
    const fake = makeFakeRegistry();
    const driver = createExitDriver({ exits: fake.registry, env });
    expect(() => driver.destinationOf(makeBinding({}, "unknown"))).toThrow(
      /未注册/,
    );
    await expect(
      driver.deliver(makeBinding({}, "unknown"), null),
    ).rejects.toThrow(/未注册/);
  });
});
