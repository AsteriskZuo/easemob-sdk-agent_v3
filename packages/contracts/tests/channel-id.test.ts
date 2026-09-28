import {
  assertSafeSegment,
  buildBusinessChannelId,
  buildExitChannelId,
  ChannelIdError,
  parseChannelId,
  SEGMENT_SEPARATOR,
} from "../src/channel-id.js";

describe("channel-id", () => {
  it("业务通道 build → parse 往返一致", () => {
    const id = buildBusinessChannelId("wecom", "wmAb3xK9Qf", "b01J8xk");
    expect(id).toBe("wecom__wmAb3xK9Qf__b01J8xk");
    expect(parseChannelId(id)).toEqual({
      kind: "business",
      source: "wecom",
      sessionId: "wmAb3xK9Qf",
      businessId: "b01J8xk",
    });
  });

  it("出口通道 build → parse 往返一致", () => {
    const id = buildExitChannelId("wmAb3xK9Qf");
    expect(id).toBe(`exit${SEGMENT_SEPARATOR}wmAb3xK9Qf`);
    expect(parseChannelId(id)).toEqual({
      kind: "exit",
      destinationId: "wmAb3xK9Qf",
    });
  });

  it.each(["a__b", "a/b", "a\\b", "a:b", "", "a\tb"])(
    "段含非法内容（%j）→ assertSafeSegment 抛 ChannelIdError",
    (segment) => {
      expect(() => assertSafeSegment(segment)).toThrow(ChannelIdError);
    },
  );

  it("build 时段含 '__' → 抛 ChannelIdError", () => {
    expect(() => buildBusinessChannelId("wecom", "a__b", "b01")).toThrow(
      ChannelIdError,
    );
    expect(() => buildExitChannelId("a__b")).toThrow(ChannelIdError);
  });

  it("'exit' 前缀的 id 解析为出口通道", () => {
    const parsed = parseChannelId("exit__wmAb3xK9Qf");
    expect(parsed).toEqual({ kind: "exit", destinationId: "wmAb3xK9Qf" });
  });

  it("exit 前缀但 destination 为空 → 抛 ChannelIdError", () => {
    expect(() => parseChannelId("exit__")).toThrow(ChannelIdError);
  });

  it("业务通道段数不是 3 → 抛 ChannelIdError", () => {
    expect(() => parseChannelId("wecom__wmAb3xK9Qf")).toThrow(ChannelIdError);
    expect(() => parseChannelId("a__b__c__d")).toThrow(ChannelIdError);
    expect(() => parseChannelId("plain")).toThrow(ChannelIdError);
  });

  it("业务通道含空段 → 抛 ChannelIdError", () => {
    expect(() => parseChannelId("a____b")).toThrow(ChannelIdError);
  });

  it("单下划线 '_' 的段合法", () => {
    const destinationId = "github.com_AsteriskZuo_im_flutter_sdk";
    assertSafeSegment(destinationId);
    const id = buildExitChannelId(destinationId);
    expect(parseChannelId(id)).toEqual({
      kind: "exit",
      destinationId,
    });
    const business = buildBusinessChannelId(
      "jira",
      "j1.private.easemob.com_HIM-23363",
      "b_01",
    );
    expect(parseChannelId(business)).toEqual({
      kind: "business",
      source: "jira",
      sessionId: "j1.private.easemob.com_HIM-23363",
      businessId: "b_01",
    });
  });

  it("ChannelIdError 是 Error 子类且 name 正确", () => {
    const error = new ChannelIdError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ChannelIdError");
  });
});
