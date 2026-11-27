"use strict";

const M = require("./model.cjs");
const O = require("./organization.cjs");
const K = require("./codes.cjs");
const Milestones = require("./ui/person-milestones.js");
const { parseClock } = require("./clock.cjs");
const { phoneKey, readPhone } = require("./person-phone.cjs");
const { addIssue, CANDIDATE_LIMIT, inputFields, issueFields } = require("./daily-area-import-issues.cjs");

const stages = [
  "찾B",
  "콜링",
  "만픽",
  "찾A",
  "합 B",
  "합A(육따)",
  "영따",
  "복음방",
  "신카접수",
  "센터등록",
  "입교",
];
const columns = {
  만픽: "만픽",
  찾A: "찾A",
  "합 B": "합B",
  "합A(육따)": "합A\n(육따)",
  영따: "영따",
  복음방: "복신",
  신카접수: "신카접수",
  센터등록: "센터등록",
  입교: "입교",
};
const firstClassification = "분류1(개척/지인/가족)";
const secondClassification = "분류2(노방/소셜링/온라인/세미나/기타)";

function cellText(value) {
  if (value == null) return "";
  if (value.richText)
    return value.richText
      .map(({ text }) => text)
      .join("")
      .trim();
  M.assert(
    ["string", "number"].includes(typeof value),
    "엑셀 셀의 값을 확인해 주세요.",
  );
  const text = String(value).normalize("NFC").trim();
  return /^[-–—]$/u.test(text) ? "" : text;
}

const normalize = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toLowerCase();

function districtKey(value) {
  const token = normalize(value);
  const number = /^(\d+)(?:구역)?$/u.exec(token);
  return number ? `${Number(number[1])}구역` : token;
}

function day(value, name, reportDate, required = false) {
  let text;
  if (value instanceof Date || typeof value === "number") {
    M.assert(
      typeof value !== "number" || value >= 1,
      `${name} 날짜를 확인해 주세요.`,
    );
    const date =
      value instanceof Date
        ? value
        : new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    M.assert(Number.isFinite(date.valueOf()), `${name} 날짜를 확인해 주세요.`);
    text = date.toISOString().slice(0, 10);
  } else {
    text = cellText(value);
    const parts = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(text);
    if (parts)
      text = `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
  }
  if (!text && !required) return "";
  const parsed = new Date(`${text}T00:00:00Z`);
  M.assert(
    /^\d{4}-\d{2}-\d{2}$/u.test(text) &&
      Number.isFinite(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === text,
    `${name} 날짜를 확인해 주세요.`,
  );
  M.assert(
    !reportDate || text <= reportDate,
    `${name} 날짜가 보고일보다 늦습니다.`,
  );
  return text;
}

function findingClock(value) {
  if (typeof value !== "number")
    return parseClock(value instanceof Date ? value : cellText(value));
  const minutes = Math.round(value * 60);
  M.assert(
    Number.isFinite(value) && value >= 0 && minutes < 1440,
    "찾기시간을 확인해 주세요.",
  );
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function canonicalStage(label) {
  const milestone = Milestones.fieldForStageLabel(label);
  return (
    milestone?.stage ||
    stages.find((stage) => normalize(stage) === normalize(label))
  );
}

function stageId(ws, label) {
  const milestone = Milestones.fieldForStageLabel(label);
  return (
    (milestone && Milestones.stageId(ws, milestone.field)) ||
    ws.stages.find((id) =>
      [id, ws.stageNames[id]].some(
        (name) => normalize(name) === normalize(label),
      ),
    )
  );
}

function stageRank(ws, id) {
  return stages.indexOf(
    canonicalStage(id) || canonicalStage(ws.stageNames[id]),
  );
}

function personKey(values, requireIntroducer = true) {
  const name = M.text(cellText(values.대상자), 100, true);
  const introducer = M.text(cellText(values.인도자), 100, requireIntroducer);
  const explicit = /^(.*?)\[([^\]]+)\]$/u.exec(introducer);
  return { name, introducer, explicit };
}

function namesMatch(member, key) {
  if (key.explicit) {
    const [, name, id] = key.explicit;
    return (
      [member.code, member.id].some(
        (value) => normalize(value) === normalize(id),
      ) &&
      (!name || normalize(member.name) === normalize(name))
    );
  }
  return [member.name, member.code, member.id].some(
    (value) => normalize(value) === normalize(key.introducer),
  );
}

function targetMatches(ws, members, key, district, phone) {
  return ws.people.filter((p) => {
    if (
      normalize(p.name) !== normalize(key.name) ||
      (district && districtKey(p.region) !== districtKey(district))
    )
      return false;
    if (!key.introducer) return phoneKey(p.phone) === phone;
    const linked = members.get(p.introducerId);
    return [linked, p.introducerSnapshot, { name: p.worker }].some(
      (ref) => ref && namesMatch(ref, key),
    );
  });
}

function candidateDetails(records, fields) {
  return {
    candidates: records.slice(0, CANDIDATE_LIMIT).map((record) => ({ fields: fields(record) })),
    totalCandidates: records.length,
  };
}

function recentDay(events) {
  return events.reduce(
    (latest, { effectiveLocal }) => effectiveLocal > latest ? effectiveLocal : latest,
    "",
  ).slice(0, 10);
}

function targetFields(ws, members, person, stageLabel) {
  const phone = phoneKey(person.phone);
  const requested = Milestones.fieldForStageLabel(stageLabel);
  const introducer = person.worker || person.introducerSnapshot?.name || members.get(person.introducerId)?.name;
  return issueFields([
    ["대상자명", person.name],
    ["대상자 ID", person.code],
    ["인도자", introducer],
    ["인도자 구역", person.region],
    ["연락처", phone && `끝 4자리 ${phone.slice(-4)}`],
    ["찾B 날짜", person.date],
    ["현재 단계", ws.stageNames[person.stage] || person.stage],
    ["현재 상태", person.status === "dropped" ? "탈락" : "진행 중"],
    ["요청 단계 날짜", requested && Milestones.value(person, requested.field, ws)],
    ["최근 단계 날짜", recentDay(person.transitions)],
    ["최근 탈락·복귀 날짜", recentDay(person.lifecycle)],
  ]);
}

function registerFinding(ws, values, reportDate, members, actor, { warn, setMatched }) {
  const key = personKey(values);
  const found = day(values.찾B, "찾B", reportDate, true);
  const district = M.text(cellText(values["  구역"]), 60, true);
  const label = cellText(values.단계) || "찾B";
  M.assert(
    canonicalStage(label) === "찾B",
    "찾기 시트에는 신규 찾B만 등록할 수 있습니다.",
  );
  const candidates = targetMatches(ws, members, key, district).filter(
    (person) => person.date === found,
  );
  if (candidates.length > 1)
    return warn(
      "같은 날짜·구역·인도자의 대상자가 여러 명입니다.",
      candidateDetails(candidates, (person) => targetFields(ws, members, person, label)),
    );
  if (candidates.length) {
    setMatched(candidates[0]);
    return {
      outcome: "중복 건너뜀",
      message: "같은 대상자·인도자·구역·찾B 날짜로 이미 등록되어 있습니다.",
    };
  }

  const org = O.get(ws);
  const possible = [...members.values()].filter(
    (m) =>
      m.status === "active" &&
      namesMatch(m, key) &&
      districtKey(O.regionOf(org, m.unitId)) === districtKey(district),
  );
  if (possible.length > 1 || (key.explicit && !possible.length))
    return warn(
      "구역 명부에서 인도자를 한 명으로 확인해 주세요.",
      candidateDetails(possible, (member) => issueFields([
        ["인도자", member.name],
        ["구역", O.regionOf(org, member.unitId)],
        ["반", member.className],
      ])),
    );
  const member = possible[0];
  if (!member) warn("구역 명부에 인도자가 없어 이름만 기록했습니다.");
  const stage = stageId(ws, label);
  M.assert(
    stage && !ws.inactiveStages.includes(stage),
    "자료실의 찾B 단계를 확인해 주세요.",
  );
  const inputClass = cellText(values.반);
  let className = member?.className || "";
  if (inputClass) {
    try {
      className = K.resolve(ws, "className", inputClass);
    } catch {
      warn("반 항목을 확인해 주세요. 자료실 명부의 반을 사용했습니다.");
    }
  }
  const time = findingClock(values.찾기시간);
  const classification1 = cellText(values[firstClassification]);
  const classification2 = cellText(values[secondClassification]);
  const legacyAcquaintance = classification2 === "지인";
  if (legacyAcquaintance)
    warn("분류2에 적힌 지인은 분류1 기준으로 처리했습니다.");
  M.assert(ws.people.length < 30000, "대상자는 최대 30,000명입니다.");
  const person = M.validatePerson(
    {
      name: key.name,
      date: found,
      ageAsOf: found,
      time,
      region: district,
      worker: member?.name || key.introducer,
      introducerId: member?.id,
      className,
      stage,
      gender: cellText(values.성별) || "미입력",
      age: cellText(values.나이),
      phone: readPhone(
        values.연락처?.richText ? cellText(values.연락처) : values.연락처,
      ),
      classification1: classification1 || (legacyAcquaintance ? "지인" : ""),
      classification2: legacyAcquaintance ? "" : classification2,
      place: cellText(values.찾기장소),
      tool: cellText(values.도구),
      residence: cellText(values.거주지),
      teacher: cellText(values.상담사),
    },
    ws,
  );
  const first = M.transition(
    person,
    null,
    stage,
    `${found}T${time || "00:00"}`,
    actor,
    "구역 일보 신규 찾기",
    ws.stageNames,
  );
  if (!time) first.timeUnknown = true;
  ws.people.push(person);
  M.audit(
    ws,
    actor,
    "구역 일보 대상자 등록",
    person.id,
    null,
    M.personChanges(null, person).after,
  );
  return { outcome: "신규 등록", message: "새 찾B 대상자로 등록합니다.", after: person };
}

function saveUpdate(ws, person, after, actor, action, extra) {
  after.updatedAt = M.now();
  ws.people[ws.people.indexOf(person)] = after;
  const changed = M.personChanges(person, after);
  M.audit(ws, actor, action, person.id, changed.before, {
    ...changed.after,
    ...extra,
  });
}

function changeStage(ws, person, stage, date, actor, warn) {
  const milestone = Milestones.fields.find(
    ({ field }) => Milestones.stageId(ws, field) === stage,
  );
  const milestoneDate =
    milestone && Milestones.value(person, milestone.field, ws);
  if (
    person.transitions.some(
      (event) =>
        event.to === stage &&
        !event.baseline &&
        event.effectiveLocal.slice(0, 10) === date,
    ) ||
    milestoneDate === date
  )
    return { outcome: "중복 건너뜀", message: `같은 단계와 적용일(${date})이 이미 기록되어 있습니다.` };
  if (person.status === "dropped")
    return warn("탈락 상태인 대상자의 단계는 변경하지 않았습니다.");
  const previous = person.stage;
  const oldRank = stageRank(ws, previous),
    nextRank = stageRank(ws, stage);
  if (
    previous !== stage &&
    (oldRank >= 0 && nextRank >= 0
      ? nextRank < oldRank
      : ws.stages.indexOf(stage) < ws.stages.indexOf(previous))
  )
    return warn("자료실의 현재 단계가 더 높아 유지했습니다.");
  const effective = `${date}T23:59`;
  if (
    person.transitions.some((t) => t.effectiveLocal > effective) ||
    person.lifecycle.some((t) => t.effectiveLocal > effective)
  )
    return warn("더 최근 단계 또는 탈락·복귀 이력이 있어 변경하지 않았습니다.");
  if (previous === stage && (!milestone || milestoneDate))
    return warn("이미 같은 단계이며 기존 단계 날짜를 유지했습니다.");
  const after = M.copy(person);
  if (milestone && !milestoneDate)
    after.stageDates = { ...person.stageDates, [milestone.field]: date };
  if (previous !== stage) {
    const event = M.transition(
      after,
      previous,
      stage,
      effective,
      actor,
      "구역 일보 단계 향상",
      ws.stageNames,
    );
    event.timeUnknown = true;
    after.stage = stage;
  }
  saveUpdate(ws, person, after, actor, "구역 일보 단계 향상");
  return {
    outcome: "단계 향상",
    message: previous === stage
      ? `현재 단계의 날짜를 ${date}로 기록합니다.`
      : `${date}자로 ${ws.stageNames[stage] || stage} 단계로 변경합니다.`,
    after,
  };
}

function dropTarget(ws, person, date, reason, actor, warn) {
  const saved = person.lifecycle.find(
    (event) =>
      event.to === "dropped" && event.effectiveLocal.slice(0, 10) === date,
  );
  if (saved)
    return !reason || saved.reason === reason
      ? { outcome: "중복 건너뜀", message: `같은 날짜(${date})의 탈락이 이미 기록되어 있습니다.` }
      : warn("같은 날짜의 기존 탈락 사유를 유지했습니다.");
  if (person.status === "dropped")
    return warn("이미 탈락한 대상자의 기존 이력을 유지했습니다.");
  const effective = `${date}T23:59`;
  if (
    person.transitions.some((t) => t.effectiveLocal > effective) ||
    person.lifecycle.some((t) => t.effectiveLocal.slice(0, 10) >= date)
  )
    return warn("더 최근 단계 또는 탈락·복귀 이력이 있어 변경하지 않았습니다.");
  const after = M.copy(person);
  const event = M.lifecycleChange(
    after,
    "dropped",
    effective,
    actor,
    reason || "구역 일보 탈락",
  );
  event.timeUnknown = true;
  saveUpdate(ws, person, after, actor, "구역 일보 탈락", {
    lifecycleEvent: event,
  });
  return { outcome: "탈락 반영", message: `${date}자로 탈락을 반영합니다.`, after };
}

function applyUpdate(ws, values, district, reportDate, members, actor, { warn, setMatched }) {
  const key = personKey(values, false);
  const phone = phoneKey(values.연락처);
  M.assert(key.introducer || phone, "인도자 또는 연락처를 입력해 주세요.");
  let found = "";
  try {
    found = day(values.찾B, "찾B", reportDate);
  } catch {
    // The workbook's original finding date is only a matching hint.
  }
  let candidates = targetMatches(ws, members, key, district, phone);
  if (candidates.length > 1 && key.introducer && phone) {
    const byPhone = candidates.filter((person) => phoneKey(person.phone) === phone);
    if (byPhone.length) candidates = byPhone;
  }
  if (candidates.length > 1 && found) {
    const byDate = candidates.filter((person) => person.date === found);
    if (byDate.length) candidates = byDate;
  }
  if (candidates.length > 1) {
    const active = candidates.filter((person) => person.status !== "dropped");
    if (active.length === 1) candidates = active;
  }
  if (candidates.length > 1)
    return warn(
      "일치하는 대상자가 여러 명입니다. 인도자 구역과 연락처를 확인해 주세요.",
      candidateDetails(candidates, (person) => targetFields(ws, members, person, values.단계)),
    );
  if (!candidates.length) {
    let similar = district ? targetMatches(ws, members, key, undefined, phone) : [];
    if (!similar.length && key.introducer && phone)
      similar = targetMatches(ws, members, { ...key, introducer: "" }, district, phone);
    return warn(
      "일치하는 기존 대상자가 없습니다. 대상자명·인도자·구역·연락처를 확인해 주세요.",
      candidateDetails(similar, (person) => targetFields(ws, members, person, values.단계)),
    );
  }
  const person = candidates[0];
  setMatched(person);
  if (!values.찾B)
    warn("찾B 날짜가 비어 일치하는 대상자 정보로 연결했습니다.");
  const dropout = day(values.탈락, "탈락", reportDate);
  const reason = M.text(cellText(values.탈락사유), 2000);
  if (dropout && normalize(reason) !== "상신") {
    M.assert(
      !person.date || dropout >= person.date,
      "탈락 날짜가 찾B 날짜보다 이릅니다.",
    );
    return dropTarget(ws, person, dropout, reason, actor, warn);
  }
  const label = cellText(values.단계);
  const heading = columns[canonicalStage(label)];
  const explicitDate = day(heading && values[heading], label, reportDate);
  if (dropout && !explicitDate)
    return warn(
      "상신은 탈락으로 저장하지 않습니다. 새 단계와 적용일을 확인해 주세요.",
    );
  M.assert(!reason || dropout, "탈락 사유가 있으면 탈락 날짜를 입력해 주세요.");
  const stage = stageId(ws, label);
  M.assert(
    stage && !ws.inactiveStages.includes(stage),
    "자료실에 등록된 단계인지 확인해 주세요.",
  );
  const date = explicitDate || reportDate;
  M.assert(
    !person.date || date >= person.date,
    "단계 적용일이 찾B 날짜보다 이릅니다.",
  );
  return changeStage(ws, person, stage, date, actor, warn);
}

function applyTargets(draft, { finding = [], updates = [], date }, actor) {
  const counts = {
    finding: { "신규 등록": 0, "중복 건너뜀": 0, "확인 필요": 0 },
    updates: {
      "단계 향상": 0,
      "탈락 반영": 0,
      "중복 건너뜀": 0,
      "확인 필요": 0,
    },
  };
  const errors = [];
  const warnings = [];
  const issues = [];
  const details = [];
  const reportDate = day(date, "보고일", "", true);
  const members = new Map(O.get(draft).members.map((m) => [m.id, m]));
  for (const [key, sheet, rows] of [
    ["finding", "찾기", finding],
    ["updates", "업데이트", updates],
  ]) {
    for (const { row, values, district } of rows) {
      const location = `${sheet} ${row}행`;
      let matched;
      const matchedDetails = () => matched
        ? candidateDetails([matched], (person) => targetFields(draft, members, person, values.단계))
        : {};
      const recordIssue = (severity, message, comparison = {}) => {
        const summary = `${location}: ${message}`;
        (severity === "error" ? errors : warnings).push(summary);
        addIssue(issues, {
          sheet, row, severity, message, summary,
          fields: inputFields(sheet, values, { district, date: reportDate }),
          ...matchedDetails(),
          ...comparison,
        });
      };
      const warn = (message, comparison = {}) => {
        recordIssue("warning", message, comparison);
        return { outcome: "확인 필요", message, ...comparison };
      };
      try {
        const callbacks = { warn, setMatched: (person) => { matched = person; } };
        const { outcome, message, after, ...comparison } =
          key === "finding"
            ? registerFinding(draft, values, reportDate, members, actor, callbacks)
            : applyUpdate(draft, values, district, reportDate, members, actor, callbacks);
        counts[key][outcome]++;
        details.push({
          sheet, row, outcome, message, values, date: reportDate, district,
          ...matchedDetails(),
          ...comparison,
          ...(after ? { after: targetFields(draft, members, after, values.단계) } : {}),
        });
      } catch (error) {
        recordIssue("error", error.message);
      }
    }
  }
  return { counts, errors, warnings, issues, details };
}

module.exports = { applyTargets };
