"use strict";
const M = require("./model.cjs");
const { fields, stageId, value } = require("./ui/person-milestones.js");
const FIELDS = Object.fromEntries(
  fields.map(({ field, stage }) => [field, stage]),
);
const norm = (v) =>
  String(v || "")
    .replace(/\s/g, "")
    .toLowerCase();
function knownEntry(event, report) {
  return event && !event.baseline && !(
    event.from === null && event.reason === "일보 최초 확인" &&
    report && report.status !== "신규"
  );
}
function gospelEntry(person, id, day, report) {
  let earliest;
  for (const event of person.transitions) {
    if (event.to !== id || event.from === id || !knownEntry(event, report)) continue;
    if (event.effectiveLocal.slice(0, 10) === day) return event;
    if (!earliest || event.effectiveLocal < earliest.effectiveLocal) earliest = event;
  }
  return earliest;
}
function stageAttainment(person, id, field, report) {
  const explicit = field && person.stageDates?.[field];
  const event = field === "bokshinDate"
    ? gospelEntry(person, id, explicit, report)
    : person.transitions.find((t) => t.to === id);
  if (explicit) return { date: explicit, event };
  return knownEntry(event, report) ? { date: event.effectiveLocal.slice(0, 10), event } : null;
}
function attainmentFor(ws, id) {
  const finding = !id || id === "*",
    findingStage = [id, ws.stageNames[id]].some((label) => norm(label) === "찾b"),
    manpikId = findingStage && stageId(ws, "manpikDate"),
    field = Object.keys(FIELDS).find((key) => stageId(ws, key) === id);
  return (person, report) => {
    const foundDate = person.dateUnknown ? "" : person.date;
    if (finding) {
      const event = person.transitions.find((t) => t.from === null);
      return foundDate ? { date: foundDate, event } : null;
    }
    const reached = stageAttainment(person, id, field, report);
    if (!findingStage || !foundDate) return reached;
    if (reached?.event?.from === null) return { date: foundDate, event: reached.event };
    if ((!reached || foundDate < reached.date) &&
        stageAttainment(person, manpikId, "manpikDate", report)?.date === foundDate) {
      // A person can be registered directly at Manpik on their confirmed finding date.
      return { date: foundDate, event: person.transitions.find((t) => t.from === null) };
    }
    return reached;
  };
}
function apply(person, input, ws) {
  const changes = [];
  for (const { field, stage: label } of fields) {
    if (!Object.hasOwn(input, field) || !input[field]) continue;
    const day = M.date(input[field]);
    const id = stageId(ws, field);
    const prior = value(person, field, ws);
    if (day === prior) continue;
    const event = id && (field === "bokshinDate"
      ? gospelEntry(person, id, prior)
      : person.transitions.find((t) => t.to === id));
    const before = {
      field,
      label,
      date: prior,
      event: event ? M.copy(event) : null,
    };
    person.stageDates = { ...person.stageDates, [field]: day };
    if (event) event.effectiveLocal = day + event.effectiveLocal.slice(10);
    person.updatedAt = M.now();
    changes.push({
      before,
      after: { field, label, date: day, event: event ? M.copy(event) : null },
    });
  }
  return changes;
}
function audit(ws, actor, person, changes) {
  for (const change of changes)
    M.audit(
      ws,
      actor,
      "대상자 단계일 정정",
      person.id,
      change.before,
      change.after,
    );
}
module.exports = { FIELDS, stageId, attainmentFor, value, apply, audit };
