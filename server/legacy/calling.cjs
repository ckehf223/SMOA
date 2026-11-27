"use strict";

const M = require("./model.cjs");
const O = require("./organization.cjs");

const RESULTS = ["만픽", "부재", "재통화", "거절", "기타"];
const CALLBACK_ALIASES = new Set(["재콜요청", "차후재콜링"]);
const ROUND_LABELS = ["신규", "1차", "2차", "3차", "4차", "추가회차"];
const ROUNDS = ROUND_LABELS.map((_, round) => round);
const MAX_RECORDS = 100000;
const MAX_NOTES = 5000;
const MAX_ROUND_LENGTH = 60;
const MAX_RESULT_LENGTH = 100;
const LOOKUP_LIMIT = 50;
const DAY = 86400000;
const normalize = (value) => value.normalize("NFKC").toLowerCase();
const callerKey = (value) => normalize(value).trim().replace(/\s+/g, " ");
const searchKey = (value) => normalize(value).replace(/\s+/g, "");
const collator = new Intl.Collator("ko", { numeric: true });

function personKey({ personId, area, personName, introducer }) {
  return (
    personId ||
    JSON.stringify([
      searchKey(area).replace(/^(\d+)구역$/, "$1"),
      searchKey(personName),
      searchKey(introducer),
    ])
  );
}

function attemptKey(record) {
  const { date, time, caller, result, originalResult } = record;
  const fields = [
    personKey(record),
    date,
    time ?? "",
    callerKey(caller),
    recordRound(record),
    result,
  ];
  if (result === "기타" && originalResult) fields.push(searchKey(originalResult));
  return JSON.stringify(fields);
}

function attemptIndex(records, { matchUnlinked = false } = {}) {
  const keys = new Set(records.map(attemptKey));
  return {
    has(record, { personName, introducer, area } = record) {
      return (
        keys.has(attemptKey(record)) ||
        (matchUnlinked &&
          Boolean(record.personId) &&
          keys.has(attemptKey({ ...record, personId: "", personName, introducer, area })))
      );
    },
    add(record) {
      keys.add(attemptKey(record));
    },
  };
}

function parseRound(value, { legacyFifth = true } = {}) {
  if (typeof value === "number") return ROUNDS.includes(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const label = value.normalize("NFKC").trim().replace(/[^\S\r\n]+/g, " ");
  if (!label || label.length > MAX_ROUND_LENGTH || /\p{C}/u.test(label))
    return undefined;
  const key = searchKey(label);
  if (key === "추가" || (legacyFifth && key === "5차")) return 5;
  const builtin = ROUNDS.find(
    (round) => key === String(round) || key === ROUND_LABELS[round],
  );
  if (builtin !== undefined) return builtin;
  if (/^\d+$/u.test(key)) return undefined;
  const numbered = /^(\d+)(?:회)?차$/u.exec(key);
  if (!numbered) return label;
  const digits = numbered[1].replace(/^0+/u, "");
  if (!digits) return undefined;
  if (/^[1-4]$/u.test(digits) || (digits === "5" && legacyFifth))
    return Number(digits);
  return `${digits}차`;
}

const roundLabel = (round) =>
  typeof round === "number" ? ROUND_LABELS[round] : round;
const recordRound = ({ round, roundName }) => roundName ?? round;
const sortRound = (left, right) => {
  if (left === 0) return right === 0 ? 0 : -1;
  if (right === 0) return 1;
  if (left === 5) return right === 5 ? 0 : 1;
  if (right === 5) return -1;
  return collator.compare(roundLabel(left), roundLabel(right));
};

function parseResult(value, { migration = false, freeText = false } = {}) {
  const originalResult = M.text(value ?? "", MAX_RESULT_LENGTH);
  const key = searchKey(originalResult);
  const result = RESULTS.find((label) => searchKey(label) === key);
  if (result && freeText && result !== originalResult)
    return { result, reportedResult: originalResult };
  if (result) return { result };
  if (!key) return null;
  if (freeText && CALLBACK_ALIASES.has(key)) {
    // Older versions interpret these originals as 기타. Keep their result readable.
    return { result: "재통화", reportedResult: originalResult };
  }
  if (!migration && !freeText) {
    if (key === "재콜요청") return { result: "재통화" };
    if (key !== "다른번호") return null;
  }
  return { result: key === "재콜링" ? "재통화" : "기타", originalResult };
}

function personProfile(ws) {
  const org = O.get(ws);
  const members = new Map(org.members.map((member) => [member.id, member]));
  const areas = new Map();
  return (person) => {
    const member = members.get(person.introducerId);
    let area = person.region || "";
    if (!area && member?.unitId) {
      if (!areas.has(member.unitId)) {
        areas.set(member.unitId, O.regionOf(org, member.unitId));
      }
      area = areas.get(member.unitId);
    }
    return {
      personName: person.name,
      personCode: person.code,
      introducer:
        member?.name || person.introducerSnapshot?.name || person.worker || "",
      area,
      findingDate: person.dateUnknown ? "" : person.date,
    };
  };
}

function personFields(entry, linked) {
  const personCode = M.text(entry.personCode, 60, linked);
  const findingDate = M.date(entry.findingDate, false);
  M.assert(
    linked || (!personCode && !findingDate),
    "미연결 콜링의 대상자 정보가 올바르지 않습니다.",
  );
  return {
    personName: M.text(entry.personName, 100, true),
    personCode,
    introducer: M.text(entry.introducer, 100),
    area: M.text(entry.area, 60, !linked),
    findingDate,
  };
}

function attemptFields(input) {
  const round = parseRound(input.round, { legacyFifth: false });
  M.assert(
    round !== undefined,
    `콜링 차수 또는 회차 이름을 ${MAX_ROUND_LENGTH}자 이내로 입력해 주세요.`,
  );
  M.assert(RESULTS.includes(input.result), "콜링 결과를 선택해 주세요.");
  const time = input.time ?? "";
  const originalResult = M.text(input.originalResult ?? "", MAX_RESULT_LENGTH);
  const reportedResult = M.text(input.reportedResult ?? "", MAX_RESULT_LENGTH);
  if (originalResult) {
    const parsed = parseResult(originalResult, { migration: true });
    M.assert(
      parsed?.originalResult && parsed.result === input.result,
      "콜링 원본 결과를 확인해 주세요.",
    );
  }
  if (reportedResult) {
    const parsed = parseResult(reportedResult, { freeText: true });
    M.assert(
      !originalResult && parsed?.reportedResult && parsed.result === input.result,
      "콜링 원본 결과를 확인해 주세요.",
    );
  }
  return {
    personId: input.personId === "" ? "" : M.id(input.personId),
    date: M.date(input.date),
    time: M.time(time, time !== ""),
    caller: M.text(input.caller, 100, true),
    // Keep the numeric fallback readable by earlier app versions.
    round: typeof round === "number" ? round : 5,
    ...(typeof round === "string" ? { roundName: round } : {}),
    result: input.result,
    notes: M.text(input.notes ?? "", MAX_NOTES),
    ...(originalResult ? { originalResult } : {}),
    ...(reportedResult ? { reportedResult } : {}),
  };
}

function validate(ws) {
  if (!Object.hasOwn(ws, "callingRecords")) ws.callingRecords = [];
  M.assert(
    Array.isArray(ws.callingRecords) && ws.callingRecords.length <= MAX_RECORDS,
    "콜링 기록 형식 또는 기록 수를 확인해 주세요.",
  );
  const ids = new Set();
  for (const entry of ws.callingRecords) {
    const id = M.id(entry.id);
    M.assert(!ids.has(id), "중복된 콜링 기록 식별자입니다.");
    ids.add(id);
    const attempt = attemptFields({ ...entry, round: recordRound(entry) });
    M.assert(
      attempt.round === entry.round && attempt.roundName === entry.roundName,
      "저장된 콜링 차수 형식을 확인해 주세요.",
    );
    personFields(entry, Boolean(entry.personId));
  }
}

function save(ws, input, actor) {
  const records = ws.callingRecords;
  const id = M.id(input.id || input.requestId || M.uuid());
  const index = records.findIndex((entry) => entry.id === id);
  const before = records[index];
  M.assert(!input.id || before, "수정할 콜링 기록을 찾을 수 없습니다.");
  const resultText = M.text(input.resultText ?? input.result ?? "", MAX_RESULT_LENGTH);
  const previousText = before?.originalResult ?? before?.reportedResult ?? before?.result;
  const keepOutcome = before &&
    (resultText === previousText || (input.resultText === undefined && resultText === before.result));
  const outcome = keepOutcome
    ? { result: before.result, originalResult: before.originalResult, reportedResult: before.reportedResult }
    : parseResult(resultText, { freeText: true });
  M.assert(outcome, "콜링 결과를 입력해 주세요.");
  const attempt = attemptFields({
    personId: input.personId,
    date: input.date,
    caller: input.caller,
    round: input.round,
    time: input.time ?? before?.time,
    notes: input.notes ?? before?.notes,
    ...outcome,
  });
  const previous = before && {
    ...before,
    time: before.time ?? "",
    notes: before.notes ?? "",
  };
  if (before && !input.id) {
    M.assert(
      attempt.roundName === previous.roundName &&
        Object.keys(attempt).every((key) => attempt[key] === previous[key]),
      "이미 등록된 콜링 기록입니다.",
    );
    return false;
  }
  const target = ws.people.find((person) => person.id === attempt.personId);
  M.assert(
    before?.personId !== "" || !attempt.personId,
    "미연결 콜링은 원본 대상자 정보를 유지합니다.",
  );
  M.assert(
    target || before?.personId === attempt.personId,
    "대상자 관리에 등록된 대상자를 선택해 주세요.",
  );
  const profile = personFields(
    target ? personProfile(ws)(target) : before,
    Boolean(attempt.personId),
  );
  const after = { id, ...attempt, ...profile };
  if (
    before &&
    after.roundName === previous.roundName &&
    after.originalResult === previous.originalResult &&
    after.reportedResult === previous.reportedResult &&
    Object.keys(after).every((key) => after[key] === previous[key])
  )
    return false;
  M.assert(
    before || records.length < MAX_RECORDS,
    "콜링 기록 수 제한을 초과했습니다.",
  );
  if (before) records[index] = after;
  else records.push(after);
  M.audit(
    ws,
    actor,
    before ? "콜링 기록 수정" : "콜링 기록 등록",
    id,
    before,
    after,
  );
}

function remove(ws, input, actor) {
  const id = M.id(input.id);
  const index = ws.callingRecords.findIndex((entry) => entry.id === id);
  M.assert(index !== -1, "삭제할 콜링 기록을 찾을 수 없습니다.");
  const [entry] = ws.callingRecords.splice(index, 1);
  M.audit(ws, actor, "콜링 기록 삭제", id, entry, null);
}

function saveMany(ws, rows, actor, { migration = false, source } = {}) {
  const report = source === "report";
  M.assert(
    Array.isArray(rows) && rows.length && rows.length <= MAX_RECORDS,
    "저장할 콜링 기록을 확인해 주세요.",
  );
  const records = ws.callingRecords;
  const attempts = attemptIndex(records, { matchUnlinked: report });
  const targets = new Map(ws.people.map((person) => [person.id, person]));
  const profileOf = personProfile(ws);
  const added = [];
  for (const row of rows) {
    const attempt = attemptFields(row);
    M.assert(
      attempt.personId || report || migration === true,
      "미연결 대상자는 콜링 일보 또는 MIG 엑셀로 가져와 주세요.",
    );
    const target = targets.get(attempt.personId);
    M.assert(
      !attempt.personId || target,
      "대상자 관리에 등록된 대상자를 확인해 주세요.",
    );
    const profile = personFields(
      target ? profileOf(target) : row,
      Boolean(attempt.personId),
    );
    const record = { ...attempt, ...profile };
    if (attempts.has(record, row.reportPerson)) continue;
    attempts.add(record);
    added.push({
      id: M.uuid(),
      ...record,
    });
  }
  if (!added.length) return 0;
  M.assert(
    records.length + added.length <= MAX_RECORDS,
    "콜링 기록 수 제한을 초과했습니다.",
  );
  M.audit(
    ws,
    actor,
    report ? "콜링 일보 가져오기" : "콜링 엑셀 가져오기",
    ws.id,
    null,
    added,
  );
  ws.callingRecords = records.concat(added);
  return added.length;
}

function people(ws, input = {}) {
  const search = searchKey(M.text(input.search ?? "", 200));
  const profileOf = personProfile(ws);
  return ws.people
    .flatMap((person) => {
      const {
        personName: name,
        personCode: code,
        ...profile
      } = profileOf(person);
      if (
        search &&
        ![name, code, profile.introducer, profile.area].some((value) =>
          searchKey(value).includes(search),
        )
      ) {
        return [];
      }
      return [{ id: person.id, name, code, ...profile }];
    })
    .sort(
      (a, b) =>
        b.findingDate.localeCompare(a.findingDate) ||
        collator.compare(a.name, b.name) ||
        collator.compare(a.code, b.code),
    )
    .slice(0, LOOKUP_LIMIT);
}

const emptyCounts = () => ({ count: 0, successes: 0, rate: null });
const rate = (part, total) => (total ? (part * 100) / total : null);

function tally(aggregate, success) {
  aggregate.count++;
  if (success) aggregate.successes++;
  aggregate.rate = rate(aggregate.successes, aggregate.count);
}

function group(groups, fields, success) {
  const key = JSON.stringify(Object.values(fields));
  if (!groups.has(key)) groups.set(key, { ...fields, ...emptyCounts() });
  tally(groups.get(key), success);
}

function lagSummary(firstSuccess) {
  const days = [...firstSuccess.values()]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const count = days.length;
  const midpoint = Math.floor(count / 2);
  return {
    count,
    missing: firstSuccess.size - count,
    average: count
      ? days.reduce((total, value) => total + value, 0) / count
      : null,
    median: count
      ? (days[Math.floor((count - 1) / 2)] + days[midpoint]) / 2
      : null,
    p80: count ? days[Math.ceil(0.8 * count) - 1] : null,
    within: [0, 1, 3, 7, 14, 30].map((limit) => {
      const within = days.filter((day) => day <= limit).length;
      return { days: limit, count: within, rate: rate(within, count) };
    }),
  };
}

function query(ws, input = {}) {
  const from = M.date(input.from, false);
  const to = M.date(input.to, false);
  M.assert(
    !from || !to || from <= to,
    "조회 시작일은 종료일보다 늦을 수 없습니다.",
  );
  const search = searchKey(M.text(input.search ?? "", 200));
  const filterCaller = callerKey(M.text(input.caller ?? "", 100));
  const records = ws.callingRecords || [];
  const rounds = new Set(ROUNDS);
  const callers = new Map();
  for (const record of records) {
    const key = callerKey(record.caller);
    if (!callers.has(key)) callers.set(key, record.caller);
    rounds.add(recordRound(record));
  }
  const requestedRound = parseRound(input.round, { legacyFifth: false });
  const filterRound = requestedRound === "5차" && !rounds.has(requestedRound)
    ? 5
    : requestedRound;
  const hasRoundFilter = filterRound !== undefined;
  M.assert(
    input.round == null || input.round === "" || hasRoundFilter,
    "조회할 콜링 차수 또는 회차 이름을 확인해 주세요.",
  );
  if (hasRoundFilter) rounds.add(filterRound);
  const sortedRounds = [...rounds].sort(sortRound);
  const targets = new Map(ws.people.map((person) => [person.id, person]));
  const profileOf = personProfile(ws);
  const profiles = new Map();
  const rows = [];
  const totals = emptyCounts();
  const targetIds = new Set();
  const byHour = new Map();
  const byCaller = new Map();
  const byRound = new Map(sortedRounds.map((round) => [round, { round, ...emptyCounts() }]));
  const byCallerHour = new Map();
  const byCallerRound = new Map();
  const firstSuccess = new Map();
  let missingTime = 0;

  for (const record of records) {
    const { personId, date, result } = record;
    const round = recordRound(record);
    const time = record.time ?? "";
    const key = callerKey(record.caller);
    if (
      (from && date < from) ||
      (to && date > to) ||
      (filterCaller && key !== filterCaller) ||
      (hasRoundFilter && round !== filterRound)
    )
      continue;
    const caller = callers.get(key);
    const target = targets.get(personId);
    if (target && !profiles.has(personId))
      profiles.set(personId, profileOf(target));
    const profile = profiles.get(personId) || record;
    const { personName, personCode, introducer, area, findingDate } = profile;
    const notes = record.notes ?? "";
    const originalResult = record.originalResult ?? record.reportedResult;
    if (
      search &&
      ![
        personName, personCode, introducer, area, caller,
        result, originalResult ?? "", roundLabel(round), notes,
      ].some((value) => searchKey(value).includes(search))
    )
      continue;
    if (input.includeRows !== false) {
      rows.push({
        ...record,
        ...(originalResult ? { originalResult } : {}),
        round,
        time,
        personName,
        personCode,
        introducer,
        area,
        findingDate,
        notes,
        personDeleted: Boolean(personId) && !target,
        personUnlinked: !personId,
      });
    }
    const success = result === "만픽";
    targetIds.add(personKey(record));
    tally(totals, success);
    if (time) {
      const hour = Number(time.slice(0, 2));
      group(byHour, { hour }, success);
      group(byCallerHour, { caller, hour }, success);
    } else {
      missingTime++;
    }
    group(byCaller, { caller }, success);
    tally(byRound.get(round), success);
    group(byCallerRound, { caller, round }, success);
    if (success && personId) {
      const delay =
        findingDate && date >= findingDate
          ? (Date.parse(date) - Date.parse(findingDate)) / DAY
          : Infinity;
      firstSuccess.set(
        personId,
        Math.min(firstSuccess.get(personId) ?? Infinity, delay),
      );
    }
  }

  const sortCaller = (a, b) => collator.compare(a.caller, b.caller);
  return {
    rows: rows.sort(
      (a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time),
    ),
    callers: [...callers.values()].sort(collator.compare),
    rounds: sortedRounds.map((round) => [round, roundLabel(round)]),
    totals: { ...totals, targets: targetIds.size, callerCount: byCaller.size },
    missingTime,
    byHour: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    byCaller: [...byCaller.values()].sort(sortCaller),
    byRound: hasRoundFilter ? [byRound.get(filterRound)] : [...byRound.values()],
    byCallerHour: [...byCallerHour.values()].sort(
      (a, b) => sortCaller(a, b) || a.hour - b.hour,
    ),
    byCallerRound: [...byCallerRound.values()].sort(
      (a, b) => sortCaller(a, b) || sortRound(a.round, b.round),
    ),
    lag: lagSummary(firstSuccess),
  };
}

function reportText(ws, options = {}) {
  const { byRound, totals } = query(ws, { ...options, includeRows: false });
  const { from, to } = options;
  let date = "전체 기간";
  if (from && to) date = from === to ? from : `${from} ~ ${to}`;
  else if (from) date = `${from}부터`;
  else if (to) date = `${to}까지`;
  const count = (value) => value.toLocaleString("ko-KR");
  const lines = byRound.filter((row) => row.count > 0).map((row) => {
    const label = roundLabel(row.round);
    const heading = label.endsWith("콜링") ? label : `${label}콜링`;
    return `✔️${heading} ${count(row.count)}건 중 ${count(row.successes)}건 연결`;
  });
  return [
    "< 콜링 결과 보고 >",
    `날짜: ${date}`,
    "",
    ...lines,
    "",
    "",
    "",
    `🔺 총 ${count(totals.count)}건 중 ${count(totals.successes)}건 연결 (${(totals.rate ?? 0).toFixed(0)}%)`,
  ].join("\n");
}

module.exports = {
  RESULTS,
  ROUNDS,
  ROUND_LABELS,
  MAX_RECORDS,
  MAX_NOTES,
  MAX_ROUND_LENGTH,
  callerKey,
  personProfile,
  parseRound,
  roundLabel,
  parseResult,
  attemptKey,
  attemptIndex,
  validate,
  save,
  remove,
  saveMany,
  people,
  query,
  reportText,
};
