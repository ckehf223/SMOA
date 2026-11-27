"use strict";
const M = require("./model.cjs");
const Codes = require("./codes.cjs");
const Performance = require("./performance.cjs");
const Cohorts = require("./stage-cohort.cjs");
const Socialing = require("./socialing.cjs");
const Window = require("./activity-window.cjs");

const HOUR = 3600000, DAY = 24 * HOUR;
const stamp = (date, time = "00:00") => Date.parse(date + "T" + time + ":00Z");
const dateOf = (at) => new Date(at).toISOString().slice(0, 10);
const fraction = (value, base) => base > 0 ? value / base : null;
const key = (...parts) => JSON.stringify(parts);
const add = (map, k, make) => {
  if (!map.has(k)) map.set(k, make());
  return map.get(k);
};
const counts = () => ({ started: 0, mature: 0, observing: 0, reached: 0, rate: null });
function statusOf(source, target, days, asOf) {
  const deadline = stamp(source) + days * DAY;
  if (deadline > stamp(asOf)) return "pending";
  return target && target >= source && stamp(target) <= deadline ? "reached" : "notReached";
}
function countStatus(row, status) {
  row.started++;
  if (status === "pending") row.observing++;
  else {
    row.mature++;
    if (status === "reached") row.reached++;
    row.rate = fraction(row.reached, row.mature);
  }
}
function fixedWindows(ws, scope) {
  const definitions = [
    { fromKey: "finding", toKey: "manpikDate", label: "찾B → 만픽", days: 7 },
    { fromKey: "manpikDate", toKey: "findADate", label: "만픽 → 찾A", days: 14 },
  ];
  const windows = definitions.map(({ days, label }) => ({ days, label, ...counts(), groups: new Map() }));
  const cohortStatuses = new Map();
  Cohorts.measure(ws, {
    from: scope.from, to: scope.to, includeReports: true, includeFindingToFindA: false,
    classify: (r) => scope.matches(r) && scope.inPeriod(r.date) ? undefined : null,
    onPair(row, from, to, targetDate) {
      const i = definitions.findIndex((d) => d.fromKey === from && d.toKey === to);
      if (i < 0) return;
      const item = windows[i], status = statusOf(row.date, targetDate, item.days, scope.asOf);
      const region = row.region || "", className = scope.classKey(row.className);
      countStatus(item, status);
      countStatus(add(item.groups, key(region, className), () => ({ region, className, ...counts() })), status);
      if (i === 0) cohortStatuses.set(row.code, status);
    },
  });
  for (const row of windows) row.groups = [...row.groups.values()].sort((a,b) =>
    a.region.localeCompare(b.region, "ko", {numeric:true}) || a.className.localeCompare(b.className, "ko", {numeric:true}));
  return { windows, cohortStatuses };
}
function socialWindows(ws, scope) {
  const s = Socialing.query(ws, { from: scope.from, to: scope.requestedTo });
  const groups = new Map(s.programs.map(({ id, name }) => [
    id, { programId: id, label: name, days: 14, ...counts() },
  ]));
  for (const row of s.rows) {
    // No intake date is recorded for legacy report-only or unlinked findings.
    if (!scope.inPeriod(row.date) || !scope.matches(row)) continue;
    const group = add(groups, row.programId, () => ({
      programId: row.programId, label: row.programName, days: 14, ...counts(),
    }));
    countStatus(group, statusOf(row.date, row.foundDate, 14, scope.asOf));
  }
  return [...groups.values()];
}

function aggregate() {
  return { minutes: 0, findings: 0, matched: 0, workers: new Set(), sessions: new Set(),
    matureMinutes: 0, reached7: 0 };
}
function present(row) {
  return { ...row, workers: row.workers.size, sessions: row.sessions.size,
    unmatched: row.findings - row.matched, perHour: fraction(row.matched * 60, row.minutes),
    perTenHours7: fraction(row.reached7 * 600, row.matureMinutes) };
}
function venueActivity(ws, facts, scope, statuses) {
  const cells = new Map(), details = new Map(), workers = new Map(), available = new Map();
  const quality = { missingPlace: 0, missingTime: 0, unknownFindingDate: 0, unknownActivityTime: 0,
    unknownActivityPlace: 0, unknownWorker: 0, conflictMinutes: 0 };
  const total = aggregate();
  const portions = (place, hour, date, region, className, session) => [
    total,
    add(cells, key(place, hour), () => ({ place, hour, ...aggregate() })),
    add(details, key(place, hour, date, region, className, session),
      () => ({ place, hour, date, region, className, session, ...aggregate() })),
  ];
  // A finding stores a free-text place while an activity can store a code or alias.
  const places = new Map();
  const location = (raw) => add(places, raw, () => Codes.label(ws, "activityPlace", raw || "").trim());
  const low = scope.from ? stamp(scope.from) : -Infinity, high = stamp(scope.to) + DAY;
  for (const a of facts.activities) {
    if (a.classification2 !== "노방") continue;
    const duration = M.minutes(a.start, a.end);
    if (!duration) {
      if (scope.inPeriod(a.date) && scope.matches(a)) quality.unknownActivityTime++;
      continue;
    }
    const original = stamp(a.date, a.start), begin = Math.max(original, low), end = Math.min(original + duration * 60000, high);
    if (end <= begin) continue;
    const place = location(a.place), className = scope.classKey(a.className), region = a.region || "";
    const eligibleDay = scope.inPeriod(dateOf(begin)) || scope.inPeriod(dateOf(end - 1));
    if (scope.matches(a) && eligibleDay && !place) quality.unknownActivityPlace++;
    if (a.worker.key === "unassigned") {
      if (scope.matches(a) && eligibleDay) quality.unknownWorker++;
      continue;
    }
    const session = a.start + "–" + a.end;
    const record = { place, region, className, session, source: a.sessionKey || key(a.date, region, place, session) };
    const events = add(workers, a.worker.key, () => []);
    events.push({ at: begin, opening: true, record }, { at: end, opening: false, record });
  }
  for (const [worker, events] of workers) {
    events.sort((a,b) => a.at - b.at);
    const active = new Set();
    let last = events[0].at;
    for (const event of events) {
      if (event.at > last && active.size) {
        const current = [...active];
        const first = current[0];
        const consistent = current.every((r) => r.place === first.place && r.region === first.region && r.className === first.className);
        const included = current.some(scope.matches);
        for (let begin = last; included && begin < event.at;) {
          const end = Math.min(event.at, (Math.floor(begin / HOUR) + 1) * HOUR);
          const date = dateOf(begin), hour = new Date(begin).getUTCHours(), minutes = (end - begin) / 60000;
          if (scope.inPeriod(date)) {
            if (!consistent) quality.conflictMinutes += minutes;
            else {
              const { place, region, className } = first;
              const sessionKeys = new Set(current.map((r) => r.source));
              const session = sessionKeys.size === 1 ? first.session : "중복 회차";
              for (const row of portions(place, hour, date, region, className, session)) {
                row.minutes += minutes;
                row.workers.add(worker);
                for (const id of sessionKeys) row.sessions.add(id);
                if (stamp(date) + 7 * DAY <= stamp(scope.asOf)) row.matureMinutes += minutes;
              }
              if (place && region)
                add(available, key(worker, region, place, date, hour), () => [])
                  .push({ start: begin, end, className, session });
            }
          }
          begin = end;
        }
      }
      if (event.opening) active.add(event.record);
      else active.delete(event.record);
      last = event.at;
    }
  }
  for (const f of facts.findings) {
    if (f.classification2 !== "노방" || !scope.matches(f)) continue;
    if (!f.date) { quality.unknownFindingDate++; continue; }
    if (!scope.inPeriod(f.date)) continue;
    const place = location(f.place), hour = f.time ? Number(f.time.slice(0, 2)) : null;
    if (!place) quality.missingPlace++;
    if (hour === null) quality.missingTime++;
    const covers = available.get(key(f.worker.key, f.region, place, f.date, hour)) || [];
    const className = scope.classKey(f.className), at = stamp(f.date, f.time || "00:00");
    const matches = covers.filter(span => span.className === className && Window.contains(span, at));
    const matched = matches.length > 0;
    const session = !matched ? "활동 미연결" :
      matches.every(s => s.session === matches[0].session) ? matches[0].session : "회차 구분 불가";
    for (const row of portions(place, hour, f.date, f.region || "", className, session)) {
      row.findings++;
      if (matched) row.matched++;
      if (matched && statuses.get(f.code) === "reached") row.reached7++;
    }
  }
  const order = (a, b) => Number(!a.place) - Number(!b.place) || a.place.localeCompare(b.place, "ko") ||
    (a.hour ?? 24) - (b.hour ?? 24) || (a.date || "").localeCompare(b.date || "");
  return { cells: [...cells.values()].map(present).sort(order),
    details: [...details.values()].map(present).sort(order), totals: present(total), quality };
}

function queryScope(ws, input) {
  const asOf = M.date(input.asOf), from = M.date(input.from, false), requestedTo = M.date(input.to, false);
  M.assert(!from || !requestedTo || from <= requestedTo, "조회 기간을 확인하세요.");
  const to = requestedTo && requestedTo < asOf ? requestedTo : asOf;
  const weekday = input.weekday === "" || input.weekday == null ? null : Number(input.weekday);
  M.assert(weekday === null || (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6), "요일을 확인하세요.");
  const inPeriod = d => !!d && (!from || d >= from) && d <= to &&
    (weekday === null || new Date(stamp(d)).getUTCDay() === weekday);
  const classes = new Map();
  const classKey = value => add(classes, value, () => Codes.find(ws, "className", value)?.value || value || "");
  const matches = r => (!input.region || r.region === input.region) && (!input.className || classKey(r.className) === classKey(input.className));
  return { asOf, from, to, requestedTo, matches, inPeriod, classKey };
}
function filteredActivity(ws, input, facts, cohortStatuses) {
  return venueActivity(ws, facts, queryScope(ws, input), cohortStatuses);
}
function summary(ws, input, facts = Performance.facts(ws)) {
  const scope = queryScope(ws, input);
  const { windows, cohortStatuses } = fixedWindows(ws, scope);
  const aggregateOnlyReports = (ws.dailyReports || []).filter(r => scope.inPeriod(r.date) && scope.matches(r)).length;
  return { activity: venueActivity(ws, facts, scope, cohortStatuses), windows, socialing: socialWindows(ws, scope),
    aggregateOnlyReports, cohortStatuses };
}
module.exports = { summary, filteredActivity };
