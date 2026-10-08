import { openDatabase } from "@asterisk/agent-database";
import type { Database } from "@asterisk/agent-database";
import type {
  ConfigField,
  ExitRegistry,
  ExitTool,
} from "@asterisk/agent-exit-tools";
import type { ExitBinding } from "@asterisk/agent-registry";
import { createEnvProvider } from "@asterisk/agent-runtime";
import type { EnvProvider } from "@asterisk/agent-runtime";
import { createExitDriver, exitSecretKey } from "../src/index.js";

const BUSINESS_ID = "b_test_exit";

let db: Database;
let env: EnvProvider;

/** 假 ExitRegistry：记录 destinationOf/bind 收到的 config，可断言回填行为 */
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
): ExitBinding {
  return { business_id: BUSINESS_ID, tool, config };
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
    // 透传：收到的就是 binding.config 本体（机密回填不应发生在 destinationOf）
    expect(fake.destinationOfCalls).toHaveLength(1);
    expect(fake.destinationOfCalls[0]).toBe(binding.config);
  });

  it("机密回填：secrets 桶有 exit.fake.pass → bind 收到合并后 config", async () => {
    const fake = makeFakeRegistry();
    env.set(BUSINESS_ID, "secrets", exitSecretKey("fake", "pass"), "p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(makeBinding({ host: "h1" }), { ok: 1 });
    expect(fake.bindCalls).toHaveLength(1);
    expect(fake.bindCalls[0]).toEqual({ host: "h1", pass: "p@ss" });
    expect(fake.delivered).toEqual([{ ok: 1 }]);
  });

  it("secrets 无回填键 → 不回填（bind 侧 required 抛错透出）", async () => {
    const fake = makeFakeRegistry();
    const driver = createExitDriver({ exits: fake.registry, env });
    await expect(
      driver.deliver(makeBinding({ host: "h1" }), { ok: 1 }),
    ).rejects.toThrow(/pass/);
  });

  it("secret:false 的项绝不回填（即使 secrets 有同名键）", async () => {
    const fake = makeFakeRegistry();
    // host 是非机密项：同名 secrets 键存在也绝不回填写
    env.set(BUSINESS_ID, "secrets", exitSecretKey("fake", "host"), "evil");
    env.set(BUSINESS_ID, "secrets", exitSecretKey("fake", "pass"), "p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(makeBinding({ host: "h1" }), null);
    expect(fake.bindCalls[0]).toEqual({ host: "h1", pass: "p@ss" });
  });

  it("通用层 secrets 同样参与回填（getFor 合并语义）", async () => {
    const fake = makeFakeRegistry();
    env.set(null, "secrets", exitSecretKey("fake", "pass"), "global-p@ss");
    const driver = createExitDriver({ exits: fake.registry, env });
    await driver.deliver(makeBinding({ host: "h1" }), null);
    expect(fake.bindCalls[0]).toEqual({ host: "h1", pass: "global-p@ss" });
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
