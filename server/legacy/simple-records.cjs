"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  K = require("./codes.cjs"),
  S = require("./person-stages.cjs");
const { PHONE_HEADER, readPhone } = require("./person-phone.cjs");
const HEADERS = {
  활동기록: [
    "날짜",
    "활동자",
    "활동장소",
    "시작시간",
    "종료시간",
    "활동종류",
    "활동메모",
    "분류2",
  ],
  찾기건: [
    "날짜",
    "분류1",
    "분류2",
    "사용도구",
    "단계",
    "대상자명",
    "성별",
    "나이",
    "거주지",
    "찾기장소",
    "시간",
    "인도자",
    "사유",
    "교사",
    "만픽일",
    "찾A일",
    "복신일",
    PHONE_HEADER,
  ],
};
function apply(ws, rows, actor, parse) {
  const { str, day, clock, stageID, duplicate } = parse,
    counts = {},
    errors = [],
    seen = new Map();
  const now = new Date();
  const observedDay = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const remember = (sheet, code, index, data, before, unchanged) => {
    const key = `${sheet}/${code}`,
      first = seen.get(key);
    if (unchanged)
      duplicate?.(
        sheet,
        index,
        data,
        first?.data || before,
        first
          ? {
              matchedRow: first.index,
              matchedSheet: sheet,
              reason: "파일의 앞 행과 같은 기록입니다.",
            }
          : undefined,
      );
    seen.set(key, { index, data });
  };
  const bump = (key) => {
    counts[key] = (counts[key] || 0) + 1;
  };
  const choice = (groupId, value) => {
    if (!value) return "";
    try {
      return K.resolve(ws, groupId, value);
    } catch {
      const delta = K.saveItem(ws, { groupId, value, label: value });
      M.audit(ws, actor, "간단 활동 선택값 등록", delta.after.id, null, {
        ...delta.after,
        groupId,
      });
      bump("공통코드");
      return delta.after.value;
    }
  };
  const member = (value) => {
    const token = str(value);
    M.assert(token, "활동자 또는 인도자 이름을 입력하세요.");
    const matches = O.get(ws).members.filter(
      (m) =>
        m.name === token ||
        `${m.name} · ${O.pathName(O.get(ws), m.unitId)}` === token,
    );
    M.assert(
      matches.length === 1,
      matches.length
        ? `${token}: 동명이인은 이름 · 지역 / 구역 형식으로 소속을 함께 입력하세요.`
        : `${token}: 활동자 명부에 먼저 등록하세요.`,
    );
    return matches[0];
  };
  const same = (a, b) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(a).filter(
          ([k]) => !["createdAt", "updatedAt"].includes(k),
        ),
      ),
    ) ===
    JSON.stringify(
      Object.fromEntries(
        Object.entries(b).filter(
          ([k]) => !["createdAt", "updatedAt"].includes(k),
        ),
      ),
    );
  for (const { data: d, index } of rows.활동기록 || [])
    try {
      const m = member(d.활동자),
        date = day(d.날짜),
        start = clock(d.시작시간),
        end = clock(d.종료시간),
        place = choice("activityPlace", str(d.활동장소));
      const sessionKey = str(d.회차ID);
      M.assert(
        !sessionKey || /^AP-[a-f0-9]{32}$/.test(sessionKey),
        "회차 정보를 확인해 주세요.",
      );
      const code = `SA-${M.hash([m.code, date, start, end, place, ...(sessionKey ? [sessionKey] : [])]).slice(0, 32)}`;
      const before = ws.activityLogs.find((a) => a.code === code);
      M.assert(
        m.status === "active" || before,
        "활동 중인 활동자를 선택하세요.",
      );
      const region = before?.region ?? O.regionOf(O.get(ws), m.unitId);
      const after = M.validateActivity(
        {
          ...before,
          code,
          date,
          start,
          end,
          place,
          kind: choice("activityKind", str(d.활동종류)) || before?.kind,
          notes: str(d.활동메모),
          ...(Object.hasOwn(d, "분류2")
            ? { classification2: str(d.분류2) }
            : {}),
          ...(sessionKey ? { sessionKey } : {}),
          worker: before?.worker ?? m.name,
          workerId: m.code,
          region,
          className: before?.className ?? m.className,
          ...(before ? {} : O.reportDimensions(ws, m, region)),
        },
        before,
        ws,
      );
      const unchanged = before && same(before, after);
      if (unchanged) {
        remember("활동기록", code, index, d, before, true);
        bump("중복 건너뜀");
        continue;
      }
      M.assertNoActivityOverlap(ws, after);
      remember("활동기록", code, index, d, before, false);
      if (before) ws.activityLogs[ws.activityLogs.indexOf(before)] = after;
      else ws.activityLogs.push(after);
      M.audit(
        ws,
        actor,
        before ? "간단 활동 수정" : "간단 활동 등록",
        after.id,
        before || null,
        after,
      );
      bump(before ? "활동 수정" : "활동 신규");
    } catch (e) {
      errors.push(`활동기록 ${index}행: ${e.message}`);
    }
  for (const { data: d, index } of rows.찾기건 || [])
    try {
      const m = member(d.인도자),
        date = day(d.날짜),
        time = clock(d.시간),
        name = str(d.대상자명),
        gender = str(d.성별) || "미입력",
        residence = str(d.거주지),
        place = str(d.찾기장소);
      const generated = `SF-${M.hash([m.code, date, name, gender, residence, place, time]).slice(0, 32)}`;
      const candidates = ws.people.filter(
        (p) =>
          p.code === generated ||
          (p.name === name &&
            p.date === date &&
            p.introducerId === m.id &&
            p.gender === gender &&
            (p.residence || "") === residence &&
            (p.place || "") === place &&
            (p.time || "") === time),
      );
      M.assert(
        candidates.length <= 1,
        `${name}: 같은 조건의 대상자가 여러 명입니다. 앱에서 먼저 확인하세요.`,
      );
      const before = candidates[0];
      M.assert(
        m.status === "active" || before,
        "활동 중인 인도자를 선택하세요.",
      );
      const defaultStage = ws.stages.find(
        (s) => !ws.inactiveStages.includes(s),
      );
      const stage = str(d.단계)
        ? stageID(ws, d.단계)
        : before?.stage || defaultStage;
      const dates = {
        manpikDate: d.만픽일 ? day(d.만픽일) : "",
        findADate: d.찾A일 ? day(d.찾A일) : "",
        bokshinDate: d.복신일 ? day(d.복신일) : "",
      };
      const after = M.validatePerson(
        {
          ...before,
          code: before?.code || generated,
          name,
          date,
          time,
          ...(Object.hasOwn(d, "분류1")
            ? { classification1: str(d.분류1) }
            : {}),
          ...(Object.hasOwn(d, "분류2")
            ? { classification2: str(d.분류2) }
            : {}),
          gender,
          age: str(d.나이),
          ageAsOf: before?.ageAsOf || date,
          residence,
          phone: readPhone(d[PHONE_HEADER]) || before?.phone,
          place,
          tool: str(d.사용도구),
          teacher: str(d.교사),
          reason: str(d.사유),
          introducerId: m.id,
          region: before?.region ?? O.regionOf(O.get(ws), m.unitId),
          className: before?.className ?? m.className,
          worker: before?.worker ?? m.name,
          stage,
        },
        ws,
        before,
      );
      if (!before || before.stage !== stage) {
        const field = Object.keys(S.FIELDS).find(
          (key) => S.stageId(ws, key) === stage,
        );
        const enteredBefore = before?.transitions.some(
          (event) => event.to === stage,
        );
        const confirmedDay = field && !enteredBefore ? dates[field] : "";
        const initialFinding =
          !before && stage === defaultStage && !confirmedDay;
        const observation = !initialFinding && !confirmedDay;
        const event = M.transition(
          after,
          before?.stage || null,
          stage,
          initialFinding
            ? `${date}T${time || "00:00"}`
            : `${confirmedDay || observedDay}T00:00`,
          actor,
          str(d.사유) ||
            (observation
              ? "엑셀 현재 단계 확인 · 실제 변경일 미기록"
              : before
                ? ""
                : "엑셀 최초 등록"),
          ws.stageNames,
        );
        if (!initialFinding || !time) event.timeUnknown = true;
        if (observation) event.baseline = true;
      }
      const stageDateChanges = S.apply(after, dates, ws);
      const unchanged = before && same(before, after);
      remember("찾기건", after.code, index, d, before, unchanged);
      if (unchanged) {
        bump("중복 건너뜀");
        continue;
      }
      if (!before) ws.people.push(after);
      else ws.people[ws.people.indexOf(before)] = after;
      const changes = M.personChanges(before, after);
      M.audit(
        ws,
        actor,
        before ? "간단 찾기건 수정" : "간단 찾기건 등록",
        after.id,
        changes.before,
        changes.after,
      );
      S.audit(ws, actor, after, stageDateChanges);
      bump(before ? "대상자 정보 갱신" : "신규 대상자");
    } catch (e) {
      errors.push(`찾기건 ${index}행: ${e.message}`);
    }
  return { counts, errors };
}
module.exports = { HEADERS, apply };
