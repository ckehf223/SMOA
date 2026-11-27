"use strict";
const M = require("./model.cjs");
const W = require("./activity-window.cjs");
const C = require("./classification-scope.cjs");
const O = require("./organization.cjs");
const K = require("./codes.cjs");
const { leaderVenueScores } = require("./leader-venue-scores.cjs");
const UNLINKED = "__unlinked__";
const DAY = 86400000;
const HOUR = 3600000;
const stamp = (date, time = "00:00") => Date.parse(`${date}T${time}:00Z`);
const dateAt = (n) => new Date(n).toISOString().slice(0, 10);
const hourLabel = (hour) => `${String(hour).padStart(2, "0")}시`;
const marked = (notes = "") =>
  /(?:^|[\s()[\]{}·,;:：/])주관자(?=$|[\s()[\]{}·,;:：/])/.test(notes) &&
  !/(?:비주관자|주관자\s*(?:아님|없음|아니))/u.test(notes);
function findings(ws) {
  // Current person edits take precedence; repeated daily snapshots never add a person twice.
  const rows = new Map(
    ws.people.map((p) => [
      p.code,
      {
        code: p.code,
        name: p.name,
        date: p.dateUnknown ? "" : p.date,
        time: p.time || "",
        region: p.region || "",
        workerId: p.introducerId || p.introducerSnapshot?.code || "",
        worker: p.introducerSnapshot?.name || p.worker || "",
        classification2: C.person(p),
      },
    ]),
  );
  const known = new Set(rows.keys());
  for (const r of [...(ws.findingReports || [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    if (
      known.has(r.personCode) ||
      rows.has(r.personCode) ||
      !r.foundDate ||
      r.dateUnknown
    )
      continue;
    rows.set(r.personCode, {
      code: r.personCode,
      name: r.name,
      date: r.foundDate,
      time: r.time || "",
      region: r.region || "",
      workerId: r.memberCode || r.memberId || "",
      worker: r.worker || "",
      classification2: r.classification2 ?? "노방",
    });
  }
  return [...rows.values()];
}
function mergeSpans(spans) {
  const merged = [];
  for (const s of spans.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}
function splitHourSpans({ start, end }, visit) {
  for (let at = start; at < end;) {
    const next = Math.min(end, (Math.floor(at / HOUR) + 1) * HOUR);
    visit(new Date(at).getUTCHours(), (next - at) / 60000, at);
    at = next;
  }
}
function activityHours(activities, rows, { from, to, region }) {
  const low = from ? stamp(from) : -Infinity,
    high = to ? stamp(to) + DAY : Infinity,
    workers = new Map(),
    coverage = new Map(),
    bins = Array.from({ length: 24 }, (_, h) => ({
      label: hourLabel(h),
      people: new Set(),
      days: new Set(),
      minutes: 0,
      findings: 0,
      matchedFindings: 0,
    }));
  let unknownTime = 0,
    unknownWorker = 0;
  for (const a of activities) {
    if (region && a.region !== region) continue;
    const duration = M.minutes(a.start, a.end),
      timed = a.start && a.end && duration > 0,
      begin = timed ? stamp(a.date, a.start) : null,
      finish = timed ? begin + duration * 60000 : null;
    if (
      timed
        ? finish < low || begin >= high
        : (from && a.date < from) || (to && a.date > to)
    )
      continue;
    if (!timed) {
      unknownTime++;
      continue;
    }
    if (!a.workerId && !a.worker?.trim()) {
      unknownWorker++;
      continue;
    }
    const id = a.workerId || JSON.stringify([a.region || "", a.worker.trim()]),
      span = { start: Math.max(begin, low), end: Math.min(finish, high) };
    if (!workers.has(id)) workers.set(id, []);
    workers.get(id).push(span);
    if (a.region) {
      if (!coverage.has(a.region)) coverage.set(a.region, []);
      coverage.get(a.region).push(span);
    }
  }
  for (const [id, spans] of workers)
    for (const span of mergeSpans(spans))
      splitHourSpans(span, (hour, minutes, at) => {
        const b = bins[hour];
        b.people.add(id);
        b.days.add(JSON.stringify([id, dateAt(at)]));
        b.minutes += minutes;
      });
  for (const [key, spans] of coverage) coverage.set(key, mergeSpans(spans));
  let matched = 0;
  for (const r of rows) {
    if (!r.time) continue;
    const b = bins[Number(r.time.slice(0, 2))],
      at = stamp(r.date, r.time);
    b.findings++;
    const spans = coverage.get(r.region) || [];
    if (W.matches(spans, at)) {
      b.matchedFindings++;
      matched++;
    }
  }
  return {
    hours: bins.map((b) => ({
      label: b.label,
      workers: b.people.size,
      workerDays: b.days.size,
      minutes: b.minutes,
      findings: b.findings,
      matchedFindings: b.matchedFindings,
      unmatchedFindings: b.findings - b.matchedFindings,
      perPersonHour:
        b.minutes > 0 ? b.matchedFindings / (b.minutes / 60) : null,
    })),
    unknownTime,
    unknownWorker,
    matched,
    totalMinutes: bins.reduce((n, b) => n + b.minutes, 0),
  };
}

function leaderEmployment(ws, value) {
  const item = K.find(ws, "employment", value);
  return !value || (item?.label || value) === "미입력"
    ? C.UNCLASSIFIED
    : item?.value || value;
}

function leaderEmploymentLabel(ws, value) {
  if (!value) return "전체 직업구분";
  if (value === C.UNCLASSIFIED) return "미입력";
  if (value === UNLINKED) return "명부 미연결";
  return K.label(ws, "employment", value);
}

function leaderIdentityResolver(ws) {
  const org = O.get(ws),
    byId = new Map(),
    byNameRegion = new Map();
  const add = (index, key, value) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(value);
  };
  const nameRegion = (name, region) =>
    JSON.stringify([name.trim().normalize("NFC"), region || ""]);
  for (const member of org.members) {
    for (const id of new Set([member.id, member.code])) add(byId, id, member);
    add(
      byNameRegion,
      nameRegion(member.name, O.regionOf(org, member.unitId)),
      member,
    );
  }
  return (activity, requireIdentity = false) => {
    const matches = activity.workerId
      ? byId.get(activity.workerId)
      : byNameRegion.get(nameRegion(activity.worker || "", activity.region));
    const member = matches?.length === 1 ? matches[0] : null;
    if (requireIdentity && (matches?.length > 1 || (!activity.workerId && !activity.worker))) return null;
    if (member)
      return {
        identity: `member:${member.id}`,
        name: member.name,
        workerId: member.code,
        employment: leaderEmployment(ws, member.employment),
      };
    return {
      identity: activity.workerId
        ? `external:${activity.workerId}`
        : `name:${nameRegion(activity.worker || "", activity.region)}`,
      name: activity.worker || "이름 미입력",
      workerId: activity.workerId || "",
      employment: UNLINKED,
    };
  };
}

function groupLeaders(ws, rows, employment, spansByDistrictLeader) {
  const groups = new Map();
  for (const row of rows) {
    if (employment && row.employment !== employment) continue;
    let leader = groups.get(row.identity);
    if (!leader) {
      leader = {
        id: row.identity,
        name: row.name,
        workerId: row.workerId,
        employment: row.employment,
        employmentLabel: leaderEmploymentLabel(ws, row.employment),
        regions: [],
        records: 0,
        unknown: 0,
        spans: [],
        count: 0,
        sessionCount: 0,
        sessionUncertain: 0,
        hours: Array(24).fill(0),
      };
      groups.set(row.identity, leader);
    }
    if (!leader.regions.includes(row.region)) leader.regions.push(row.region);
    for (const field of [
      "records",
      "unknown",
      "count",
      "sessionCount",
      "sessionUncertain",
    ])
      leader[field] += row[field];
    row.hours.forEach((count, hour) => {
      leader.hours[hour] += count;
    });
    for (const span of spansByDistrictLeader.get(row.id) || [])
      leader.spans.push(span);
  }
  return [...groups.values()].map(({ spans, ...leader }) => {
    // Union a leader's time across districts without changing district attribution.
    const leadHours = Array(24).fill(0);
    for (const span of mergeSpans(spans))
      splitHourSpans(span, (hour, minutes) => { leadHours[hour] += minutes; });
    const minutes = leadHours.reduce((sum, value) => sum + value, 0);
    const max = Math.max(...leadHours);
    const peakLeadHours = leadHours.flatMap((value, hour) =>
      value > 0 && value === max ? [{ label: hourLabel(hour), minutes: value }] : [],
    );
    const perHour = minutes ? leader.count / (minutes / 60) : null;
    return {
      ...leader,
      region: leader.regions.map((region) => region || "구역 미입력").join(", "),
      minutes,
      leadHours,
      peakLeadHours,
      perHour,
      efficiency: perHour,
    };
  });
}

function topLeaderSessions(leaders) {
  const byCount = new Map();
  for (const leader of leaders) {
    if (!leader.sessionCount) continue;
    if (!byCount.has(leader.sessionCount)) byCount.set(leader.sessionCount, []);
    byCount.get(leader.sessionCount).push(leader);
  }
  return [...byCount].sort(([a], [b]) => b - a).slice(0, 3)
    .map(([count, tied], index) => ({ rank: index + 1, count, leaders: tied }));
}

function summary(ws, input = {}) {
  const overview = input.leaderOverview === true,
    classification2 = overview ? "노방" : C.filter(input.classification2),
    activityAvailable = overview || C.activityAvailable(input),
    requestedEmployment = overview
      ? M.text(input.statsLeaderEmployment || "", 100)
      : "",
    employment = requestedEmployment
      ? leaderEmployment(ws, requestedEmployment)
      : "",
    resolveLeader = overview ? leaderIdentityResolver(ws) : null;
  const from = M.date(input.from || "", false),
    to = M.date(input.to || "", false),
    region = M.text(input.region || "", 60);
  M.assert(!from || !to || from <= to, "조회 기간을 확인하세요.");
  const inDate = (d) => d && (!from || d >= from) && (!to || d <= to),
    inRegion = (r) => !region || r === region,
    low = from ? stamp(from) : -Infinity,
    high = to ? stamp(to) + DAY : Infinity;
  const rows = findings(ws).filter(
    (r) =>
      inDate(r.date) &&
      inRegion(r.region) &&
      C.matches(r.classification2, classification2),
  );
  const daily = new Map(),
    hours = Array.from({ length: 24 }, (_, i) => ({
      label: hourLabel(i),
      value: 0,
    }));
  const day = (d) => {
    if (!daily.has(d))
      daily.set(d, { date: d, total: 0, unknown: 0, hours: Array(24).fill(0) });
    return daily.get(d);
  };
  const start = from || rows.map((r) => r.date).sort()[0],
    end =
      to ||
      rows
        .map((r) => r.date)
        .sort()
        .at(-1);
  // Long unbounded ranges remain sparse; a selected period up to ten years includes zero days.
  const completeDates = Boolean(
    start && end && stamp(end) - stamp(start) <= 3660 * DAY,
  );
  if (completeDates)
    for (let d = stamp(start); d <= stamp(end); d += DAY) day(dateAt(d));
  for (const r of rows) {
    const d = day(r.date);
    d.total++;
    if (r.time) {
      const h = Number(r.time.slice(0, 2));
      d.hours[h]++;
      hours[h].value++;
    } else d.unknown++;
  }
  const activities = activityAvailable
    ? C.activities(ws).filter((a) => C.activity(a) === "노방")
    : [];
  const leaders = new Map(),
    groups = new Map();
  for (const a of activities) {
    if (!marked(a.notes) || !inRegion(a.region)) continue;
    const timed = Boolean(a.start && a.end && M.minutes(a.start, a.end) > 0),
      begin = timed ? stamp(a.date, a.start) : null,
      finish = timed ? begin + M.minutes(a.start, a.end) * 60000 : null;
    if (timed ? finish < low || begin >= high : !inDate(a.date)) continue;
    const identity = resolveLeader?.(a),
      key = JSON.stringify([
        a.region || "",
        identity?.identity || a.workerId || a.worker || "이름 미입력",
      ]);
    if (!leaders.has(key))
      leaders.set(key, {
        id: key,
        name: a.worker || "이름 미입력",
        workerId: a.workerId || "",
        region: a.region || "",
        records: 0,
        unknown: 0,
        minutes: 0,
        count: 0,
        sessionCount: 0,
        ...(identity
          ? { ...identity, hours: Array(24).fill(0), sessionUncertain: 0 }
          : {}),
      });
    const leader = leaders.get(key);
    leader.records++;
    if (!timed) {
      leader.unknown++;
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      leaderId: key,
      region: a.region || "",
      start: Math.max(begin, low),
      end: Math.min(finish, high),
    });
  }
  const sessions = [];
  for (const [key, spans] of groups) {
    const merged = mergeSpans(spans);
    const leader = leaders.get(key);
    leader.sessionCount = overview
      ? merged.filter((s) => s.end > s.start).length
      : merged.length;
    leader.minutes = merged.reduce((n, s) => n + (s.end - s.start) / 60000, 0);
    sessions.push(...merged.map((s) => ({ ...s, count: 0 })));
  }
  // Index midnight-spanning sessions by actual calendar date as well as district.
  const byDate = new Map();
  for (const s of sessions)
    for (let d = stamp(dateAt(s.start)); d <= s.end; d += DAY) {
      const key = JSON.stringify([dateAt(d), s.region]);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(s);
    }
  const unassigned = {
    unknownTime: 0,
    unknownRegion: 0,
    noSession: 0,
    ambiguous: 0,
  };
  let matched = 0,
    sessionUncertain = 0;
  for (const r of rows) {
    if (r.classification2 !== "노방") {
      if (!r.time) unassigned.unknownTime++;
      else unassigned.noSession++;
      continue;
    }
    if (!r.time) {
      unassigned.unknownTime++;
      continue;
    }
    if (!r.region) {
      unassigned.unknownRegion++;
      continue;
    }
    const at = stamp(r.date, r.time),
      candidates = (
        byDate.get(JSON.stringify([r.date, r.region])) || []
      ).filter((s) => W.contains(s, at)),
      ids = [...new Set(candidates.map((s) => s.leaderId))];
    if (ids.length === 1) {
      matched++;
      const leader = leaders.get(ids[0]);
      leader.count++;
      if (overview) leader.hours[Number(r.time.slice(0, 2))]++;
      // Whole-hour reporting can overlap separate sessions of the same leader.
      // Credit the leader once; do not guess which separate session produced it.
      if (candidates.length === 1) candidates[0].count++;
      else {
        sessionUncertain++;
        if (overview) leader.sessionUncertain++;
      }
    } else unassigned[ids.length ? "ambiguous" : "noSession"]++;
  }
  const leaderRows = (
    overview
      ? groupLeaders(ws, leaders.values(), employment, groups)
      : [...leaders.values()].map((l) => ({
          ...l,
          perHour: l.minutes ? l.count / (l.minutes / 60) : null,
        }))
  ).sort(
    (a, b) =>
      b.count - a.count ||
      a.name.localeCompare(b.name, "ko") ||
      a.region.localeCompare(b.region, "ko"),
  );
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  let leaderOverview;
  if (overview) {
    const assigned = leaderRows.reduce(
        (total, leader) => total + leader.count,
        0,
      ),
      employments = new Set(
        K.options(ws, "employment").map(([value]) =>
          leaderEmployment(ws, value),
        ),
      );
    for (const leader of leaders.values()) employments.add(leader.employment);
    if (employment) employments.add(employment);
    leaderOverview = {
      employment,
      employmentLabel: leaderEmploymentLabel(ws, employment),
      assigned,
      assignedGlobal: matched,
      outsideEmployment: matched - assigned,
      sessionUncertainGlobal: sessionUncertain,
      topBySessions: topLeaderSessions(leaderRows),
      venueScores: leaderVenueScores(ws, { activities, findings: rows, marked, resolveLeader, low, high, region, employment }),
      hours: hours.map(({ label }, hour) => ({
        label,
        value: leaderRows.reduce(
          (total, leader) => total + leader.hours[hour],
          0,
        ),
      })),
      employments: [...employments]
        .map((value) => ({ value, label: leaderEmploymentLabel(ws, value) }))
        .sort((a, b) => a.label.localeCompare(b.label, "ko")),
    };
    matched = assigned;
    sessionUncertain = leaderRows.reduce(
      (total, leader) => total + leader.sessionUncertain,
      0,
    );
  }
  return {
    from,
    to,
    region,
    classification2,
    activityAvailable,
    ...(overview ? { leaderOverview } : {}),
    total: rows.length,
    timed: rows.filter((r) => r.time).length,
    unknownTime: unassigned.unknownTime,
    matched,
    unassigned,
    sessionUncertain,
    days,
    hours,
    ...(!overview
      ? {
          activityComparison: activityHours(
            activities,
            rows.filter((r) => r.classification2 === "노방"),
            { from, to, region },
          ),
        }
      : {}),
    leaders: leaderRows,
    leaderCount: new Set(
      leaderRows.map((l) => l.workerId || JSON.stringify([l.region, l.name])),
    ).size,
    completeDates,
    sessions: sessions
      .filter(
        (s) =>
          !overview ||
          !employment ||
          leaders.get(s.leaderId).employment === employment,
      )
      .sort((a, b) => a.start - b.start)
      .map((s) => ({
        name: leaders.get(s.leaderId).name,
        ...(overview
          ? {
              leaderId: leaders.get(s.leaderId).identity,
              employmentLabel: leaderEmploymentLabel(
                ws,
                leaders.get(s.leaderId).employment,
              ),
            }
          : {}),
        region: s.region,
        start: new Date(s.start).toISOString().slice(0, 16),
        end: new Date(s.end).toISOString().slice(0, 16),
        minutes: (s.end - s.start) / 60000,
        count: s.count,
      })),
  };
}
async function workbook(result) {
  if (result.leaderOverview) return leaderOverviewWorkbook(result);
  const ExcelJS = require("exceljs"),
    wb = new ExcelJS.Workbook();
  wb.creator = "SMOA";
  const notes = wb.addWorksheet("집계 기준");
  notes.addRows([
    ["SMOA 찾기·주관자 통계"],
    [
      `${result.from || "전체"} ~ ${result.to || "전체"} / ${result.region || "전체 구역"}`,
    ],
    [
      `분류2: ${C.label(result.classification2)} · 활동시간·효율은 노방에서만 표시`,
    ],
    [
      "대상자 관리의 찾은 날짜·시간 우선, 대상자당 1건. 대상자가 없는 일보는 최초 기록만 포함.",
    ],
    [
      "메모에 주관자로 표시한 활동자를 사용. 같은 구역·활동 시간(00분 보고는 시작·종료 시 시간대 포함, 분 단위 입력은 실제 시각)에 찾은 건을 연결.",
    ],
    [
      "동일 주관자의 겹치는 시간은 합침. 서로 다른 주관자 시간이 겹치는 찾기 건은 중복 주관 확인 필요로 제외.",
    ],
    [
      "같은 시간에 발생한 찾기 기록과의 연결 통계이며 주관자의 직접 성과나 인과관계를 뜻하지 않음.",
    ],
    ["찾기 합계", result.total],
    ["주관 연결", result.matched],
    ["동일 주관자 내 구간 구분 불가", result.sessionUncertain],
    ["찾기 시간 미입력", result.unassigned.unknownTime],
    ["구역 미입력", result.unassigned.unknownRegion],
    ["일치 주관 없음", result.unassigned.noSession],
    ["중복 주관 확인 필요", result.unassigned.ambiguous],
  ]);
  const d = wb.addWorksheet("일자별");
  d.addRow(["날짜", "찾기 건수", "시간 미입력"]);
  result.days.forEach((r) => d.addRow([r.date, r.total, r.unknown]));
  const h = wb.addWorksheet("시간대별");
  h.addRow(["시간대", "찾기 건수"]);
  result.hours.forEach((r) => h.addRow([r.label, r.value]));
  h.addRow(["시간 미입력", result.unknownTime]);
  const comparison = wb.addWorksheet("시간대 활동·찾기");
  comparison.addRow([
    "시간대",
    "활동자 수(명)",
    "일별 활동자 합계(명)",
    "누적 활동시간(인시간)",
    "찾기 건수",
    "활동시간 내 찾기",
    "활동 미연결 찾기",
    "1인 1시간당 찾기(건)",
  ]);
  result.activityComparison.hours.forEach((r) =>
    comparison.addRow([
      r.label,
      r.workers,
      r.workerDays,
      r.minutes / 60,
      r.findings,
      r.matchedFindings,
      r.unmatchedFindings,
      r.perPersonHour,
    ]),
  );
  comparison.getColumn(4).numFmt = "0.00";
  comparison.getColumn(8).numFmt = "0.00";
  notes.addRows([
    [
      "활동자 수는 시간대별 고유 활동자. 같은 사람의 겹친 구간은 합쳐 활동 인시간을 계산하며 자정을 넘으면 실제 날짜별로 나눔.",
    ],
    [
      "1인 1시간당 찾기 = 같은 구역의 기록된 활동 시간 내 찾기 / 누적 활동 인시간. 활동 기록과 연결되지 않는 찾기는 효율 계산에서 제외.",
    ],
    [
      "활동자 수와 찾기 건수는 인과관계나 전환율을 뜻하지 않으며 기록 누락과 활동시간 차이를 함께 확인해야 함.",
    ],
    ["시간 미입력 활동 기록", result.activityComparison.unknownTime],
    ["활동자 미입력 활동 기록", result.activityComparison.unknownWorker],
  ]);
  const cross = wb.addWorksheet("일자별 시간대");
  cross.addRow([
    "날짜",
    ...result.hours.map((h) => h.label),
    "시간 미입력",
    "합계",
  ]);
  result.days.forEach((r) =>
    cross.addRow([r.date, ...r.hours, r.unknown, r.total]),
  );
  const l = wb.addWorksheet("주관자별");
  l.addRow([
    "주관자",
    "활동자ID",
    "구역",
    "주관 기록",
    "유효 구간",
    "주관시간(분)",
    "시간 미입력 기록",
    "연결 찾기 건수",
    "시간당 찾기 건수",
  ]);
  result.leaders.forEach((r) =>
    l.addRow([
      r.name,
      r.workerId,
      r.region,
      r.records,
      r.sessionCount,
      r.minutes,
      r.unknown,
      r.count,
      r.perHour,
    ]),
  );
  const s = wb.addWorksheet("주관 구간");
  s.addRow([
    "주관자",
    "구역",
    "시작",
    "종료",
    "주관시간(분)",
    "연결 찾기 건수",
  ]);
  result.sessions.forEach((r) =>
    s.addRow([
      r.name,
      r.region,
      r.start.replace("T", " "),
      r.end.replace("T", " "),
      r.minutes,
      r.count,
    ]),
  );
  for (const sheet of wb.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns.forEach((c, i) => (c.width = i === 0 ? 25 : 19));
    sheet.getRow(1).font = { name: "맑은 고딕", bold: true };
  }
  notes.getColumn(1).width = 110;
  l.getColumn(9).numFmt = "0.00";
  if (result.activityAvailable === false) {
    for (const sheet of [comparison, l, s]) wb.removeWorksheet(sheet.id);
    // Keep only finding counts in the scope sheet for non-street categories.
    for (let row = notes.rowCount; row >= 1; row--) {
      const label = String(notes.getCell(row, 1).value || "");
      if (
        /주관|효율|활동|미연결|일치|중복/.test(label) &&
        !label.startsWith("분류2:")
      )
        notes.spliceRows(row, 1);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function leaderOverviewWorkbook(result) {
  const ExcelJS = require("exceljs"),
    wb = new ExcelJS.Workbook(),
    scope = result.leaderOverview;
  wb.creator = "SMOA";
  const notes = wb.addWorksheet("집계 기준");
  notes.addRows([
    ["노방 찾기·주관자 통계"],
    ["조회 기간", `${result.from || "전체"} ~ ${result.to || "전체"}`],
    ["구역", result.region || "전체 구역"],
    ["주관자 직업구분", scope.employmentLabel],
    ["전체 노방 찾기", result.total],
    ["전체 주관자 연결", scope.assignedGlobal],
    ["선택 직업구분 연결", scope.assigned],
    ["다른 직업구분 연결", scope.outsideEmployment],
    ["찾기 시간 미입력", result.unassigned.unknownTime],
    ["구역 미입력", result.unassigned.unknownRegion],
    ["일치 주관 없음", result.unassigned.noSession],
    ["서로 다른 주관자 중복", result.unassigned.ambiguous],
    ["선택 주관자 내 구간 구분 불가", result.sessionUncertain],
    [
      "직업구분은 현재 구성원 명부 기준입니다. 명부 미연결과 직업 미입력을 별도로 표시합니다.",
    ],
    [
      "같은 구역·시간의 주관 기록과 연결합니다. 00분 보고는 기록된 시를 기준으로 겹치는 활동 시간대를 찾습니다.",
    ],
    [
      "직업구분을 적용하기 전에 연결을 결정하므로 서로 다른 주관자가 겹치는 찾기는 어느 쪽에도 배정하지 않습니다.",
    ],
    [
      "시간대별 건수는 활동 시작 시각이 아닌 실제 기록된 찾기 시각의 시에 집계합니다.",
    ],
    [
      "주관 횟수는 구역별로 겹친 주관 구간을 합해 계산합니다. 순주관시간과 주로 주관한 시간대에는 같은 사람의 겹친 시간을 한 번만 반영합니다.",
    ],
    [
      "주관시간 대비 찾기 효율은 1시간당 찾기 1건을 100%로 표시합니다.",
    ],
    ["주관 장소별 성과", "주관자의 활동 장소별로 회차 참여자가 기록한 고유 찾기 1건에 1점을 부여합니다. 회당 평균에 0건 회차를 포함합니다."],
    ["회차 연결 기준", "회차ID로 참여자를 묶고 참여자 구역에서 주관자·참여자의 활동 시간이 겹치는 동안 발생한 찾기를 연결합니다. 회차ID가 없는 활동은 주관자와 참여자의 구역·활동 장소·시간이 겹쳐야 합니다. 구역 선택 시 해당 구역의 참여자 기록과 찾기를 집계합니다."],
    ["선택 직업구분 회차 연결 찾기", scope.venueScores.assigned],
    ["다른 직업구분 회차 연결 찾기", scope.venueScores.outsideEmployment],
    ["기간·구역 전체 회차 후보 중복 찾기", scope.venueScores.ambiguous],
    ["기간·구역 전체 회차 연결 근거 부족 찾기", scope.venueScores.unmatched],
    ["기간·구역 전체 주관자·장소 확인 필요 회차", scope.venueScores.unclearSessions],
    ["기간·구역 전체 시간 미입력 주관 기록", scope.venueScores.untimedLeaderRecords],
  ]);
  const leaderSheet = wb.addWorksheet("주관자별"),
    hourly = wb.addWorksheet("시간대별"),
    leaderHourly = wb.addWorksheet("주관자별 시간대"),
    sessions = wb.addWorksheet("주관 구간");
  const venueSheet = wb.addWorksheet("주관 장소별 성과");
  venueSheet.addRow(["조회 순위", "주관자", "주관 활동 장소", "주관 회차", "참여자 전체 찾기", "점수", "회당 찾기"]);
  for (const row of scope.venueScores.rows)
    venueSheet.addRow([row.rank, row.name, row.place, row.sessions, row.findings, row.score, row.perSession]);
  venueSheet.getColumn(7).numFmt = "0.00";
  leaderSheet.addRow([
    "주관자",
    "구성원ID",
    "직업구분",
    "활동 구역",
    "주관 기록 수",
    "유효 구간 수",
    "시간 미입력 구간",
    "연결 찾기 건수",
    "주로 주관한 시간대",
    "순주관시간(분)",
    "시간당 찾기(건)",
    "주관시간 대비 찾기 효율",
  ]);
  leaderHourly.addRow([
    "주관자",
    "구성원ID",
    "직업구분",
    ...scope.hours.map((h) => h.label),
    "연결 찾기 합계",
  ]);
  hourly.addRow(["찾기 시간대", "전체 노방 찾기", "선택 주관자 연결 찾기"]);
  for (const [index, hour] of scope.hours.entries())
    hourly.addRow([hour.label, result.hours[index].value, hour.value]);
  for (const leader of result.leaders) {
    const identity = [leader.name, leader.workerId, leader.employmentLabel];
    leaderSheet.addRow([
      ...identity,
      leader.region,
      leader.records,
      leader.sessionCount,
      leader.unknown,
      leader.count,
      leader.peakLeadHours.map(({ label }) => label).join(", "),
      leader.minutes,
      leader.perHour,
      leader.efficiency,
    ]);
    leaderHourly.addRow([...identity, ...leader.hours, leader.count]);
  }
  sessions.addRow([
    "주관자",
    "직업구분",
    "구역",
    "시작",
    "종료",
    "연결 찾기 건수",
  ]);
  for (const session of result.sessions)
    sessions.addRow([
      session.name,
      session.employmentLabel,
      session.region,
      session.start.replace("T", " "),
      session.end.replace("T", " "),
      session.count,
    ]);
  for (const sheet of wb.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns.forEach((column, i) => (column.width = i === 0 ? 25 : 19));
    sheet.getRow(1).font = { name: "맑은 고딕", bold: true };
  }
  notes.getColumn(1).width = 108;
  leaderSheet.getColumn(11).numFmt = "0.00";
  leaderSheet.getColumn(12).numFmt = "0.0%";
  return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports = { summary, findings, marked, workbook };
