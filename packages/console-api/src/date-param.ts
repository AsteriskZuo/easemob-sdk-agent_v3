import { ApiError } from "./errors.js";

/** YYYY-MM-DD 形状 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC 零点时刻回写成 YYYY-MM-DD（用于回绕校验：2026-02-30 会被 Date 吞成 03-02，必须拦下） */
function utcDateString(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 校验 YYYY-MM-DD 日历日（形状 + 真实存在性）；非法 → 400 invalid_input */
export function parseDateParam(raw: string, field: string): string {
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (
    !DATE_PATTERN.test(raw) ||
    Number.isNaN(ms) ||
    utcDateString(ms) !== raw
  ) {
    throw new ApiError(
      "invalid_input",
      `${field} 必须是合法的 YYYY-MM-DD: ${raw}`,
    );
  }
  return raw;
}
