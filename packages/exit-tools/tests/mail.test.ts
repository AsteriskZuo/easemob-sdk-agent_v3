import { jest } from "@jest/globals";
import { createMailExitTool } from "../src/index.js";

const baseConfig: Record<string, string> = {
  host: "smtp.example.com",
  port: "25",
  user: "u@example.com",
  pass: "secret-pass",
  from: "a@example.com",
  to: "b@example.com",
};

function makeFakeTransport() {
  const sendMail = jest
    .fn<(options: unknown) => Promise<unknown>>()
    .mockResolvedValue({ messageId: "1" });
  const capturedConfigs: Record<string, string>[] = [];
  const createTransport = (config: Record<string, string>) => {
    capturedConfigs.push({ ...config });
    return { sendMail };
  };
  return { sendMail, capturedConfigs, createTransport };
}

describe("mail destinationOf", () => {
  const tool = createMailExitTool();

  it("destinationOf = to", () => {
    expect(tool.destinationOf(baseConfig)).toBe("b@example.com");
  });

  it("缺 to → 抛错", () => {
    expect(() => tool.destinationOf({})).toThrow("'to'");
  });
});

describe("mail bind", () => {
  const tool = createMailExitTool();

  it("port 非法 → 抛错", () => {
    expect(() => tool.bind({ ...baseConfig, port: "abc" })).toThrow("port");
  });

  it("缺 required 项 → 抛错", () => {
    const { pass: _pass, ...noPass } = baseConfig;
    expect(() => tool.bind(noPass)).toThrow("'pass'");
    const { host: _host, ...noHost } = baseConfig;
    expect(() => tool.bind(noHost)).toThrow("'host'");
  });

  it("port: '465' → secure=true（归一化进 transport config）", () => {
    const fake = makeFakeTransport();
    const tool465 = createMailExitTool(fake.createTransport);
    tool465.bind({ ...baseConfig, port: "465" });
    expect(fake.capturedConfigs).toHaveLength(1);
    expect(fake.capturedConfigs[0].secure).toBe("true");
  });

  it("port 非 465 → secure=false", () => {
    const fake = makeFakeTransport();
    const tool25 = createMailExitTool(fake.createTransport);
    tool25.bind(baseConfig);
    expect(fake.capturedConfigs[0].secure).toBe("false");
  });
});

describe("mail deliver", () => {
  it("sendMail 收到正确的 from/to/subject/text（对象 payload 走 json 文本）", async () => {
    const fake = makeFakeTransport();
    const tool = createMailExitTool(fake.createTransport);
    const exit = tool.bind(baseConfig);
    const payload = { ok: 1 };
    await exit.deliver(payload);
    expect(fake.sendMail).toHaveBeenCalledTimes(1);
    expect(fake.sendMail).toHaveBeenCalledWith({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Easemob Agent 通知",
      text: "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
    });
  });

  it("字符串 payload → text 原样；subject 可配置", async () => {
    const fake = makeFakeTransport();
    const tool = createMailExitTool(fake.createTransport);
    const exit = tool.bind({ ...baseConfig, subject: "告警" });
    await exit.deliver("plain text");
    expect(fake.sendMail).toHaveBeenCalledWith({
      from: "a@example.com",
      to: "b@example.com",
      subject: "告警",
      text: "plain text",
    });
  });

  it("sendMail 拒绝 → deliver 抛错", async () => {
    const fake = makeFakeTransport();
    fake.sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const tool = createMailExitTool(fake.createTransport);
    const exit = tool.bind(baseConfig);
    await expect(exit.deliver("x")).rejects.toThrow("smtp down");
  });
});
