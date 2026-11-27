"use strict";
const M = require("./model.cjs");
const K = require("./codes.cjs");
const S = require("./person-stages.cjs");
function normalize(ws, input, existing) {
  const region = M.text(input.region ?? "", 60),
    from = M.date(input.from),
    to = M.date(input.to),
    stageId = input.stageId || "*";
  M.assert(
    input.target !== "" &&
      input.target !== null &&
      input.target !== undefined &&
      typeof input.target !== "boolean",
    "목표 건수를 입력해 주세요. 0건도 지정할 수 있습니다.",
  );
  const target = Number(input.target);
  M.assert(
    (stageId === "*" || ws.stages.includes(stageId)) &&
      from <= to &&
      Number.isInteger(target) &&
      target >= 0 &&
      target <= M.MAX_GOAL_TARGET,
    "목표 단계·기간·건수를 확인해 주세요.",
  );
  const existingClass =
    existing?.className ??
    ws.goals.find(
      (g) =>
        g.region === region &&
        g.from === from &&
        g.to === to &&
        (g.stageId || "*") === stageId &&
        g.className === input.className,
    )?.className;
  const className = input.className
    ? K.resolve(ws, "className", input.className, existingClass)
    : "";
  M.assert(region || className, "구역 또는 반을 선택해 주세요.");
  const periodUnit = input.periodUnit || "custom";
  M.assert(
    ["week", "month", "custom"].includes(periodUnit),
    "목표 기간 단위를 확인하세요.",
  );
  return {
    region,
    from,
    to,
    stageId,
    target,
    ...(className ? { className } : {}),
    ...(input.periodUnit ? { periodUnit } : {}),
  };
}
const key = (g) =>
  JSON.stringify([g.region, g.from, g.to, g.stageId || "*", g.className || ""]);
function save(ws, input, actor, action) {
  const data = normalize(ws, input),
    before = ws.goals.find((g) => key(g) === key(data)) || null;
  if (
    before &&
    before.target === data.target &&
    (before.periodUnit || "custom") === (data.periodUnit || "custom")
  )
    return false;
  M.assert(before || ws.goals.length < 10000, "목표는 최대 10,000건입니다.");
  const after = { id: before?.id || M.uuid(), ...data };
  if (before) ws.goals[ws.goals.indexOf(before)] = after;
  else ws.goals.push(after);
  M.audit(
    ws,
    actor,
    action || (after.region ? "구역 목표 설정" : "반별 목표 설정"),
    after.id,
    before,
    after,
  );
  return true;
}
function saveBatch(ws, rows, actor, deleteIds = []) {
  M.assert(
    Array.isArray(rows) &&
      Array.isArray(deleteIds) &&
      rows.length + deleteIds.length > 0 &&
      rows.length + deleteIds.length <= 1000,
    "한 번에 목표 1~1,000건을 저장하거나 삭제할 수 있습니다.",
  );
  const normalized = rows.map((r) => normalize(ws, r)),
    seen = new Set();
  normalized.forEach((g) => {
    M.assert(!seen.has(key(g)), "같은 구역·반·기간·단계의 목표가 중복됩니다.");
    seen.add(key(g));
  });
  // Validate and audit on a draft before touching the caller's workspace.
  const draft = M.copy(ws);
  let changed = 0;
  M.assert(
    new Set(deleteIds).size === deleteIds.length,
    "삭제할 목표가 중복됩니다.",
  );
  for (const id of deleteIds) {
    const goal = draft.goals.find((g) => g.id === id);
    M.assert(goal, "삭제할 목표를 찾을 수 없습니다. 표를 다시 불러오세요.");
    M.assert(
      !seen.has(key(goal)),
      "같은 목표를 저장하면서 삭제할 수 없습니다.",
    );
    remove(draft, id, actor);
    changed++;
  }
  normalized.forEach((g) => {
    if (save(draft, g, actor)) changed++;
  });
  M.validateWorkspace(draft);
  if (changed) Object.assign(ws, draft);
  return changed > 0;
}
function update(ws, input, actor) {
  const before = ws.goals.find((g) => g.id === input.id);
  M.assert(before, "수정할 목표를 찾을 수 없습니다. 목록을 다시 불러오세요.");
  const data = normalize(ws, { ...before, ...input }, before);
  M.assert(
    !ws.goals.some((g) => g.id !== before.id && key(g) === key(data)),
    "같은 구역·반·기간·항목의 목표가 이미 있습니다. 기존 목표를 확인해 주세요.",
  );
  const after = { id: before.id, ...data };
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  ws.goals[ws.goals.indexOf(before)] = after;
  M.audit(ws, actor, "기간 목표 수정", after.id, before, after);
  return true;
}
function remove(ws, id, actor) {
  const index = ws.goals.findIndex((g) => g.id === id);
  M.assert(index >= 0, "목표를 찾을 수 없습니다.");
  const before = ws.goals[index];
  ws.goals.splice(index, 1);
  M.audit(
    ws,
    actor,
    before.region ? "구역 목표 삭제" : "반별 목표 삭제",
    id,
    before,
    null,
  );
}
function attainments(ws, stageId = "*") {
  const firstReports = new Map();
  for (const r of ws.findingReports || [])
    if (
      !firstReports.has(r.personCode) ||
      r.date < firstReports.get(r.personCode).date
    )
      firstReports.set(r.personCode, r);
  const rows = [],
    attainment = S.attainmentFor(ws, stageId);
  for (const p of ws.people) {
    const report = firstReports.get(p.code),
      entry = attainment(p, report);
    if (!entry) continue;
    const { event, date } = entry;
    // Preserve the first entry's organization when available. A separately
    // recorded milestone with no transition has only the person's assignment.
    const fallback = event || !stageId || stageId === "*" ? report : null;
    const region = event?.region ?? fallback?.region ?? p.region,
      className = event?.className ?? fallback?.className ?? p.className;
    rows.push({ personId: p.id, date, region, className });
  }
  return rows;
}
function progress(ws, goal, rows = attainments(ws, goal.stageId)) {
  const classCode = (value) => K.find(ws, "className", value)?.value || value;
  const targetClass = classCode(goal.className);
  const actual = rows.filter(
    (r) =>
      r.date >= goal.from &&
      r.date <= goal.to &&
      (!goal.region || r.region === goal.region) &&
      (!targetClass || classCode(r.className) === targetClass),
  ).length;
  return {
    ...goal,
    actual,
    shortfall: Math.max(0, goal.target - actual),
    rate: goal.target ? (actual / goal.target) * 100 : null,
  };
}
module.exports = {
  normalize,
  key,
  save,
  update,
  saveBatch,
  remove,
  progress,
  attainments,
};
