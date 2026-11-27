"use strict";
const UNCLASSIFIED = "__unclassified__";
function filter(value = "") {
  const M = require("./model.cjs");
  M.assert(
    typeof value === "string" &&
      ["", UNCLASSIFIED, ...M.PERSON_CLASSIFICATIONS.classification2].includes(
        value,
      ),
    "분류2 조회 조건을 확인하세요.",
  );
  return value;
}
const label = (value) =>
  value === UNCLASSIFIED ? "미입력" : value || "전체 분류";
const person = (p) =>
  p.classification2 ?? (Object.hasOwn(p, "classification1") ? "" : "노방");
const activity = (a) => a.classification2 ?? "노방";
const matches = (value, selected) =>
  !selected || (selected === UNCLASSIFIED ? !value : value === selected);
function activities(ws) {
  return [
    ...ws.activityLogs,
    ...ws.people.flatMap((p) =>
      p.activities.map((a) => ({ ...a, region: a.region || p.region })),
    ),
  ].map((a) => ({ ...a, classification2: activity(a) }));
}
// Callers before the category selector existed request the original street
// activity analysis. New screens always send their selected category explicitly.
const activityAvailable = (input) =>
  !Object.hasOwn(input, "classification2") || input.classification2 === "노방";
module.exports = {
  UNCLASSIFIED,
  filter,
  label,
  person,
  activity,
  matches,
  activities,
  activityAvailable,
};
