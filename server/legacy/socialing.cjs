"use strict";
const M = require("./model.cjs");
const O = require("./organization.cjs");
const Stages = require("./person-stages.cjs");

const UNASSIGNED = "__unassigned__";
const normalized = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const programKey = (s) => normalized(s).replace(/[!！()[\]（）·/]/g, "");
const MAX_PROGRAMS = 500, MAX_PENDING = 30000;
function defaults() {
  return { programs: [{ id: "aha", name: "아하!" }, { id: "walking-talking", name: "워킹토킹" }], pending: [] };
}
function settings(ws) {
  if (!Object.hasOwn(ws, "socialing")) ws.socialing = defaults();
  return ws.socialing;
}
function validProfile(profile, foundDate) {
  M.id(profile.id);
  M.id(profile.programId);
  M.date(profile.date, false);
  M.assert(!profile.date || !foundDate || profile.date <= foundDate, "외부유입일은 찾은 날짜보다 늦을 수 없습니다.");
}
function validate(ws) {
  const s = settings(ws);
  M.assert(s && Array.isArray(s.programs) && Array.isArray(s.pending), "소셜링 자료 형식을 확인해 주세요.");
  M.assert(s.programs.length <= MAX_PROGRAMS && s.pending.length <= MAX_PENDING, "소셜링 모임 또는 외부유입 수 제한을 초과했습니다.");
  const programs = new Set(), names = new Set(), ids = new Set();
  for (const p of s.programs) {
    const name = programKey(M.text(p.name, 100, true));
    M.assert(name && (!p.aliases || Array.isArray(p.aliases)), "소셜링 모임의 이름을 확인해 주세요.");
    if (p.aliases) for (const alias of p.aliases) M.text(alias, 100, true);
    M.assert(M.id(p.id) !== UNASSIGNED && !programs.has(p.id) && !names.has(name), "소셜링 모임이 중복됩니다.");
    programs.add(p.id);
    names.add(name);
  }
  const check = (entry, foundDate) => {
    validProfile(entry, foundDate);
    M.assert(programs.has(entry.programId) && !ids.has(entry.id), "소셜링 모임 또는 유입 식별자를 확인해 주세요.");
    ids.add(entry.id);
  };
  const members = new Set(O.get(ws).members.map((m) => m.id));
  for (const entry of s.pending) {
    check(entry, "");
    M.date(entry.date);
    M.text(entry.name, 100, true);
    M.text(entry.region, 60);
    M.text(entry.notes, 10000);
    M.assert(entry.introducerId === "" || members.has(entry.introducerId), "소셜링 유입의 인도자를 확인해 주세요.");
  }
  for (const p of ws.people) if (p.socialing) check(p.socialing, p.date);
}
function saveProgram(ws, input, actor) {
  const { programs } = settings(ws);
  const name = M.text(input.name, 100, true);
  const old = input.id ? programs.find((p) => p.id === input.id) : null;
  M.assert(!input.id || old, "모임을 찾을 수 없습니다.");
  M.assert(programKey(name) && !programs.some((p) => p !== old && programKey(p.name) === programKey(name)), "사용할 수 없거나 이미 등록된 모임 이름입니다.");
  M.assert(old || programs.length < MAX_PROGRAMS, "소셜링 모임은 최대 500개입니다.");
  if (old?.name === name) return false;
  const next = { id: old?.id || M.uuid(), name };
  if (old) next.aliases = [...new Set([...(old.aliases || []), old.name])].filter((alias) => programKey(alias) !== programKey(name));
  if (old) programs[programs.indexOf(old)] = next;
  else programs.push(next);
  M.audit(ws, actor, old ? "소셜링 모임 수정" : "소셜링 모임 등록", next.id, old, next);
}
function checkProgram(s, id) {
  const program = s.programs.find((p) => p.id === id);
  M.assert(program, "등록된 소셜링 모임을 선택해 주세요.");
  return program;
}
function eligiblePerson(ws, personId) {
  const person = ws.people.find((p) => p.id === personId);
  M.assert(person && (person.classification2 === "소셜링" || person.socialing), "소셜링으로 등록한 대상자를 선택해 주세요.");
  return person;
}
function saveIntake(ws, input, actor) {
  const s = settings(ws);
  checkProgram(s, input.programId);
  const old = input.id ? s.pending.find((e) => e.id === input.id) : null;
  const owner = input.personId ? eligiblePerson(ws, input.personId)
    : input.id && ws.people.find((p) => p.socialing?.id === input.id);
  if (owner) {
    M.assert(!old, "외부유입과 기존 대상자는 찾B 전환에서 연결해 주세요.");
    M.assert(!input.id || owner.socialing?.id === input.id, "대상자의 소셜링 정보가 변경됐습니다. 다시 조회해 주세요.");
    const profile = { id: owner.socialing?.id || M.uuid(), programId: input.programId, date: M.date(input.date, false) };
    validProfile(profile, owner.date);
    if (owner.socialing && M.hash(owner.socialing) === M.hash(profile)) return false;
    M.audit(ws, actor, "대상자 소셜링 정보 수정", owner.id, owner.socialing || null, profile);
    owner.socialing = profile;
    owner.updatedAt = M.now();
    return;
  }
  M.assert(!input.id || old, "외부유입 기록을 찾을 수 없습니다.");
  const org = O.get(ws);
  const introducerId = input.introducerId ?? old?.introducerId ?? "";
  const member = introducerId ? org.members.find((m) => m.id === introducerId) : null;
  M.assert(!introducerId || (member && (member.status === "active" || old?.introducerId === introducerId)), "등록된 인도자를 선택해 주세요.");
  const entry = {
    id: old?.id || (input.requestId ? M.id(input.requestId) : M.uuid()),
    programId: input.programId, date: M.date(input.date), name: M.text(input.name, 100, true),
    region: M.text(input.region ?? old?.region ?? "", 60) || (member ? O.regionOf(org, member.unitId) : ""),
    introducerId, notes: M.text(input.notes ?? old?.notes ?? "", 10000),
  };
  if (!old && input.requestId) {
    const duplicate = s.pending.find((e) => e.id === entry.id);
    if (duplicate && M.hash(duplicate) === M.hash(entry)) return false;
    M.assert(!duplicate && !ws.people.some((p) => p.socialing?.id === entry.id), "이미 등록한 외부유입입니다.");
  }
  if (old && M.hash(old) === M.hash(entry)) return false;
  M.assert(old || s.pending.length < MAX_PENDING, "전환 전 외부유입은 최대 30,000명입니다.");
  if (old) s.pending[s.pending.indexOf(old)] = entry;
  else s.pending.push(entry);
  M.audit(ws, actor, old ? "소셜링 외부유입 수정" : "소셜링 외부유입 등록", entry.id, old, entry);
}
function removeIntake(ws, input, actor) {
  const { pending } = settings(ws);
  const index = pending.findIndex((e) => e.id === input.id);
  M.assert(index >= 0, "전환 전 외부유입 기록을 선택해 주세요.");
  const [entry] = pending.splice(index, 1);
  M.audit(ws, actor, "소셜링 외부유입 삭제", entry.id, entry, null);
}
function promote(ws, input, actor) {
  const s = settings(ws);
  const old = s.pending.find((e) => e.id === M.id(input.id));
  const converted = ws.people.find((p) => p.socialing?.id === input.id);
  if (converted) {
    M.assert(!input.personId || input.personId === converted.id, "이미 다른 대상자로 전환했습니다.");
    M.assert(!input.date || input.date === converted.date, "이미 다른 찾은 날짜로 전환했습니다.");
    return false;
  }
  M.assert(old, "외부유입 기록을 찾을 수 없습니다.");
  const current = input.personId ? eligiblePerson(ws, input.personId) : null;
  M.assert(!current?.socialing?.date, "기존 대상자에 이미 외부유입 기록이 있습니다.");
  const date = M.date(input.date || current?.date);
  const profile = { id: old.id, programId: old.programId, date: old.date };
  validProfile(profile, date);
  let person;
  if (current) {
    M.assert(current.date === date && !current.dateUnknown, "대상자 관리에서 확인한 찾은 날짜로 연결해 주세요.");
    person = current;
  } else {
    const stage = ws.stages.find((id) => [id, ws.stageNames[id]].some((s) => normalized(s) === "찾b"));
    M.assert(stage && !ws.inactiveStages.includes(stage), "찾B 단계를 사용하도록 설정해 주세요.");
    M.assert(ws.people.length < 30000, "대상자는 최대 30,000명입니다.");
    person = M.validatePerson({
      name: old.name, region: old.region, introducerId: old.introducerId, notes: old.notes,
      classification2: "소셜링", tool: checkProgram(s, old.programId).name, stage, date,
    }, ws);
    const first = M.transition(person, null, stage, date + "T00:00", actor, "소셜링 외부유입에서 찾B 전환", ws.stageNames);
    first.timeUnknown = true;
    ws.people.push(person);
    M.audit(ws, actor, "대상자 등록", person.id, null, M.personChanges(null, person).after);
  }
  person.socialing = profile;
  person.updatedAt = M.now();
  s.pending.splice(s.pending.indexOf(old), 1);
  M.audit(ws, actor, current ? "소셜링 기존 대상자 연결" : "소셜링 찾B 전환", person.id, old, profile);
}

// The program on a new intake is explicit. Earlier persons may only have a
// recognized tool label; an absent intake date is always left unknown.
function programLookup(programs) {
  const aliases = new Map();
  for (const p of programs) {
    const names = [p.name, ...(p.aliases || [])];
    if (p.id === "aha") names.push("아하");
    if (p.id === "walking-talking") names.push("워킹토킹");
    for (const name of names) {
      const value = programKey(name);
      for (const prefix of ["", "소셜링", "동아리", "지인소셜링"]) {
        const alias = prefix + value;
        aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== p.id ? UNASSIGNED : p.id);
      }
    }
  }
  return (tool) => aliases.get(programKey(tool || "")) || UNASSIGNED;
}
function query(ws, input = {}) {
  const { programs, pending } = settings(ws);
  const from = M.date(input.from, false), to = M.date(input.to, false);
  const region = M.text(input.region ?? "", 60);
  const status = input.status ?? "";
  M.assert(!from || !to || from <= to, "조회 시작일은 종료일보다 늦을 수 없습니다.");
  M.assert(["", "pending", "linked", "dropped", "reported"].includes(status), "소셜링 진행상태를 확인해 주세요.");
  if (input.programId && input.programId !== UNASSIGNED) checkProgram({ programs }, input.programId);
  const inRange = (day) => !!day && (!from || from <= day) && (!to || day <= to);
  const programOf = programLookup(programs);
  const findA = Stages.stageId(ws, "findADate");
  const attainment = findA ? Stages.attainmentFor(ws, findA) : null;
  const names = new Map(programs.map((p) => [p.id, p.name]));
  names.set(UNASSIGNED, "모임 미지정");
  const members = new Map(O.get(ws).members.map((m) => [m.id, m.name]));
  const reports = new Map();
  for (const r of ws.findingReports || []) {
    let seen = reports.get(r.personCode);
    if (!seen) {
      seen = { first: r, last: r, found: "", findA: "", tool: "" };
      reports.set(r.personCode, seen);
    }
    if (r.date < seen.first.date) seen.first = r;
    if (r.date > seen.last.date) seen.last = r;
    if (!r.dateUnknown && r.foundDate && (!seen.found || r.foundDate < seen.found)) seen.found = r.foundDate;
    if (findA && r.stage === findA && r.status === "신규" && (!seen.findA || r.date < seen.findA)) seen.findA = r.date;
    if (r.tool && (!seen.tool || r.date < seen.toolDate)) {
      seen.tool = r.tool;
      seen.toolDate = r.date;
    }
  }
  const records = pending.map((r) => ({
    ...r, worker: members.get(r.introducerId) || "", personId: "", foundDate: "", findADate: "",
    stage: "외부유입", status: "pending",
  }));
  for (const p of ws.people) {
    const report = reports.get(p.code);
    reports.delete(p.code);
    if (p.classification2 !== "소셜링" && !p.socialing) continue;
    records.push({
      id: p.socialing?.id || "", personId: p.id, programId: p.socialing?.programId || programOf(p.tool || report?.tool),
      name: p.name, date: p.socialing?.date || "", foundDate: p.dateUnknown ? "" : p.date,
      findADate: attainment?.(p, report?.first)?.date || "", stage: M.stageName(ws, p.stage),
      region: p.region, introducerId: p.introducerId || "", worker: p.worker || members.get(p.introducerId) || "",
      notes: p.notes || "", status: p.status === "dropped" ? "dropped" : "linked",
    });
  }
  for (const { first, last, found, findA: day, tool } of reports.values()) {
    if (first.classification2 !== "소셜링") continue;
    records.push({
      id: "", personId: "", programId: programOf(tool), name: last.name, date: "", foundDate: found,
      findADate: day, stage: M.stageName(ws, last.stage), region: last.region || "",
      introducerId: last.memberId || "", worker: last.worker || "", notes: "", status: "reported",
    });
  }
  const counts = () => ({ inflows: 0, findings: 0, findAs: 0, converted: 0, pending: 0, conversionRate: null });
  const totals = counts(), groups = new Map(), months = new Map(), rows = [];
  const search = normalized(M.text(input.search || "", 200));
  for (const [id, name] of names) if (!input.programId || id === input.programId)
    groups.set(id, { programId: id, programName: name, ...counts() });
  for (const row of records) {
    const group = groups.get(row.programId);
    if (!group || (region && row.region !== region) || (status && row.status !== status)) continue;
    row.programName = group.programName;
    if (search && ![row.name, row.worker, row.region, row.programName, row.stage]
      .some((s) => normalized(s || "").includes(search))) continue;
    const dates = [["inflows", row.date], ["findings", row.foundDate], ["findAs", row.findADate]];
    if ((from || to) && !dates.some(([, day]) => inRange(day))) continue;
    rows.push(row);
    for (const [metric, day] of dates) {
      if (!inRange(day)) continue;
      group[metric]++;
      totals[metric]++;
      const month = day.slice(0, 7);
      if (!months.has(month)) months.set(month, { month, inflows: 0, findings: 0, findAs: 0 });
      months.get(month)[metric]++;
      if (metric === "inflows") {
        const outcome = row.foundDate && row.foundDate >= day ? "converted" : "pending";
        group[outcome]++;
        totals[outcome]++;
      }
    }
  }
  for (const item of [totals, ...groups.values()])
    item.conversionRate = item.inflows ? item.converted * 100 / item.inflows : null;
  if (!groups.get(UNASSIGNED)?.findings && !rows.some((r) => r.programId === UNASSIGNED) && input.programId !== UNASSIGNED)
    groups.delete(UNASSIGNED);
  const latest = (r) => [r.date, r.foundDate, r.findADate].sort().at(-1);
  rows.sort((a, b) => latest(b).localeCompare(latest(a)) || a.name.localeCompare(b.name, "ko"));
  return {
    programs, rows, totals, groups: [...groups.values()],
    regions: [...new Set(records.map((row) => row.region).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "ko", { numeric: true })),
    trend: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

module.exports = { defaults, validProfile, validate, saveProgram, saveIntake, removeIntake, promote, query };
