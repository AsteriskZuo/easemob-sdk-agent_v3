import { randomBytes } from "node:crypto";

// Crockford base32（不含 I/L/O/U），标准大写
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const RANDOM_BYTES = (RANDOM_LENGTH * 5) / 8; // 80bit = 10 字节

function encodeTime(now: number): string {
  const chars: string[] = new Array(TIME_LENGTH);
  let value = now;
  for (let i = TIME_LENGTH - 1; i >= 0; i--) {
    chars[i] = ENCODING[value % 32];
    value = Math.floor(value / 32);
  }
  return chars.join("");
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_BYTES);
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ENCODING[(buffer >>> bits) & 0x1f];
      buffer &= (1 << bits) - 1;
    }
  }
  return result;
}

/** 手写 ULID：26 字符 Crockford base32 = 48bit 毫秒时间戳 + 80bit 随机（node:crypto） */
export function newUlid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

/** 事件 id：'evt_' + ulid（ULID 为标准大写 Crockford base32，对应设计示例 evt_01J...） */
export function newEventId(): string {
  return `evt_${newUlid()}`;
}
