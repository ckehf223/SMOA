"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  P = require("./person-status.cjs"),
  S = require("./person-stages.cjs"),
  Milestones = require("./ui/person-milestones.js");
const Preview = require("./import-preview.cjs");
const { PHONE_HEADER, isPhoneHeader, readPhone, phoneKey } = require("./person-phone.cjs");
const norm = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/\s/g, "")
    .toLowerCase();
const districtKey = (value) => norm(value).replace(/^0*(\d+)(?:구역)?$/u, "$1");
const DISTRICT_HEADER = "인도자구역";
const TEMPLATE_HEADERS = [
  "단계",
  "대상자명",
  "성별",
  "나이",
  "거주지",
  "인도자",
  "교사",
  "찾기날짜",
  ...Milestones.fields.map(({ header }) => header),
  "탈락일",
  "사유",
  "대상자ID",
  "단계변경일",
  PHONE_HEADER,
  DISTRICT_HEADER,
];
const DATE_HEADERS = [
  "찾기날짜",
  ...Milestones.fields.map(({ header }) => header),
  "탈락일",
  "단계변경일",
];
const milestoneHeaders = new Map();
for (const { label, header, stage, aliases = [] } of Milestones.fields) {
  const names = [stage, ...aliases].flatMap((name) => [
    name,
    `${name}일`,
    `${name}날짜`,
    `${name}된날짜`,
  ]);
  for (const alias of [label, header, ...names]) {
    milestoneHeaders.set(norm(alias).toLowerCase(), label);
  }
}
function normalizeHeader(header) {
  if (isPhoneHeader(header)) return PHONE_HEADER;
  const compact = String(header ?? "").normalize("NFC").replace(/\s/g, "");
  if ([DISTRICT_HEADER, "인도구역", "구역"].includes(compact)) return DISTRICT_HEADER;
  return milestoneHeaders.get(norm(compact)) || compact;
}
const HEADERS = TEMPLATE_HEADERS.map(normalizeHeader);

function targetMatcher(ws) {
  const org = O.get(ws);
  const members = new Map(org.members.map((member) => [member.id, member]));
  const peopleByName = new Map();
  for (const person of ws.people) {
    const key = norm(person.name);
    if (!peopleByName.has(key)) peopleByName.set(key, []);
    peopleByName.get(key).push(person);
  }
  return ({ code = "", name, introducer, district, phone }) => {
    if (code) return ws.people.filter((person) => person.code === code || person.id === code);
    const intro = norm(introducer);
    const region = districtKey(district);
    const contact = phoneKey(phone);
    if (!intro && !contact) return [];
    const candidates = (peopleByName.get(norm(name)) || []).filter((person) => {
      const member = members.get(person.introducerId);
      if (region && districtKey(person.region || O.regionOf(org, member?.unitId)) !== region)
        return false;
      if (!intro) return phoneKey(person.phone) === contact;
      return [person.worker, person.introducerSnapshot?.name, person.introducerSnapshot?.code,
        member?.name, member?.code, member?.id].some((value) => norm(value) === intro);
    });
    if (candidates.length <= 1) return candidates;
    const active = candidates.filter((person) => person.status !== "dropped");
    const pool = active.length ? active : candidates;
    if (pool.length > 1 && contact) {
      const exact = pool.filter((person) => phoneKey(person.phone) === contact);
      if (exact.length) return exact;
    }
    return pool;
  };
}

function preview(ws, workbook, actor, { str, day, stageID }) {
  const duplicate = Preview.duplicateCollector();
  const draft = M.copy(ws),
    errors = [],
    warnings = [],
    counts = {
      "일치한 대상자": 0,
      "대상자 정보 갱신": 0,
      "변경 없음": 0,
      "일치 없음": 0,
      "동명이인 확인 필요": 0,
      "중복 행": 0,
    };
  const seen = new Map();
  let total = 0;
  const matchTarget = targetMatcher(ws);
  for (const sheet of workbook.worksheets) {
    if (sheet.name === "작성안내" || !sheet.actualRowCount) continue;
    if (sheet.actualRowCount > 10001 || sheet.columnCount > 50) {
      errors.push(
        `${sheet.name}: 업데이트 양식은 10,000행·50열 이내로 입력해 주세요.`,
      );
      continue;
    }
    const headers = sheet
      .getRow(1)
      .values.slice(1)
      .map((v) => normalizeHeader(str(v)));
    if (
      new Set(headers).size !== headers.length ||
      headers.some((h) => !HEADERS.includes(h)) ||
      (!headers.includes("대상자ID") &&
        (!headers.includes("대상자명") ||
          !(headers.includes("인도자") || headers.includes(PHONE_HEADER))))
    ) {
      errors.push(
        `${sheet.name}: 대상자ID 또는 대상자명과 인도자나 휴대폰 번호 열이 필요합니다.`,
      );
      continue;
    }
    sheet.eachRow((row, index) => {
      if (index === 1 || !row.values.some((v) => v != null && v !== "")) return;
      if (++total > 10000) return;
      try {
        const data = {};
        headers.forEach((h, i) => {
          let v = row.getCell(i + 1).value;
          if (v && typeof v === "object" && !(v instanceof Date)) v = str(v);
          data[h] = v;
        });
        const code = str(data.대상자ID),
          name = str(data.대상자명),
          intro = str(data.인도자),
          entryPhone = data[PHONE_HEADER];
        M.assert(
          code || (name && (intro || phoneKey(entryPhone))),
          "대상자ID 또는 대상자명과 인도자나 휴대폰 번호를 입력해 주세요.",
        );
        const candidates = matchTarget({
          code, name, introducer: intro, district: str(data[DISTRICT_HEADER]), phone: entryPhone,
        });
        if (candidates.length !== 1) {
          counts[candidates.length ? "동명이인 확인 필요" : "일치 없음"]++;
          warnings.push(
            `${sheet.name} ${index}행: ${name || code} · ${candidates.length ? "대상자가 여러 명입니다. 인도자구역·휴대폰 번호 또는 대상자ID를 확인해 주세요." : "일치하는 기존 대상자가 없어 제외"}`,
          );
          return;
        }
        const original = candidates[0];
        M.assert(
          !code || !name || norm(original.name) === norm(name),
          "대상자ID와 대상자명이 다릅니다.",
        );
        const patch = {};
        const stageDate = data.단계변경일 ? day(data.단계변경일) : "";
        const stageLabel = str(data.단계);
        if (stageLabel) patch.stage = stageID(draft, stageLabel);
        if (str(data.교사)) patch.teacher = str(data.교사);
        const phone = readPhone(entryPhone);
        if (phone) patch.phone = phone;
        if (headers.includes("사유")) patch.reason = str(data.사유);
        const dates = {};
        for (const { field, label } of Milestones.fields) {
          if (data[label]) dates[field] = day(data[label]);
        }
        const dropoutDate = data.탈락일 ? day(data.탈락일) : "";
        const signature = M.hash({ patch, dates, dropoutDate, stageDate });
        if (seen.has(original.id)) {
          const first = seen.get(original.id);
          const matching = first.signature === signature;
          duplicate.add(sheet.name, index, data, first.data, {
            matchedRow: first.index,
            matchedSheet: first.sheet,
            blocking: !matching,
            reason: matching
              ? "파일에서 같은 대상자의 변경 내용이 반복됩니다."
              : "파일에서 같은 대상자의 변경 내용이 서로 다릅니다.",
          });
          M.assert(matching, "같은 대상자의 업데이트 내용이 서로 다릅니다.");
          counts["중복 행"]++;
          return;
        }
        seen.set(original.id, { signature, index, sheet: sheet.name, data });
        counts["일치한 대상자"]++;
        const before = draft.people.find((p) => p.id === original.id);
        const after = M.validatePerson({ ...before, ...patch }, draft, before);
        if (after.stage !== before.stage) {
          const field = Object.keys(S.FIELDS).find(
            (key) => S.stageId(draft, key) === after.stage,
          );
          const now = new Date();
          const at =
            stageDate || dates[field]
              ? `${stageDate || dates[field]}T00:00`
              : new Date(now.getTime() - now.getTimezoneOffset() * 60000)
                  .toISOString()
                  .slice(0, 16);
          M.transition(
            after,
            before.stage,
            after.stage,
            at,
            actor,
            patch.reason || "엑셀 대상자 업데이트",
            draft.stageNames,
          );
          if (stageDate || dates[field])
            after.transitions.at(-1).timeUnknown = true;
        }
        const stageDates = S.apply(after, dates, draft);
        const lifecycle = dropoutDate
          ? P.apply(
              after,
              {
                dropoutStatus: "dropped",
                dropoutDate,
                dropoutReason: after.reason || "엑셀 대상자 업데이트",
              },
              actor,
            )
          : null;
        const delta = M.personChanges(before, after);
        if (
          !Object.keys(delta.after).length &&
          !stageDates.length &&
          !lifecycle
        ) {
          counts["변경 없음"]++;
          duplicate.add(sheet.name, index, data, before, {
            reason: "기존 대상자와 같은 값입니다.",
          });
          return;
        }
        draft.people[draft.people.indexOf(before)] = after;
        if (Object.keys(delta.after).length)
          M.audit(
            draft,
            actor,
            "엑셀 대상자 업데이트",
            after.id,
            delta.before,
            delta.after,
          );
        if (lifecycle)
          M.audit(
            draft,
            actor,
            lifecycle.action,
            after.id,
            lifecycle.before,
            lifecycle.after,
          );
        S.audit(draft, actor, after, stageDates);
        counts["대상자 정보 갱신"]++;
      } catch (error) {
        errors.push(`${sheet.name} ${index}행: ${error.message}`);
      }
    });
  }
  if (total > 10000)
    errors.push("업데이트는 한 번에 10,000행까지 반영할 수 있습니다.");
  if (!total && !errors.length) errors.push("업데이트할 행이 없습니다.");
  if (!errors.length)
    try {
      M.validateWorkspace(draft);
    } catch (error) {
      errors.push(error.message);
    }
  warnings.unshift(
    "기존 대상자만 업데이트합니다. 교사·날짜·휴대폰 번호의 빈칸은 기존 값을 유지하고, 사유의 빈칸은 비웁니다.",
  );
  return {
    draft,
    errors,
    warnings,
    counts,
    totalChanges: draft.revision - ws.revision,
    ...duplicate.result(),
    changes: draft.history
      .slice(ws.history.length, ws.history.length + Preview.PREVIEW_LIMIT)
      .map((h) => ({
        action: h.action,
        target: draft.people.find((p) => p.id === h.target)?.name || h.target,
        before: Preview.fields(h.before),
        after: Preview.fields(h.after),
      })),
  };
}
module.exports = { HEADERS, TEMPLATE_HEADERS, DATE_HEADERS, targetMatcher, preview };
