import { createWecomAibotExitTool } from "../src/wecom-aibot.js";
import type { AibotSender } from "../src/wecom-aibot.js";

/** 记录调用的假 sender + 记录 botId 的解析器 */
function makeResolveSender() {
  const calls: { botIds: string[]; sends: Array<[string, string]> } = {
    botIds: [],
    sends: [],
  };
  const sender: AibotSender = {
    async send(chatId, markdownContent) {
      calls.sends.push([chatId, markdownContent]);
    },
  };
  const resolveSender = (botId: string): AibotSender => {
    calls.botIds.push(botId);
    return sender;
  };
  return { calls, resolveSender, sender };
}

const fullConfig = {
  bot_id: "bot-123",
  chat_id: "chat-456",
  user_id: "user-789",
};

describe("wecom-aibot destinationOf", () => {
  const tool = createWecomAibotExitTool({
    resolveSender: () => ({ send: async () => {} }),
  });

  it("三段以 __ 拼接", () => {
    expect(tool.destinationOf(fullConfig)).toBe("bot-123__chat-456__user-789");
  });

  it("三段均 trim", () => {
    expect(
      tool.destinationOf({
        bot_id: "  bot-123  ",
        chat_id: " chat-456\t",
        user_id: "\nuser-789",
      }),
    ).toBe("bot-123__chat-456__user-789");
  });

  it("/ \\ : 与控制字符替换为 _", () => {
    expect(
      tool.destinationOf({
        bot_id: "a/b\\c:d",
        chat_id: "e\rf",
        user_id: "gh",
      }),
    ).toBe("a_b_c_d__e_f__g_h");
  });

  it("缺 bot_id → 抛错", () => {
    expect(() => tool.destinationOf({ ...fullConfig, bot_id: "" })).toThrow(
      "'bot_id'",
    );
  });

  it("缺 chat_id → 抛错", () => {
    expect(() => tool.destinationOf({ ...fullConfig, chat_id: "  " })).toThrow(
      "'chat_id'",
    );
  });

  it("缺 user_id → 抛错", () => {
    expect(() => tool.destinationOf({ ...fullConfig, user_id: "" })).toThrow(
      "'user_id'",
    );
  });
});

describe("wecom-aibot bind", () => {
  it("resolveSender 收到正确 bot_id（bind 时立即解析）", () => {
    const { calls, resolveSender } = makeResolveSender();
    const tool = createWecomAibotExitTool({ resolveSender });
    tool.bind(fullConfig);
    expect(calls.botIds).toEqual(["bot-123"]);
  });

  it("不注入 resolveSender → 抛错", () => {
    const tool = createWecomAibotExitTool();
    expect(() => tool.bind(fullConfig)).toThrow(
      "需要装配根注入 AibotSender 解析器（resolveSender）",
    );
  });

  it("不注入 resolveSender 时缺配置仍先报配置缺失", () => {
    const tool = createWecomAibotExitTool();
    expect(() => tool.bind({ ...fullConfig, bot_id: "" })).toThrow("'bot_id'");
  });

  it("resolveSender 自身抛错 → 原样透出", () => {
    const boom = new Error("connector not found: bot-123");
    const tool = createWecomAibotExitTool({
      resolveSender: () => {
        throw boom;
      },
    });
    expect(() => tool.bind(fullConfig)).toThrow(boom);
  });

  it("bind 缺 user_id → 抛错", () => {
    const tool = createWecomAibotExitTool({
      resolveSender: () => ({ send: async () => {} }),
    });
    expect(() => tool.bind({ ...fullConfig, user_id: "" })).toThrow(
      "'user_id'",
    );
  });
});

describe("wecom-aibot deliver", () => {
  it("字符串 payload → 原样发送，chat_id 正确", async () => {
    const { calls, resolveSender } = makeResolveSender();
    const tool = createWecomAibotExitTool({ resolveSender });
    await tool.bind(fullConfig).deliver("hello 世界");
    expect(calls.sends).toEqual([["chat-456", "hello 世界"]]);
  });

  it("对象 payload → json 围栏", async () => {
    const { calls, resolveSender } = makeResolveSender();
    const tool = createWecomAibotExitTool({ resolveSender });
    const payload = { ok: 1, list: ["a"] };
    await tool.bind(fullConfig).deliver(payload);
    expect(calls.sends).toEqual([
      ["chat-456", "```json\n" + JSON.stringify(payload, null, 2) + "\n```"],
    ]);
  });

  it("超长 payload（>20480 字节，多字节中文）→ 截断且追加「已截断」", async () => {
    const { calls, resolveSender } = makeResolveSender();
    const tool = createWecomAibotExitTool({ resolveSender });
    await tool.bind(fullConfig).deliver("汉".repeat(10_000)); // 30000 字节
    const content = calls.sends[0][1];
    expect(content.endsWith("\n…(已截断)")).toBe(true);
    const suffixBytes = Buffer.byteLength("\n…(已截断)", "utf8");
    const contentBytes = Buffer.byteLength(content, "utf8");
    expect(contentBytes).toBeLessThanOrEqual(20480 + suffixBytes);
    expect(contentBytes).toBeGreaterThan(20480);
    expect(content).not.toContain("�");
  });

  it("恰好不超限时原样发送（不追加标记）", async () => {
    const { calls, resolveSender } = makeResolveSender();
    const tool = createWecomAibotExitTool({ resolveSender });
    const text = "a".repeat(20480);
    await tool.bind(fullConfig).deliver(text);
    expect(calls.sends).toEqual([["chat-456", text]]);
  });

  it("sender.send 拒绝 → deliver 抛错", async () => {
    const tool = createWecomAibotExitTool({
      resolveSender: () => ({
        async send() {
          throw new Error("errcode=93001 当前群聊不允许推送消息");
        },
      }),
    });
    await expect(tool.bind(fullConfig).deliver("x")).rejects.toThrow("93001");
  });
});
