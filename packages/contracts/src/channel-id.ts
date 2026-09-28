export const SEGMENT_SEPARATOR = "__";

export type ChannelId =
  | { kind: "business"; source: string; sessionId: string; businessId: string }
  | { kind: "exit"; destinationId: string };

export class ChannelIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelIdError";
  }
}

// 路径分隔符与控制字符
const ILLEGAL_CHARS = /[/\\:\x00-\x1f\x7f]/;

/** 段合法性：非空、不含 '__'、不含 '/' '\\' ':' 及控制字符；非法抛 ChannelIdError */
export function assertSafeSegment(segment: string): void {
  if (segment.length === 0) {
    throw new ChannelIdError("channel segment must be non-empty");
  }
  if (segment.includes(SEGMENT_SEPARATOR)) {
    throw new ChannelIdError(
      `channel segment must not contain "${SEGMENT_SEPARATOR}": ${segment}`,
    );
  }
  if (ILLEGAL_CHARS.test(segment)) {
    throw new ChannelIdError(
      `channel segment contains illegal characters: ${segment}`,
    );
  }
}

export function buildBusinessChannelId(
  source: string,
  sessionId: string,
  businessId: string,
): string {
  assertSafeSegment(source);
  assertSafeSegment(sessionId);
  assertSafeSegment(businessId);
  return [source, sessionId, businessId].join(SEGMENT_SEPARATOR);
}

export function buildExitChannelId(destinationId: string): string {
  assertSafeSegment(destinationId);
  return ["exit", destinationId].join(SEGMENT_SEPARATOR);
}

/** 解析；格式非法抛 ChannelIdError。'exit__' 前缀判为出口通道，否则按三段拆 */
export function parseChannelId(id: string): ChannelId {
  const exitPrefix = `exit${SEGMENT_SEPARATOR}`;
  if (id.startsWith(exitPrefix)) {
    const destinationId = id.slice(exitPrefix.length);
    assertSafeSegment(destinationId);
    return { kind: "exit", destinationId };
  }

  const parts = id.split(SEGMENT_SEPARATOR);
  if (parts.length !== 3) {
    throw new ChannelIdError(
      `business channel id must have 3 segments, got ${parts.length}: ${id}`,
    );
  }
  const [source, sessionId, businessId] = parts;
  assertSafeSegment(source);
  assertSafeSegment(sessionId);
  assertSafeSegment(businessId);
  return { kind: "business", source, sessionId, businessId };
}
