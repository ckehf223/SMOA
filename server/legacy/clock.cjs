"use strict";
const M = require("./model.cjs");

function parseClock(value, { required = false } = {}) {
  if (value == null || String(value).trim() === "") {
    M.assert(!required, "시간을 입력해 주세요.");
    return "";
  }
  if (value instanceof Date) {
    M.assert(Number.isFinite(value.getTime()), "시각을 확인해 주세요.");
    return M.time(value.toISOString().slice(11, 16), true);
  }
  if (typeof value === "number") {
    if (value >= 0 && value < 1) {
      const minutes = Math.round(value * 1440) % 1440;
      return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    }
    M.assert(
      Number.isInteger(value),
      "시각은 17, 17:00, 1700, 1710처럼 입력해 주세요.",
    );
  }
  const text = String(value).trim();
  const match =
    text.match(/^(\d{1,2}):(\d{2})$/) ||
    text.match(/^(\d{1,2})(\d{2})$/) ||
    text.match(/^(\d{1,2})(?:시(?:(\d{1,2})분)?)?$/);
  M.assert(match, "시각은 17, 17:00, 1700, 1710처럼 입력해 주세요.");
  return M.time(
    `${match[1].padStart(2, "0")}:${(match[2] || "00").padStart(2, "0")}`,
    true,
  );
}

module.exports = { parseClock };
