"use strict";
const M = require("./model.cjs");
function dropoutDate(person) {
  return person.status === "dropped"
    ? person.lifecycle
        .findLast((event) => event.to === "dropped")
        ?.effectiveLocal.slice(0, 10) || ""
    : "";
}
function effectiveDate(value) {
  const day = M.date(value);
  M.assert(day, "탈락일 또는 복귀일을 입력해 주세요.");
  return `${day}T00:00`;
}
function apply(person, input, actor) {
  if (!Object.hasOwn(input, "dropoutStatus")) return null;
  M.assert(
    ["active", "dropped"].includes(input.dropoutStatus),
    "탈락 여부를 선택해 주세요.",
  );
  const to = input.dropoutStatus;
  if (to === "active") {
    M.assert(!input.dropoutDate, "진행 중인 대상자의 탈락일은 비워 주세요.");
    if (person.status === "active") return null;
    const event = M.lifecycleChange(
      person,
      to,
      effectiveDate(input.returnDate),
      actor,
      input.dropoutReason || "대상자 정보에서 복귀 등록",
    );
    event.timeUnknown = true;
    return { action: "대상자 복귀", before: null, after: event };
  }
  M.assert(input.dropoutDate, "탈락일을 입력해 주세요.");
  const day = M.date(input.dropoutDate);
  if (person.status === "dropped") {
    const event = person.lifecycle.findLast((entry) => entry.to === "dropped");
    if (event) {
      if (day === event.effectiveLocal.slice(0, 10)) return null;
      const next = effectiveDate(day);
      const before = M.copy(event);
      // Retain the event identity and original author; audit the administrator's correction.
      event.effectiveLocal = event.timeUnknown
        ? next
        : day + event.effectiveLocal.slice(10);
      person.updatedAt = M.now();
      return { action: "대상자 탈락일 정정", before, after: event };
    }
  }
  const event = M.lifecycleChange(
    person,
    to,
    effectiveDate(day),
    actor,
    input.dropoutReason || "대상자 정보에서 탈락 등록",
  );
  event.timeUnknown = true;
  return { action: "대상자 탈락", before: null, after: event };
}
module.exports = { dropoutDate, apply };
