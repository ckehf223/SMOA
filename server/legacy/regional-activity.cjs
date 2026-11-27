"use strict";
const O = require("./organization.cjs");
const {
  parseActivityRosterRules,
  activityReportName,
  isExcludedActivityMember,
} = require("./daily-activity-roster.cjs");
const LABELS = Object.freeze({
  1: "적극적 활동자",
  2: "전도비 후원자",
  3: "소극적 활동자",
  4: "비활동자",
});
const MAX_RECORDS = 1000000;
const UNASSIGNED = "구역 미입력";
const byName = new Intl.Collator("ko", { numeric: true }).compare;
const sortMembers = (a, b) =>
  byName(a.name, b.name) || byName(a.memberCode, b.memberCode);
const recordKey = (period, memberId) => `${period}/${memberId}`;
const model = () => require("./model.cjs");
const hasDate = (input) => input?.date != null && input.date !== "";

function monthValue(month) {
  model().assert(
    typeof month === "string" &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
      !month.startsWith("0000"),
    "기준월을 YYYY-MM 형식으로 입력해 주세요.",
  );
  return month;
}

function dateValue(date) {
  const timestamp =
    typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? Date.parse(`${date}T00:00:00Z`)
      : NaN;
  model().assert(
    Number.isFinite(timestamp) &&
      !date.startsWith("0000") &&
      new Date(timestamp).toISOString().slice(0, 10) === date,
    "기록일을 YYYY-MM-DD 형식의 유효한 날짜로 입력해 주세요.",
  );
  return date;
}

function recordPeriod(input) {
  if (!hasDate(input)) return { month: monthValue(input?.month), date: null };
  const date = dateValue(input.date),
    month = date.slice(0, 7);
  model().assert(
    input.month === undefined || input.month === month,
    "기록일이 기준월에 속해야 합니다.",
  );
  return { month, date };
}

function previousOf(month) {
  const [year, number] = month.split("-").map(Number);
  if (number > 1)
    return `${month.slice(0, 4)}-${String(number - 1).padStart(2, "0")}`;
  return year > 1 ? `${String(year - 1).padStart(4, "0")}-12` : null;
}

function codeValue(code) {
  model().assert(
    Number.isInteger(code) && Object.hasOwn(LABELS, code),
    "활동구분은 1~4에서 선택해 주세요.",
  );
  return code;
}

function validate(ws) {
  const M = model(),
    records = ws.regionalActivities;
  if (records === undefined) return;
  M.assert(
    Array.isArray(records) && records.length <= MAX_RECORDS,
    "월별 활동구분 기록 형식을 확인해 주세요.",
  );
  const seen = new Set();
  for (const row of records) {
    M.assert(
      row && typeof row === "object" && !Array.isArray(row),
      "월별 활동구분 기록 형식을 확인해 주세요.",
    );
    const month = monthValue(row.month);
    const date = row.date === undefined ? null : dateValue(row.date);
    M.assert(
      !date || date.slice(0, 7) === month,
      "기록일이 기준월에 속해야 합니다.",
    );
    const key = recordKey(date || month, M.id(row.memberId));
    codeValue(row.code);
    M.text(row.region, 60);
    if (row.name !== undefined) M.text(row.name, 100, true);
    if (row.memberCode !== undefined) M.text(row.memberCode, 60, true);
    M.assert(
      !seen.has(key),
      "같은 구성원의 같은 날짜 또는 날짜 없는 월별 활동구분이 중복되었습니다.",
    );
    seen.add(key);
  }
}

function saveMany(ws, input, actor) {
  const M = model(),
    rows = input?.rows;
  M.assert(
    Array.isArray(rows) && rows.length > 0 && rows.length <= 30000,
    "활동구분을 한 번에 1~30,000건까지 저장할 수 있습니다.",
  );
  const rowDates = !hasDate(input) && rows.some(hasDate);
  const shared = rowDates ? null : recordPeriod(input);
  const periods = new Set(),
    seen = new Set();
  const entries = rows.map((row) => {
    if (rowDates)
      M.assert(
        hasDate(row),
        "일자별 일괄 저장의 모든 행에 기록일을 입력해 주세요.",
      );
    const { month, date } = shared || recordPeriod(row);
    M.assert(
      !hasDate(row) || row.date === date,
      "일괄 저장에 선택한 기록일을 확인해 주세요.",
    );
    M.assert(
      (input.month === undefined || input.month === month) &&
        (row?.month === undefined || row.month === month),
      "기록일이 기준월에 속해야 합니다.",
    );
    const memberId = M.id(row?.memberId),
      code = codeValue(row?.code);
    const period = date || month,
      key = recordKey(period, memberId);
    M.assert(
      !seen.has(key),
      "같은 구성원의 같은 날짜 또는 날짜 없는 월별 활동구분이 중복되었습니다.",
    );
    seen.add(key);
    periods.add(period);
    return { month, date, memberId, code, key };
  });
  const org = O.get(ws),
    members = new Map(org.members.map((m) => [m.id, m])),
    records = [...(ws.regionalActivities || [])],
    indices = new Map(),
    beforeRows = [],
    afterRows = [],
    regions = new Map();
  records.forEach((record, index) => {
    const period = record.date || record.month;
    if (periods.has(period))
      indices.set(recordKey(period, record.memberId), index);
  });
  for (const { month, date, memberId, code, key } of entries) {
    const member = members.get(memberId);
    M.assert(member, "등록된 구성원을 선택해 주세요.");
    const index = indices.get(key),
      before = index === undefined ? null : records[index];
    if (before?.code === code) continue;
    if (!before && !regions.has(member.unitId))
      regions.set(member.unitId, O.regionOf(org, member.unitId));
    const after = {
      month,
      ...(date ? { date } : {}),
      memberId,
      code,
      region: before?.region ?? regions.get(member.unitId),
      name: before?.name ?? member.name,
      memberCode: before?.memberCode ?? member.code,
    };
    if (before) records[index] = after;
    else records.push(after);
    if (before) beforeRows.push(before);
    afterRows.push(after);
  }
  if (!afterRows.length) return 0;
  M.assert(
    records.length <= MAX_RECORDS,
    "지역활동기록은 최대 1,000,000건까지 저장할 수 있습니다.",
  );
  const savedPeriods = [
    ...new Set(afterRows.map((row) => row.date || row.month)),
  ].sort();
  const target =
    savedPeriods.length === 1
      ? savedPeriods[0]
      : `${savedPeriods[0]} ~ ${savedPeriods.at(-1)}`;
  const unit = entries[0].date ? "일자별" : "월별";
  M.audit(
    ws,
    actor,
    rows.length === 1 ? `${unit} 활동구분 저장` : `${unit} 활동구분 일괄 저장`,
    target,
    beforeRows,
    afterRows,
  );
  ws.regionalActivities = records;
  return afterRows.length;
}

function save(ws, input, actor) {
  return (
    saveMany(
      ws,
      { month: input?.month, date: input?.date, rows: [input] },
      actor,
    ) > 0
  );
}

function remove(ws, input, actor) {
  const M = model(),
    { month, date } = recordPeriod(input),
    memberId = M.id(input?.memberId),
    records = ws.regionalActivities || [],
    before = records.find(
      (r) => (r.date || r.month) === (date || month) && r.memberId === memberId,
    );
  if (!before) return false;
  M.audit(
    ws,
    actor,
    `${date ? "일자별" : "월별"} 활동구분 입력 취소`,
    date || month,
    before,
    null,
  );
  ws.regionalActivities = records.filter((r) => r !== before);
  return true;
}

function tally(records, roster) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 },
    ids = new Set(roster.map((m) => m.memberId));
  let rosterRecorded = 0,
    rosterActive = 0;
  for (const row of records) {
    counts[row.code]++;
    if (ids.has(row.memberId)) {
      rosterRecorded++;
      if (row.code !== 4) rosterActive++;
    }
  }
  const recorded = records.length,
    active = recorded - counts[4],
    rosterMembers = roster.length;
  return {
    rosterMembers,
    recorded,
    active,
    inactive: counts[4],
    unrecorded: rosterMembers - rosterRecorded,
    rosterRecorded,
    rosterActive,
    outsideRoster: recorded - rosterRecorded,
    counts,
    activeRate: recorded ? (active / recorded) * 100 : null,
    activeRosterRate: rosterMembers
      ? (rosterActive / rosterMembers) * 100
      : null,
    coverageRate: rosterMembers ? (rosterRecorded / rosterMembers) * 100 : null,
  };
}

function groupByRegion(rows, regionOf) {
  const groups = new Map();
  for (const row of rows) {
    const region = regionOf(row);
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(row);
  }
  return groups;
}

function keepLatest(byMember, record) {
  const saved = byMember.get(record.memberId);
  // The undated legacy row is used only if the member has no dated row this month.
  if (!saved || (record.date || "") > (saved.date || ""))
    byMember.set(record.memberId, record);
}

function activityRosterMemberIds(
  ws,
  memberIds,
  rules = parseActivityRosterRules(ws.dailyActivityRosterRules),
) {
  if (!rules.excluded.length) return memberIds;
  const org = O.get(ws);
  const eligible = new Set(memberIds);
  for (const member of org.members) {
    if (
      eligible.has(member.id) &&
      isExcludedActivityMember(
        rules,
        O.regionOf(org, member.unitId),
        member.name,
      )
    )
      eligible.delete(member.id);
  }
  return eligible;
}

function strongestRecords(ws, rosterIds, ranges, rules) {
  const windows = ranges.map((range) => ({ ...range, records: new Map() }));
  for (const record of ws.regionalActivities || []) {
    if (
      !rosterIds.has(record.memberId) ||
      isExcludedActivityMember(rules, record.region, record.name)
    )
      continue;
    for (const window of windows) {
      const included = record.date
        ? (!window.from || record.date >= window.from) &&
          (!window.to || record.date <= window.to)
        : window.includesMonth(record.month);
      if (!included) continue;
      const prior = window.records.get(record.memberId);
      if (
        !prior ||
        record.code < prior.code ||
        (record.code === prior.code && (record.date || "") > (prior.date || ""))
      )
        window.records.set(record.memberId, record);
    }
  }
  return windows.map(({ records }) => records);
}

function periodWindow({ from, to }) {
  const firstMonth = from?.slice(0, 7),
    lastMonth = to?.slice(0, 7),
    end = to ? new Date(`${to}T00:00:00Z`) : null;
  if (end) end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const fullFirstMonth = from?.endsWith("-01"),
    fullLastMonth = end && to === end.toISOString().slice(0, 10);
  const includesMonth = (month) =>
    (!from || month > firstMonth || (month === firstMonth && fullFirstMonth)) &&
    (!to || month < lastMonth || (month === lastMonth && fullLastMonth));
  return { from, to, includesMonth };
}

function periodStatuses(ws, range, rosterIds) {
  const rules = parseActivityRosterRules(ws.dailyActivityRosterRules);
  const eligible = activityRosterMemberIds(ws, rosterIds, rules);
  const [records] = strongestRecords(ws, eligible, [periodWindow(range)], rules);
  return new Map(
    [...records].map(([memberId, record]) => [memberId, record.code]),
  );
}

function comparePeriods(ws, current, previous, roster, monthly) {
  const rules = parseActivityRosterRules(ws.dailyActivityRosterRules);
  const rosterIds = activityRosterMemberIds(
    ws,
    new Set(roster.map((member) => member.memberId)),
    rules,
  );
  const windows = [current, previous].map((range) => {
    const windowMonth = monthly ? range.from.slice(0, 7) : null;
    return { ...range, includesMonth: (month) => month === windowMonth };
  });
  const rosterMembers = rosterIds.size;
  const summaries = strongestRecords(ws, rosterIds, windows, rules);
  const [now, before] = summaries.map((records) => {
    const active = [...records.values()].filter((record) => record.code < 4)
      .length;
    return {
      rosterMembers,
      recorded: records.size,
      active,
      inactive: rosterMembers - active,
      rosterActive: active,
      activeRosterRate: rosterMembers ? (active / rosterMembers) * 100 : null,
    };
  });
  return { current: now, previous: before };
}

function knownMembers(org, rules, excludedIds = new Set()) {
  const units = new Map(),
    known = new Map();
  for (const member of org.members) {
    if (!units.has(member.unitId)) {
      units.set(member.unitId, {
        region: O.regionOf(org, member.unitId) || UNASSIGNED,
        active: O.ancestors(org, member.unitId).every((node) => node.active),
      });
    }
    const unit = units.get(member.unitId);
    if (isExcludedActivityMember(rules, unit.region, member.name)) {
      excludedIds.add(member.id);
      continue;
    }
    known.set(member.id, {
      memberId: member.id,
      name: activityReportName(rules, unit.region, member.name),
      memberCode: member.code,
      currentRosterRegion: unit.region,
      inRoster: member.status === "active" && unit.active,
      editable: true,
    });
  }
  return known;
}

function districtNames(org, names) {
  const regions = new Set(names);
  for (const unit of org.nodes) {
    if (unit.active && (unit.reportRegion || /구역/.test(unit.type)))
      regions.add(O.regionOf(org, unit.id) || UNASSIGNED);
  }
  return [...regions].sort(byName);
}

function periodRows(records, members) {
  return [...records.values()]
    .map(({ memberId, code, date }) => {
      const { name, memberCode, currentRosterRegion } = members.get(memberId);
      return {
        memberId,
        name,
        memberCode,
        region: currentRosterRegion,
        code,
        date: date ?? null,
      };
    })
    .sort(sortMembers);
}

function regionLines(rows) {
  const groups = groupByRegion(rows, (row) => row.region);
  return [...groups.keys()]
    .sort(byName)
    .map((region) => {
      const names = groups.get(region).map((row) => row.name);
      return `-${region}: ${names.join(" ")}`;
    });
}

function shortDate(date) {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function boundedReportWeek({ from, to }) {
  const firstDate = "0001-01-01";
  return {
    from: from < firstDate && to >= firstDate ? firstDate : from,
    to: to.startsWith("+") ? "9999-12-31" : to,
  };
}

function periodReport(
  current,
  previous,
  currentRecords,
  previousRecords,
  roster,
  monthly,
) {
  const rows = periodRows(currentRecords, roster),
    counts = tally(rows, [...roster.values()]),
    previousLabel = monthly ? "전월" : "전주",
    currentLabel = monthly ? "이번 달" : "이번 주";
  const periodTitle = monthly
    ? `${current.from.slice(0, 4)}년 ${Number(current.from.slice(5, 7))}월`
    : current.from.slice(0, 4) === current.to.slice(0, 4)
      ? `${shortDate(current.from)}-${shortDate(current.to)}`
      : `${current.from} ~ ${current.to}`;
  const sections = [`[${periodTitle} 활동자]`];
  for (const code of [1, 2, 3, 4]) {
    sections.push(
      [
        `(${code}) ${LABELS[code]}: ${counts.counts[code]}명`,
        ...regionLines(rows.filter((row) => row.code === code)),
      ].join("\n"),
    );
  }
  if (!currentRecords.size || !previousRecords.size) {
    const missingPeriod = currentRecords.size ? previousLabel : currentLabel;
    sections.push(
      `${missingPeriod} 기록이 없어 ${previousLabel} 대비 전환을 집계할 수 없습니다.`,
    );
  } else {
    const deactivated = [],
      activated = [];
    for (const row of rows) {
      const before = previousRecords.get(row.memberId)?.code;
      if (before === undefined) continue;
      if (before === 4 && row.code < 4) activated.push(row);
      if (before < 4 && row.code === 4) deactivated.push(row);
    }
    sections.push(
      [
        `●활동자 → 비활동자 (${deactivated.length}명)`,
        ...regionLines(deactivated),
      ].join("\n"),
      [
        `●비활동자 → 활동자 (${activated.length}명)`,
        ...regionLines(activated),
      ].join("\n"),
    );
    const previousActive = [...previousRecords.values()].filter(
      (record) => record.code < 4,
    ).length;
    const delta = counts.active - previousActive;
    const change = delta
      ? `${Math.abs(delta)}명 ${delta > 0 ? "증가" : "감소"}하였습니다.`
      : "변동이 없습니다.";
    const lines = [
      `${previousLabel} 대비 활동자는 ${change} (${previousActive}명 → ${counts.active}명)`,
    ];
    if (delta !== activated.length - deactivated.length)
      lines.push("전환은 두 기간에 모두 기록이 있는 사람을 기준으로 집계했습니다.");
    sections.push(lines.join("\n"));
  }
  if (counts.unrecorded)
    sections.push(
      `${currentLabel} 미기록 ${counts.unrecorded}명은 활동 상태 집계에서 제외했습니다.`,
    );
  return {
    ...current,
    previousFrom: previous.from,
    previousTo: previous.to,
    text: sections.join("\n\n"),
  };
}

function periodSummary(ws, input) {
  const M = model(),
    from = dateValue(input.from),
    to = dateValue(input.to),
    region = M.text(input.region ?? "", 60),
    code = input.code == null ? null : codeValue(input.code);
  M.assert(from <= to, "조회 시작일은 종료일보다 늦을 수 없습니다.");
  const { calendarRange } = require("./regional-analytics.cjs");
  const weekStart =
    Number.isInteger(input.weekStart) && input.weekStart >= 0 && input.weekStart <= 6
      ? input.weekStart
      : 0;
  const weekly = boundedReportWeek(calendarRange(to, "week", weekStart));
  const previousWeek = boundedReportWeek(calendarRange(to, "week", weekStart, -1));
  const monthly = calendarRange(to, "month");
  const previousMonth = calendarRange(to, "month", weekStart, -1);
  const org = O.get(ws),
    rules = parseActivityRosterRules(ws.dailyActivityRosterRules),
    members = [...knownMembers(org, rules).values()].filter(
      (member) => member.inRoster,
    ),
    districts = districtNames(
      org,
      members.map((member) => member.currentRosterRegion),
    ),
    roster = new Map(
      members
        .filter((member) => !region || member.currentRosterRegion === region)
        .map((member) => [member.memberId, member]),
    );
  const [
    records,
    weekRecords,
    previousWeekRecords,
    monthRecords,
    previousMonthRecords,
  ] = strongestRecords(
    ws,
    new Set(roster.keys()),
    [
      periodWindow({ from, to }),
      { ...weekly, includesMonth: () => false },
      { ...previousWeek, includesMonth: () => false },
      periodWindow(monthly),
      periodWindow(previousMonth),
    ],
    rules,
  );
  const rows = periodRows(records, roster);
  return {
    from,
    to,
    region,
    code,
    labels: LABELS,
    districts: districts.map((name) => ({ region: name })),
    period: tally(rows, [...roster.values()]),
    records: code === null ? rows : rows.filter((row) => row.code === code),
    weekly: periodReport(
      weekly,
      previousWeek,
      weekRecords,
      previousWeekRecords,
      roster,
      false,
    ),
    monthly: periodReport(
      monthly,
      previousMonth,
      monthRecords,
      previousMonthRecords,
      roster,
      true,
    ),
  };
}

function summary(ws, input = {}) {
  if (input.from !== undefined || input.to !== undefined)
    return periodSummary(ws, input);
  const M = model(),
    { month, date } = recordPeriod(input),
    includeHistory = input.includeHistory !== false,
    previousMonth = previousOf(month),
    region = M.text(input.region ?? "", 60),
    org = O.get(ws),
    rules = parseActivityRosterRules(ws.dailyActivityRosterRules),
    excludedIds = new Set(),
    known = knownMembers(org, rules, excludedIds);
  const roster = [...known.values()].filter((m) => m.inRoster),
    currentMap = new Map(),
    previousMap = new Map(),
    dayMap = new Map(),
    undatedMap = new Map(),
    monthHistory = [];
  for (const record of ws.regionalActivities || []) {
    if (
      excludedIds.has(record.memberId) ||
      isExcludedActivityMember(rules, record.region, record.name)
    )
      continue;
    if (record.month === month) {
      keepLatest(currentMap, record);
      if (includeHistory) monthHistory.push(record);
      if (!record.date) undatedMap.set(record.memberId, record);
      else if (record.date === date) dayMap.set(record.memberId, record);
    } else if (record.month === previousMonth) keepLatest(previousMap, record);
  }
  const nameOf = (memberId) => {
    if (known.has(memberId)) return known.get(memberId);
    const current = currentMap.get(memberId),
      previous = previousMap.get(memberId);
    return {
      memberId,
      name: activityReportName(
        rules,
        current?.region ?? previous?.region,
        current?.name ?? previous?.name ?? "명부에 없는 구성원",
      ),
      memberCode: current?.memberCode ?? previous?.memberCode ?? memberId,
      currentRosterRegion: "",
      inRoster: false,
      editable: false,
    };
  };
  const rowRegion = (record) => record.region || UNASSIGNED,
    currentRows = [...currentMap.values()],
    previousRows = [...previousMap.values()],
    currentGroups = groupByRegion(currentRows, rowRegion),
    previousGroups = groupByRegion(previousRows, rowRegion),
    dayRows = [...dayMap.values()],
    dayGroups = groupByRegion(dayRows, rowRegion),
    rosterGroups = groupByRegion(roster, (m) => m.currentRosterRegion),
    selectedCurrent = region ? currentGroups.get(region) || [] : currentRows,
    selectedPrevious = region ? previousGroups.get(region) || [] : previousRows,
    selectedDay = region ? dayGroups.get(region) || [] : dayRows,
    selectedRoster = region ? rosterGroups.get(region) || [] : roster,
    regionNames = districtNames(org, [
      ...currentGroups.keys(),
      ...previousGroups.keys(),
      ...dayGroups.keys(),
      ...rosterGroups.keys(),
      ...monthHistory.map(rowRegion),
    ]);
  const districts = regionNames.map((name) => {
    const local = rosterGroups.get(name) || [];
    return {
      region: name,
      current: tally(currentGroups.get(name) || [], local),
      previous: tally(previousGroups.get(name) || [], local),
      day: date ? tally(dayGroups.get(name) || [], local) : null,
    };
  });
  const changes = [],
    transfers = [],
    entered = [],
    missing = [],
    members = [];
  const selected = (name) => !region || region === name;
  const ids = new Set([
    ...known.keys(),
    ...currentMap.keys(),
    ...previousMap.keys(),
  ]);
  for (const memberId of ids) {
    const cur = currentMap.get(memberId),
      prev = previousMap.get(memberId),
      dayRecord = dayMap.get(memberId),
      undated = undatedMap.get(memberId),
      member = nameOf(memberId),
      from = prev?.code ?? null,
      to = cur?.code ?? null,
      fromRegion = prev ? rowRegion(prev) : "",
      toRegion = cur ? rowRegion(cur) : "";
    if (
      selected(member.currentRosterRegion) ||
      (cur && selected(toRegion)) ||
      (prev && selected(fromRegion)) ||
      (dayRecord && selected(rowRegion(dayRecord)))
    ) {
      members.push({
        ...member,
        region: toRegion || member.currentRosterRegion || fromRegion,
        currentCode: to,
        previousCode: from,
        currentDate: cur?.date ?? null,
        previousDate: prev?.date ?? null,
        currentRegion: toRegion,
        previousRegion: fromRegion,
        dayCode: dayRecord?.code ?? null,
        dayRegion: dayRecord ? rowRegion(dayRecord) : "",
        undatedCode: undated?.code ?? null,
        undatedRegion: undated ? rowRegion(undated) : "",
      });
    }
    if (!cur && !prev) continue;
    const transition = {
      memberId,
      name: member.name,
      memberCode: member.memberCode,
      from,
      to,
      fromRegion,
      toRegion,
      fromDate: prev?.date ?? null,
      toDate: cur?.date ?? null,
    };
    if (!prev) {
      if (selected(toRegion))
        entered.push({ ...transition, direction: "entered" });
      continue;
    }
    if (!cur) {
      if (selected(fromRegion))
        missing.push({ ...transition, direction: "missing" });
      continue;
    }
    const direction =
      from === to
        ? "unchanged"
        : from === 4
          ? "activated"
          : to === 4
            ? "deactivated"
            : "changed";
    if (direction !== "unchanged" && selected(toRegion))
      changes.push({ ...transition, direction });
    if (fromRegion !== toRegion && (selected(fromRegion) || selected(toRegion)))
      transfers.push({ ...transition, direction });
  }
  for (const list of [changes, transfers, entered, missing, members])
    list.sort(sortMembers);
  const displayRecord = (record) => {
    const member = nameOf(record.memberId);
    return {
      ...record,
      date: record.date ?? null,
      region: rowRegion(record),
      name: activityReportName(
        rules,
        record.region || member.currentRosterRegion,
        record.name ?? member.name,
      ),
      memberCode: record.memberCode ?? member.memberCode,
      editable: member.editable,
    };
  };
  const records = selectedCurrent.map(displayRecord).sort(sortMembers),
    dailyRecords = [],
    undatedRecords = [];
  for (const record of monthHistory) {
    if (!selected(rowRegion(record))) continue;
    const rows = record.date ? dailyRecords : undatedRecords;
    rows.push(displayRecord(record));
  }
  dailyRecords.sort(
    (a, b) => b.date.localeCompare(a.date) || sortMembers(a, b),
  );
  undatedRecords.sort(sortMembers);
  return {
    month,
    date,
    previousMonth,
    region,
    labels: LABELS,
    current: tally(selectedCurrent, selectedRoster),
    previous: tally(selectedPrevious, selectedRoster),
    day: date ? tally(selectedDay, selectedRoster) : null,
    districts,
    changes,
    transfers,
    entered,
    missing,
    records,
    dailyRecords,
    undatedRecords,
    members,
    notes: [
      "활동 인원은 1~3, 비활동 인원은 4로 기록된 구성원입니다. 월별 활동 비율은 활동 인원 ÷ 해당 월 입력 인원입니다.",
      "현재 명부 대비 활동 비율과 입력률은 현재 활동 상태 명부에 해당 구역 기록이 연결된 인원을 사용합니다. 다른 구역에 저장됐거나 현재 명부에 없는 기록은 따로 표시합니다.",
      "월별 현황은 구성원마다 해당 월의 마지막 기록일 상태를 집계합니다. 날짜 있는 기록이 없으면 기존 월별 기록을 사용합니다.",
      "일자별 현황은 선택한 날의 기록만 집계합니다. 각 기록의 구역은 처음 저장한 당시의 소속이며, 전월과 이번 달에 모두 상태가 있는 경우만 월별 활동구분 변경으로 집계합니다.",
      "4에서 1~3으로 변경된 경우는 활동 전환, 1~3에서 4로 변경된 경우는 비활동 전환입니다. 미입력은 비활동 인원에 포함되지 않습니다.",
    ],
  };
}

module.exports = {
  LABELS,
  validate,
  save,
  saveMany,
  remove,
  summary,
  comparePeriods,
  periodStatuses,
  activityRosterMemberIds,
};
