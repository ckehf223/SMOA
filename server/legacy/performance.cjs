"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  F = require("./finding-stats.cjs");
const W = require("./activity-window.cjs");
const C = require("./classification-scope.cjs");
const G = require("./goals.cjs");
const K = require("./codes.cjs");
const S = require("./person-stages.cjs");
const RegionalActivity = require("./regional-activity.cjs");
const StageCohorts = require("./stage-cohort.cjs");
const employmentOf = (ws, value) =>
  !value || K.label(ws, "employment", value) === "미입력"
    ? ""
    : K.find(ws, "employment", value)?.value || value;
const employmentMatches = (ws, row, selected) =>
  !selected || row.employment === (selected === C.UNCLASSIFIED ? "" : selected);
function classCodes(ws) {
  const aliases = new Map();
  for (const code of K.group(ws, "className")?.items || []) {
    for (const name of [code.value, code.label, ...code.aliases]) aliases.set(name, code.value);
  }
  return (value) => aliases.get(value) || value || "";
}
const DAY = 86400000,
  HOUR = 3600000,
  hourLabel = (hour) => `${String(hour).padStart(2, "0")}시`,
  stamp = (date, time = "00:00") => Date.parse(`${date}T${time}:00Z`),
  dayOf = (t) => new Date(t).toISOString().slice(0, 10),
  norm = (s) =>
    String(s || "")
      .replace(/\s/g, "")
      .toLowerCase();
const isZeroClass = (value) => ["0", "0반"].includes(norm(value));

function visibleClassValues(ws, kind) {
  if (kind !== "classData") return () => true;
  const zeroCodes = new Set(
    (K.group(ws, "className")?.items || [])
      .filter((code) => [code.value, code.label, ...code.aliases].some(isZeroClass))
      .map((code) => code.value),
  );
  return (value) => !isZeroClass(value) && !zeroCodes.has(value);
}

function classEngagement(ws, range, roster, records, classKey) {
  const regionalIds = RegionalActivity.activityRosterMemberIds(
    ws,
    new Set(roster.map((member) => member.id)),
  );
  const statuses = RegionalActivity.periodStatuses(ws, range, regionalIds);
  const classByWorker = new Map();
  const groups = new Map();
  for (const member of roster) {
    const key = classKey(member);
    if (!groups.has(key))
      groups.set(key, {
        members: 0,
        regionalWorkers: 0,
        regionalMembers: 0,
        proactiveWorkers: 0,
        street: new Set(),
        social: new Set(),
      });
    classByWorker.set(member.key, key);
    const group = groups.get(key),
      status = statuses.get(member.id);
    group.members++;
    if (regionalIds.has(member.id)) group.regionalMembers++;
    if (status >= 1 && status <= 3) group.regionalWorkers++;
    if (status === 1) group.proactiveWorkers++;
  }
  for (const record of records) {
    const key = classByWorker.get(record.worker.key);
    if (key === undefined || key !== classKey(record)) continue;
    const group = groups.get(key);
    if (record.classification2 === "노방") group.street.add(record.worker.key);
    if (record.classification2 === "소셜링") group.social.add(record.worker.key);
  }
  return (key) => {
    const group = groups.get(key);
    return {
      members: group?.members ?? 0,
      regionalWorkers: group?.regionalWorkers ?? 0,
      regionalRate: group?.regionalMembers
        ? group.regionalWorkers / group.regionalMembers
        : null,
      proactiveWorkers: group?.proactiveWorkers ?? 0,
      streetWorkers: group?.street.size ?? 0,
      socialWorkers: group?.social.size ?? 0,
    };
  };
}

function classGoalProgress(ws, goals, classKey, allAttainments, inDate) {
  const byStage = new Map();
  for (const goal of goals) {
    const key = classKey(goal);
    if (!byStage.has(goal.stageId)) byStage.set(goal.stageId, new Map());
    const classes = byStage.get(goal.stageId);
    if (!classes.has(key))
      classes.set(key, { target: 0, actual: 0, districts: new Set() });
    const stage = classes.get(key);
    stage.target += goal.target;
    stage.districts.add(goal.region);
  }

  const groups = new Map();
  for (const id of ws.stages) {
    const classes = byStage.get(id);
    if (!classes) continue;
    for (const entry of allAttainments.get(id)) {
      const stage = classes.get(classKey(entry));
      if (
        stage &&
        (stage.districts.has("") || stage.districts.has(entry.region)) &&
        inDate(entry.date)
      ) stage.actual++;
    }
    for (const [key, { actual, target }] of classes) {
      if (!groups.has(key))
        groups.set(key, { key, label: K.label(ws, "className", key), stages: [] });
      groups.get(key).stages.push({
        id,
        label: M.stageName(ws, id),
        actual,
        target,
        rate: target ? actual / target : null,
      });
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "ko", { numeric: true }),
  );
}

function districtFindingChange(findings, previousFindings) {
  const groups = new Map();
  function count(records, field) {
    for (const finding of records) {
      const region = finding.region || "구역 미입력";
      if (!groups.has(region)) groups.set(region, { region, current: 0, previous: 0 });
      groups.get(region)[field]++;
    }
  }
  count(findings, "current");
  if (previousFindings) count(previousFindings, "previous");
  const rows = [...groups.values()].map(({ region, current, previous }) => ({
    region,
    current,
    previous: previousFindings ? previous : null,
    delta: previousFindings ? current - previous : null,
    share: findings.length ? current / findings.length : null,
  })).sort((a, b) =>
    Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) ||
    b.current - a.current ||
    a.region.localeCompare(b.region, "ko", { numeric: true }),
  );
  return rows;
}

function merge(spans) {
  const out = [];
  for (const s of [...spans].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
function identityResolver(ws) {
  const org = O.get(ws),
    byId = new Map(
      org.members.flatMap((m) => [
        [m.id, m],
        [m.code, m],
      ]),
    ),
    byName = new Map(),
    byNameRegion = new Map(),
    identities = new Map();
  for (const m of org.members) {
    const name = norm(m.name),
      region = O.regionOf(org, m.unitId),
      localKey = JSON.stringify([name, region]);
    if (!byName.has(name)) byName.set(name, []);
    if (!byNameRegion.has(localKey)) byNameRegion.set(localKey, []);
    byName.get(name).push(m);
    byNameRegion.get(localKey).push(m);
    identities.set(m.id, {
      key: `member:${m.code}`,
      name: m.name,
      code: m.code,
      className: m.className || "",
      employment: employmentOf(ws, m.employment),
      status: m.status,
      currentRegion: region,
    });
  }
  return (code, name, region) => {
    let m = code ? byId.get(code) : null;
    if (!code && name) {
      const choices = byName.get(norm(name)) || [],
        local = byNameRegion.get(JSON.stringify([norm(name), region])) || [];
      if (local.length === 1) m = local[0];
      else if (choices.length === 1) m = choices[0];
    }
    return m
      ? identities.get(m.id)
      : code
        ? { key: `external:${code}`, name: name || "이름 미입력", code }
        : name
          ? { key: `name:${JSON.stringify([region, name])}`, name, code: "" }
          : { key: "unassigned", name: "활동자·인도자 미입력", code: "" };
  };
}
function facts(ws) {
  const resolve = identityResolver(ws),
    memberById = new Map(O.get(ws).members.map((m) => [m.id, m])),
    people = new Map(ws.people.map((p) => [p.code, p])),
    reports = new Map();
  for (const r of [...(ws.findingReports || [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  ))
    if (!reports.has(r.personCode) && r.foundDate && !r.dateUnknown)
      reports.set(r.personCode, r);
  const findings = F.findings(ws).map((r) => {
    const p = people.get(r.code),
      report = reports.get(r.code),
      member = p && memberById.get(p.introducerId);
    return {
      ...r,
      person: p || null,
      firstReport: report || null,
      place: (p ? p.place : report?.place) || "",
      age: p ? p.age : report?.age,
      className: p?.className ?? report?.className ?? member?.className ?? "",
      worker: resolve(
        p
          ? p.introducerSnapshot?.code || member?.code || ""
          : report?.memberCode || report?.memberId || "",
        p
          ? p.introducerSnapshot?.name || member?.name || p.worker
          : report?.worker,
        r.region,
      ),
    };
  });
  for (const finding of findings)
    finding.employment = finding.worker.employment ?? "__unlinked__";
  const activities = C.activities(ws).map((a) => {
    const worker = resolve(a.workerId, a.worker, a.region || "");
    return {
      ...a,
      region: a.region || "",
      className: a.className ?? worker.className ?? "",
      employment: worker.employment ?? "__unlinked__",
      worker,
    };
  });
  return { findings, activities };
}
function memberStageDefinitions(ws) {
  const findingId = ws.stages.find((id) =>
    [id, ws.stageNames[id]].some((value) => norm(value) === "찾b"),
  );
  return [
    { id: findingId || "찾B", label: "찾B" },
    { id: S.stageId(ws, "manpikDate") || "만픽", label: "만픽" },
    { id: S.stageId(ws, "findADate") || "찾A", label: "찾A" },
    { id: S.stageId(ws, "habBDate") || "합 B", label: "합B" },
    { id: S.stageId(ws, "bokshinDate") || "복음방", label: "복음방" },
    { id: S.stageId(ws, "centerRegisteredDate") || "센터등록", label: "센터등록" },
  ];
}
function stageAttainments(ws, findings, memberStages) {
  const personById = new Map(ws.people.map((person) => [person.id, person])),
    findingByCode = new Map(findings.map((finding) => [finding.code, finding])),
    rowsByStage = new Map(
      ws.stages.map((id) => [
        id,
        G.attainments(ws, id).map((entry) => {
          const person = personById.get(entry.personId),
            finding = findingByCode.get(person.code);
          return {
            ...entry,
            date: id === memberStages?.[0].id ? finding.date : entry.date,
            worker: finding.worker,
            employment: finding.employment,
            classification2: finding.classification2,
          };
        }),
      ]),
    );
  if (memberStages) {
    const findingId = memberStages[0].id;
    // Dated report-only findings also count once for the original finding stage.
    const reportFindings = findings.filter(
      (finding) => !finding.person && finding.firstReport?.stage === findingId,
    );
    rowsByStage.set(findingId, [
      ...(rowsByStage.get(findingId) || []),
      ...reportFindings,
    ]);
  }
  return rowsByStage;
}
function memberStageLeaders(leaderStages, attainments) {
  return leaderStages.map((stage) => {
    const candidates = new Map();
    let count = 0;
    for (const { worker, region } of attainments.get(stage.id) || []) {
      const { key, name, code, currentRegion } = worker;
      if (key === "unassigned") continue;
      if (!candidates.has(key))
        candidates.set(key, {
          key,
          name,
          code,
          region: currentRegion || region || "",
          count: 0,
        });
      const candidate = candidates.get(key);
      candidate.count++;
      count = Math.max(count, candidate.count);
    }
    const members = [...candidates.values()]
      .filter((candidate) => candidate.count === count)
      .sort((a, b) =>
        a.name.localeCompare(b.name, "ko") ||
        a.region.localeCompare(b.region, "ko", { numeric: true }) ||
        a.key.localeCompare(b.key),
      )
      .map(({ count: _, ...member }) => member);
    return { ...stage, count, members };
  });
}
function countFindingPlace(places, key, hour) {
  if (!places.has(key))
    places.set(key, { findings: 0, hours: new Map(), unknownTime: 0 });
  const place = places.get(key);
  place.findings++;
  if (hour === null) place.unknownTime++;
  else place.hours.set(hour, (place.hours.get(hour) || 0) + 1);
}
function findingPlaceHourRows(places) {
  return [...places]
    .sort(([a, first], [b, second]) =>
      Number(!a) - Number(!b) ||
      second.findings - first.findings ||
      a.localeCompare(b, "ko", { numeric: true }),
    )
    .map(([place, { findings, hours, unknownTime }]) => ({
      label: place || "장소 미입력",
      findings,
      unknownTime,
      hours: [...hours]
        .sort(([a], [b]) => a - b)
        .map(([hour, findings]) => ({ label: hourLabel(hour), findings })),
    }));
}
function findingBreakdowns(findings, includeWeekdays = true) {
  const places = new Map();
  const ages = new Map();
  const weekdays = includeWeekdays
    ? ["월", "화", "수", "목", "금", "토", "일"].map((day, index) => ({
        weekday: (index + 1) % 7,
        label: `${day}요일`,
        findings: 0,
        places: new Map(),
      }))
    : null;
  for (const finding of findings) {
    const key = finding.place.trim().normalize("NFC");
    const hour = finding.time ? Number(finding.time.slice(0, 2)) : null;
    countFindingPlace(places, key, hour);
    if (weekdays) {
      const day = weekdays[(new Date(stamp(finding.date)).getUTCDay() + 6) % 7];
      day.findings++;
      countFindingPlace(day.places, key, hour);
    }
    const age = Number.isInteger(finding.age) && finding.age >= 0 && finding.age <= 120
      ? finding.age
      : null;
    ages.set(age, (ages.get(age) || 0) + 1);
  }
  const findingPlaceHours = findingPlaceHourRows(places);
  const findingAges = [...ages]
    .sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
    .map(([age, findings]) => ({ age, label: age === null ? "나이 미입력" : `${age}세`, findings }));
  return {
    recordedFields: {
      placeAndTime: [...places].reduce((sum, [place, row]) =>
        sum + (place ? row.findings - row.unknownTime : 0), 0),
      place: findings.length - (places.get("")?.findings || 0),
      age: findings.length - (ages.get(null) || 0),
    },
    findingPlaceHours,
    findingPlaces: findingPlaceHours.map(({ label, findings }) => ({ label, findings })),
    findingAges,
    ...(weekdays && {
      findingWeekdays: weekdays.map(({ places, ...day }) => ({
        ...day,
        places: findingPlaceHourRows(places),
      })),
    }),
  };
}
function metrics(activities, findings, scope) {
  const byWorker = new Map(),
    coverage = new Map(),
    allWorkers = new Set(),
    activityDates = new Set(),
    unknownDates = new Map(),
    daily = new Map(),
    hours = Array.from({ length: 24 }, (_, h) => ({
      label: hourLabel(h),
      minutes: 0,
      findings: 0,
      matchedFindings: 0,
      workers: new Set(),
    })),
    intervals = [];
  let unknownTime = 0,
    unknownWorker = 0;
  const day = (d) => {
    if (!daily.has(d))
      daily.set(d, {
        date: d,
        minutes: 0,
        findings: 0,
        matchedFindings: 0,
        unknownFindingTime: 0,
        unknownActivityTime: 0,
        workers: new Set(),
      });
    return daily.get(d);
  };
  for (const a of activities) {
    const key = a.worker.key;
    allWorkers.add(key);
    if (!a.start || !a.end || !M.minutes(a.start, a.end)) {
      unknownTime++;
      activityDates.add(a.date);
      day(a.date).unknownActivityTime++;
      intervals.push({
        name: a.worker.name,
        code: a.worker.code,
        region: a.region,
        start: `${a.date}T${a.start || "미입력"}`,
        end: `${a.date}T${a.end || "미입력"}`,
        minutes: null,
      });
      if (key !== "unassigned") day(a.date).workers.add(key);
      continue;
    }
    if (key === "unassigned") {
      unknownWorker++;
      continue;
    }
    const start = Math.max(stamp(a.date, a.start), scope.low),
      end = Math.min(
        stamp(a.date, a.start) + M.minutes(a.start, a.end) * 60000,
        scope.high,
      );
    if (!byWorker.has(key)) byWorker.set(key, []);
    byWorker.get(key).push({ start, end });
    const ck = JSON.stringify([a.region, key]);
    if (!coverage.has(ck)) coverage.set(ck, []);
    coverage.get(ck).push({ start, end });
    intervals.push({
      name: a.worker.name,
      code: a.worker.code,
      region: a.region,
      start: new Date(start).toISOString().slice(0, 16),
      end: new Date(end).toISOString().slice(0, 16),
      minutes: (end - start) / 60000,
    });
  }
  for (const [key, spans] of byWorker)
    for (const s of merge(spans))
      for (let t = s.start; t < s.end;) {
        const next = Math.min(s.end, (Math.floor(t / HOUR) + 1) * HOUR),
          date = dayOf(t),
          h = new Date(t).getUTCHours(),
          minutes = (next - t) / 60000,
          d = day(date);
        hours[h].minutes += minutes;
        hours[h].workers.add(key);
        d.minutes += minutes;
        d.workers.add(key);
        activityDates.add(date);
        t = next;
      }
  for (const [key, spans] of coverage) coverage.set(key, merge(spans));
  let matched = 0,
    unknownFindingTime = 0,
    timedStreetFindings = 0;
  for (const f of findings) {
    const d = day(f.date);
    d.findings++;
    if (!f.time) {
      unknownFindingTime++;
      d.unknownFindingTime++;
      continue;
    }
    const h = hours[Number(f.time.slice(0, 2))],
      at = stamp(f.date, f.time);
    h.findings++;
    if (f.classification2 === "노방") timedStreetFindings++;
    // Only the credited worker's activity in the same district can explain their finding.
    const spans =
      f.classification2 === "노방"
        ? coverage.get(JSON.stringify([f.region, f.worker.key])) || []
        : [];
    if (f.region && f.worker.key !== "unassigned" && W.matches(spans, at)) {
      h.matchedFindings++;
      d.matchedFindings++;
      matched++;
    }
  }
  const minutes = hours.reduce((n, h) => n + h.minutes, 0),
    rate = (count, minutes) => (minutes ? count / (minutes / 60) : null);
  return {
    findings: findings.length,
    activityDays: activityDates.size,
    activityDates: [...activityDates].sort(),
    activityRecords: activities.length,
    workers: [...allWorkers].filter((k) => k !== "unassigned").length,
    minutes,
    matchedFindings: matched,
    unmatchedFindings: findings.length - matched - unknownFindingTime,
    unknownFindingTime,
    timedStreetFindings,
    unknownActivityTime: unknownTime,
    unknownWorker,
    perHour: rate(matched, minutes),
    days: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        ...d,
        workers: d.workers.size,
        perHour: rate(d.matchedFindings, d.minutes),
      })),
    hours: hours.map((h) => ({
      ...h,
      workers: h.workers.size,
      unmatchedFindings: h.findings - h.matchedFindings,
      perPersonHour: rate(h.matchedFindings, h.minutes),
    })),
    intervals: intervals.sort(
      (a, b) =>
        a.start.localeCompare(b.start) || a.name.localeCompare(b.name, "ko"),
    ),
  };
}
function legacySummary(ws, input, kind, all, stages) {
  const classification2 = C.filter(input.classification2),
    activityAvailable = C.activityAvailable(input);
  M.assert(
    ["regionData", "memberData"].includes(kind),
    "분석 페이지를 확인하세요.",
  );
  const from = M.date(input.from || "", false),
    to = M.date(input.to || "", false),
    region = M.text(input.region || "", 60),
    requested = M.text(input.statsMember || "", 200),
    classCode = classCodes(ws),
    classFilter = M.text(input.statsClass || "", 60),
    selectedClass = classFilter === C.UNCLASSIFIED ? "" : classCode(classFilter),
    scope = {
      low: from ? stamp(from) : -Infinity,
      high: to ? stamp(to) + DAY : Infinity,
    };
  M.assert(!from || !to || from <= to, "조회 기간을 확인하세요.");
  const inDate = (d) => d && (!from || d >= from) && (!to || d <= to),
    recordMatches = (record) =>
      inDate(record.date) &&
      (!region || record.region === region) &&
      C.matches(record.classification2, classification2) &&
      employmentMatches(ws, record, input.statsEmployment) &&
      (!classFilter || classCode(record.className) === selectedClass),
    activities = all.activities.filter(
      (a) =>
        activityAvailable &&
        C.activity(a) === "노방" &&
        employmentMatches(ws, a, input.statsEmployment) &&
        (!classFilter || classCode(a.className) === selectedClass) &&
        (!region || a.region === region) &&
        (a.start && a.end && M.minutes(a.start, a.end)
          ? stamp(a.date, a.start) < scope.high &&
            stamp(a.date, a.start) + M.minutes(a.start, a.end) * 60000 >=
              scope.low
          : inDate(a.date)),
    ),
    findings = all.findings.filter(recordMatches),
    stageRecords = kind === "memberData"
      ? [...stages.values()].flat().filter(recordMatches)
      : [],
    members = new Map();
  for (const m of O.get(ws).members)
    members.set(`member:${m.code}`, {
      key: `member:${m.code}`,
      name: m.name,
      code: m.code,
      region: O.regionOf(O.get(ws), m.unitId),
      className: m.className || "",
      employment: employmentOf(ws, m.employment),
    });
  for (const r of [...all.activities, ...all.findings, ...stageRecords])
    if (!members.has(r.worker.key))
      members.set(r.worker.key, { ...r.worker, region: r.region });
  const recordedKeys = new Set(
    [...activities, ...findings, ...stageRecords].map((r) => r.worker.key),
  );
  const eligible = new Map(
    [...members].filter(
      ([key, m]) =>
        (!region || m.region === region || recordedKeys.has(key)) &&
        (employmentMatches(ws, m, input.statsEmployment) ||
          recordedKeys.has(key)) &&
        (!classFilter ||
          classCode(m.className) === selectedClass ||
          recordedKeys.has(key)),
    ),
  );
  const selected =
    kind === "memberData" && eligible.has(requested) ? requested : "";
  const scopedActivities =
    kind === "memberData" && selected
      ? activities.filter((r) => r.worker.key === selected)
      : activities;
  const scopedFindings =
    kind === "memberData" && selected
      ? findings.filter((r) => r.worker.key === selected)
      : findings;
  const keys =
    kind === "regionData"
      ? [
          ...new Set([
            ...(region
              ? [region]
              : O.get(ws)
                  .nodes.filter(
                    (n) => n.active && (n.reportRegion || /구역/.test(n.type)),
                  )
                  .map((n) => O.regionOf(O.get(ws), n.id))),
            ...activities.map((a) => a.region || "구역 미입력"),
            ...findings.map((f) => f.region || "구역 미입력"),
          ]),
        ].filter(Boolean)
      : selected
        ? [selected]
        : [...recordedKeys];
  const rows = keys
    .map((key) => {
      const match = (r) =>
          kind === "regionData"
            ? (r.region || "구역 미입력") === key
            : r.worker.key === key,
        fs = findings.filter(match),
        as = activities.filter(match),
        member = members.get(key);
      return {
        key,
        label: kind === "regionData" ? key : member?.name || "미입력",
        name: member?.name || "",
        code: member?.code || "",
        region:
          kind === "regionData"
            ? key
            : [...new Set([...as, ...fs].map((r) => r.region).filter(Boolean))]
                .sort()
                .join(", ") ||
              member?.region ||
              "",
        metrics: metrics(as, fs, scope),
      };
    })
    .sort((a, b) =>
      kind === "regionData"
        ? a.label.localeCompare(b.label, "ko", { numeric: true })
        : b.metrics.findings - a.metrics.findings ||
          a.label.localeCompare(b.label, "ko") ||
          a.key.localeCompare(b.key),
    );
  const selectedMatch = (r) => r.worker.key === selected,
    detail =
      kind === "memberData" && selected
        ? {
            key: selected,
            ...members.get(selected),
            metrics: metrics(
              activities.filter(selectedMatch),
              findings.filter(selectedMatch),
              scope,
            ),
          }
        : null;
  return {
    kind,
    from,
    to,
    region,
    classification2,
    activityAvailable,
    rows,
    detail,
    selectedMember: selected,
    members: [...eligible.values()]
      .map((m) => ({
        ...m,
        currentRegion: m.region,
        region: region || m.region,
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, "ko") || a.key.localeCompare(b.key),
      ),
    totals: metrics(scopedActivities, scopedFindings, scope),
  };
}
// Period production and participation supplement the original exposure/cohort
// analysis. Roster rates never use unlinked names as members of the denominator.
function summary(ws, input = {}, kind = "regionData") {
  M.assert(
    [
      "regionData",
      "memberData",
      "classData",
      "dailyData",
      "employmentData",
    ].includes(kind),
    "분석 페이지를 확인하세요.",
  );
  const classVisible = visibleClassValues(ws, kind),
    classCode = classCodes(ws),
    classFilter = M.text(input.statsClass || "", 60),
    classFilterKey = classFilter === C.UNCLASSIFIED ? classFilter : classCode(classFilter),
    selectedClass = classVisible(classFilterKey) ? classFilterKey : "",
    all = facts(ws),
    memberStages = kind === "memberData" ? memberStageDefinitions(ws) : null,
    analyzeFindingDetails = kind === "memberData" || kind === "classData",
    allAttainments = stageAttainments(ws, all.findings, memberStages),
    result = legacySummary(
      ws,
      { ...input, statsClass: selectedClass },
      ["classData", "dailyData", "employmentData"].includes(kind)
        ? "regionData"
        : kind,
      all,
      allAttainments,
    ),
    org = O.get(ws),
    from = result.from,
    to = result.to,
    scope = {
      low: from ? stamp(from) : -Infinity,
      high: to ? stamp(to) + DAY : Infinity,
    },
    selectedClassValue = selectedClass === C.UNCLASSIFIED ? "" : selectedClass,
    classKey = (row) => classCode(row.className),
    selectedEmployment = M.text(input.statsEmployment || "", 60),
    classMatches = (r) => {
      const key = classKey(r);
      return classVisible(key) &&
        (!selectedClass || key === selectedClassValue) &&
        employmentMatches(ws, r, selectedEmployment);
    },
    regionMatches = (r) => !result.region || r.region === result.region,
    selectedMatches = (r) =>
      !result.selectedMember || r.worker.key === result.selectedMember,
    inDate = (d) => d && (!from || d >= from) && (!to || d <= to),
    activityInDate = (a) =>
      a.start && a.end && M.minutes(a.start, a.end)
        ? stamp(a.date, a.start) < scope.high &&
          stamp(a.date, a.start) + M.minutes(a.start, a.end) * 60000 > scope.low
        : inDate(a.date),
    availableMembers = org.members
      .filter(
        (m) =>
          m.status === "active" &&
          O.ancestors(org, m.unitId).every((n) => n.active),
      )
      .map((m) => ({
        ...m,
        key: `member:${m.code}`,
        region: O.regionOf(org, m.unitId),
        employment: employmentOf(ws, m.employment),
      })),
    roster = availableMembers.filter(
      (m) =>
        regionMatches(m) &&
        classMatches(m) &&
        (!result.selectedMember || m.key === result.selectedMember),
    ),
    scopedRecords = all.activities.filter(
      (a) =>
        activityInDate(a) &&
        regionMatches(a) &&
        classMatches(a) &&
        selectedMatches(a),
    ),
    records = scopedRecords.filter((a) =>
      C.matches(a.classification2, result.classification2),
    ),
    exposure = result.activityAvailable
      ? records.filter((a) => a.classification2 === "노방")
      : [],
    scopedFindings = all.findings.filter(
      (f) =>
        inDate(f.date) &&
        regionMatches(f) &&
        classMatches(f) &&
        selectedMatches(f),
    ),
    findings = scopedFindings.filter((f) =>
      C.matches(f.classification2, result.classification2),
    ),
    dayRecords = (date) =>
      records.filter((a) =>
        a.start && a.end && M.minutes(a.start, a.end)
          ? stamp(a.date, a.start) < stamp(date) + DAY &&
            stamp(a.date, a.start) + M.minutes(a.start, a.end) * 60000 >
              stamp(date)
          : a.date === date,
      ),
    employmentLabel = (value) =>
      value === "__unlinked__"
        ? "명부 미연결"
        : K.label(ws, "employment", value) || "미입력";
  const participation = (acts, members) => {
    const keys = new Set(acts.map((a) => a.worker.key)),
      eligible = new Set(members.map((m) => m.key));
    const workers = [...keys].filter((k) => eligible.has(k)).length;
    return {
      members: members.length,
      workers,
      rate: members.length ? workers / members.length : null,
      externalWorkers: [...keys].filter(
        (k) => k !== "unassigned" && !eligible.has(k),
      ).length,
      unassignedRecords: acts.filter((a) => a.worker.key === "unassigned")
        .length,
    };
  };
  const districtActivity =
    kind === "regionData"
      ? {
          street: scopedRecords.filter((a) => a.classification2 === "노방"),
          club: scopedRecords.filter((a) => a.classification2 === "소셜링"),
          findings: scopedFindings.filter((f) => f.classification2 === "노방"),
        }
      : null;
  const districtOverview = (match, members) => {
    const street = districtActivity.street.filter(match),
      club = districtActivity.club.filter(match);
    const {
      activityRecords,
      findings,
      minutes,
      matchedFindings,
      unmatchedFindings,
      unknownFindingTime,
      unknownActivityTime,
      unknownWorker,
      perHour,
      hours,
    } = metrics(street, districtActivity.findings.filter(match), scope);
    return {
      participation: {
        street: participation(street, members),
        club: participation(club, members),
        combined: participation([...street, ...club], members),
      },
      streetMetrics: {
        activityRecords,
        findings,
        minutes,
        matchedFindings,
        unmatchedFindings,
        unknownFindingTime,
        unknownActivityTime,
        unknownWorker,
        perHour,
        hours,
      },
    };
  };
  const categories = (fs) =>
    [...M.PERSON_CLASSIFICATIONS.classification2, ""].map((value) => ({
      classification2: value || C.UNCLASSIFIED,
      label: value || "미입력",
      count: fs.filter((f) => f.classification2 === value).length,
      share: fs.length
        ? fs.filter((f) => f.classification2 === value).length / fs.length
        : null,
    }));
  const findingByCode = new Map(all.findings.map((f) => [f.code, f]));
  const stageGroupSources = new Map();
  const cohorts = StageCohorts.measure(ws, {
    from,
    to,
    includeReports: true,
    includeFindingToFindA: kind !== "regionData",
    classify(source) {
      const finding = findingByCode.get(source.code);
      if (!finding) return null;
      const row = { ...finding, ...source };
      if (!regionMatches(row) || !classMatches(row) || !selectedMatches(row) ||
          !C.matches(row.classification2, result.classification2)) return null;
      const key = kind === "regionData" ? row.region || "구역 미입력"
        : kind === "classData" ? classKey(row)
        : kind === "dailyData" ? row.date : row.worker.key;
      if (!stageGroupSources.has(key)) stageGroupSources.set(key, row);
      return key;
    },
  });
  const stageSources = [...stageGroupSources.values()];
  const periodAttainments = new Map(
    [...allAttainments].map(([id, stages]) => [
      id,
      stages.filter(
        (a) =>
          inDate(a.date) &&
          regionMatches(a) &&
          classMatches(a) &&
          C.matches(a.classification2, result.classification2),
      ),
    ]),
  );
  const attainments = result.selectedMember
    ? new Map(
        [...periodAttainments].map(([id, rows]) => [id, rows.filter(selectedMatches)]),
      )
    : periodAttainments;
  if (memberStages) {
    result.memberStageColumns = memberStages.slice(0, 4);
    result.memberStageLeaders = memberStageLeaders(
      memberStages.filter(({ label }) => label !== "만픽"),
      periodAttainments,
    );
  }
  const goalsAvailable = !result.classification2 && !selectedEmployment &&
    !["memberData", "employmentData"].includes(kind);
  const classGoalMatches = (goal) => !!goal.className && classVisible(classKey(goal)) &&
    (!selectedClass || classKey(goal) === selectedClassValue);
  const matchingClassGoals = kind === "classData" ? ws.goals.filter((g) =>
    g.from === from && g.to === to && ws.stages.includes(g.stageId) &&
    regionMatches(g) && classGoalMatches(g),
  ) : [];
  const classStageKey = (goal) => JSON.stringify([classKey(goal), goal.stageId]);
  const directClassGoals = new Set(
    matchingClassGoals.filter((goal) => !goal.region).map(classStageKey),
  );
  // A whole-class target supersedes that class and stage's district targets
  // for the same period when viewing all districts.
  const classGoals = matchingClassGoals.filter(
    (goal) => !goal.region || !directClassGoals.has(classStageKey(goal)),
  );
  const goalPool = kind === "classData"
    ? classGoals
    : ws.goals.filter((g) => g.region);
  const stageCounts = (match, goalMatch, dateFrom = from, dateTo = to) =>
    ws.stages.map((id) => {
      const attained = attainments.get(id).filter(match),
        actual = attained.length,
        goals =
          goalsAvailable
            ? goalPool.filter(
                (g) =>
                  (g.stageId || "*") === id &&
                  g.from === dateFrom &&
                  g.to === dateTo &&
                  regionMatches(g) &&
                  goalMatch(g),
              )
            : [],
        target = goals.length ? goals.reduce((n, g) => n + g.target, 0) : null,
        comparedActual = goals.length
          ? attained.filter((a) =>
              goals.some(
                (g) =>
                  (!g.region || g.region === a.region) &&
                  (!g.className || classKey(g) === classKey(a)),
              ),
            ).length
          : null;
      return {
        id,
        label: M.stageName(ws, id),
        actual,
        target,
        comparedActual,
        configured: goals.length,
        rate: target ? comparedActual / target : null,
      };
    });
  const dates = new Set([
    ...findings.map((f) => f.date),
    ...records.map((a) => a.date).filter(inDate),
    ...[...attainments.values()].flat().map((a) => a.date),
    ...stageSources.map((a) => a.date),
  ]);
  if (from && to && stamp(to) - stamp(from) <= 365 * DAY)
    for (let d = stamp(from); d <= stamp(to); d += DAY) dates.add(dayOf(d));
  const previous = from && to ? {
    from: dayOf(stamp(from) - (stamp(to) - stamp(from) + DAY)),
    to: dayOf(stamp(from) - DAY),
  } : null;
  const previousFindings = previous ? all.findings.filter(
    (f) => f.date >= previous.from && f.date <= previous.to && regionMatches(f) &&
      classMatches(f) && selectedMatches(f) && C.matches(f.classification2, result.classification2),
  ) : [];
  const breakdowns = analyzeFindingDetails ? findingBreakdowns(findings) : null;
  result.kind = kind;
  if (kind === "classData") {
    const engagementFor = classEngagement(ws, { from, to }, roster, scopedRecords, classKey);
    result.classGoals = classGoalProgress(ws, classGoals, classKey, allAttainments, inDate);
    const previousByClass = new Map();
    for (const finding of previousFindings) {
      const key = classKey(finding);
      previousByClass.set(key, (previousByClass.get(key) || 0) + 1);
    }
    const keys = new Set(
      [
        ...roster,
        ...records,
        ...findings,
        ...[...attainments.values()].flat(),
        ...stageSources,
        ...(goalsAvailable ? classGoals : []),
        ...previousFindings,
      ].map(classKey),
    );
    result.rows = [...keys]
      .map((key) => {
        const match = (r) => classKey(r) === key,
          fs = findings.filter(match),
          acts = exposure.filter(match),
          prior = previousByClass.get(key) || 0;
        return {
          key,
          region: result.region,
          className: key,
          label: K.label(ws, "className", key) || "반 미입력",
          metrics: metrics(acts, fs, scope),
          engagement: engagementFor(key),
          comparison: previous ? { findings: prior, findingsDelta: fs.length - prior } : null,
        };
      })
      .sort(
        (a, b) =>
          a.label.localeCompare(b.label, "ko", { numeric: true }),
      );
  } else if (kind === "employmentData") {
    const members = new Map(roster.map((m) => [m.key, m]));
    for (const record of [...records, ...findings, ...[...attainments.values()].flat(), ...stageSources]) {
      const worker = record.worker;
      if (!members.has(worker.key))
        members.set(worker.key, { ...worker, region: worker.currentRegion ?? record.region });
    }
    result.rows = [...members.values()]
      .map((member) => {
        const employment = member.employment ?? "__unlinked__",
          match = (r) => r.worker.key === member.key,
          fs = findings.filter(match),
          acts = exposure.filter(match);
        return {
          key: member.key,
          region: member.region || "",
          employment,
          employmentLabel: employmentLabel(employment),
          label: member.name,
          metrics: metrics(acts, fs, scope),
        };
      })
      .sort(
        (a, b) =>
          a.employmentLabel.localeCompare(b.employmentLabel, "ko") ||
          a.label.localeCompare(b.label, "ko", { numeric: true }) ||
          a.region.localeCompare(b.region, "ko", { numeric: true }) ||
          a.key.localeCompare(b.key),
      );
  } else if (kind === "dailyData") {
    result.rows = [...dates].sort().map((date) => {
      const ds = { low: stamp(date), high: stamp(date) + DAY },
        fs = findings.filter((f) => f.date === date);
      return {
        key: date,
        date,
        label: date,
        region: result.region,
        metrics: metrics([], fs, ds),
      };
    });
    // Only spans intersecting the day may contribute activity record/day counts.
    for (const row of result.rows) {
      const acts = dayRecords(row.date).filter(
        (a) => result.activityAvailable && C.activity(a) === "노방",
      );
      row.metrics = metrics(
        acts,
        findings.filter((f) => f.date === row.date),
        { low: stamp(row.date), high: stamp(row.date) + DAY },
      );
    }
  }
  if (kind === "memberData" && !result.selectedMember) {
    const existing = new Set(result.rows.map((r) => r.key));
    for (const a of [...records, ...[...attainments.values()].flat(), ...stageSources])
      if (!existing.has(a.worker.key)) {
        existing.add(a.worker.key);
        const fs = findings.filter((f) => f.worker.key === a.worker.key),
          acts = exposure.filter((x) => x.worker.key === a.worker.key);
        result.rows.push({
          key: a.worker.key,
          label: a.worker.name,
          name: a.worker.name,
          code: a.worker.code,
          region: a.region,
          metrics: metrics(acts, fs, scope),
        });
      }
  }
  if (kind === "regionData") {
    const keys = new Set(result.rows.map((r) => r.key));
    for (const record of [
      ...roster.filter((member) => member.region),
      ...records,
      ...districtActivity.street,
      ...districtActivity.club,
      ...districtActivity.findings,
      ...[...attainments.values()].flat(),
      ...stageSources,
    ]) {
      const key = record.region || "구역 미입력";
      if (!keys.has(key)) {
        keys.add(key);
        const fs = findings.filter((f) => (f.region || "구역 미입력") === key),
          acts = exposure.filter((a) => (a.region || "구역 미입력") === key);
        result.rows.push({
          key,
          label: key,
          region: key,
          metrics: metrics(acts, fs, scope),
        });
      }
    }
    result.rows.sort((a, b) =>
      a.label.localeCompare(b.label, "ko", { numeric: true }),
    );
    result.districtOverview = districtOverview(() => true, roster);
    result.districtOverview.findingChange = districtFindingChange(findings, previous ? previousFindings : null);
  }
  for (const row of result.rows) {
    const match = (r) =>
        kind === "regionData"
          ? (r.region || "구역 미입력") === row.key
          : kind === "classData"
            ? classKey(r) === row.key
            : kind === "dailyData"
              ? r.date === row.date
              : r.worker?.key === row.key,
      acts =
        kind === "dailyData" ? dayRecords(row.date) : records.filter(match),
      members =
        kind === "regionData"
          ? roster.filter(match)
          : kind === "classData"
            ? roster.filter((m) => classKey(m) === row.key)
            : kind === "memberData" || kind === "employmentData"
              ? roster.filter((m) => m.key === row.key)
              : roster;
    row.participation = participation(acts, members);
    row.cohort = cohorts.groups.get(row.key) || cohorts.empty();
    if (districtActivity) row.districtOverview = districtOverview(match, members);
    const rowFindings = findings.filter(match);
    row.categories = categories(rowFindings);
    if (breakdowns)
      Object.assign(
        row.metrics,
        result.selectedMember ? breakdowns : findingBreakdowns(rowFindings, kind === "classData"),
      );
    row.stages = stageCounts(
      match,
      (g) =>
        kind === "classData"
          ? classGoalMatches(g) && classKey(g) === row.key
          : kind === "regionData"
            ? (selectedClass
                ? classKey(g) === selectedClassValue
                : !g.className) && g.region === row.key
            : kind === "dailyData"
              ? !g.className
              : false,
      kind === "dailyData" ? row.date : from,
      kind === "dailyData" ? row.date : to,
    );
  }
  result.classes = [
    ...new Set(
      [
        ...availableMembers.filter(regionMatches),
        ...all.findings.filter(regionMatches),
        ...all.activities.filter(regionMatches),
        ...(kind === "classData" ? result.rows : []),
      ].map(classKey),
    ),
  ]
    .filter(classVisible)
    .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
    .map((value) => ({
      value: value || C.UNCLASSIFIED,
      label: K.label(ws, "className", value) || "반 미입력",
    }));
  result.selectedClass = selectedClass;
  result.employments = [
    ...new Set(
      [
        ...availableMembers.filter(regionMatches),
        ...all.findings.filter(regionMatches),
        ...all.activities.filter(regionMatches),
      ].map((r) => r.employment ?? "__unlinked__"),
    ),
  ]
    .sort((a, b) => employmentLabel(a).localeCompare(employmentLabel(b), "ko"))
    .map((value) => ({
      value: value || C.UNCLASSIFIED,
      label: employmentLabel(value),
    }));
  result.selectedEmployment = selectedEmployment;
  result.participation = participation(records, roster);
  result.stages = stageCounts(
    () => true,
    kind === "classData"
      ? classGoalMatches
      : (g) => selectedClass
        ? selectedClass === C.UNCLASSIFIED
          ? g.className === ""
          : classKey(g) === selectedClass
        : !g.className,
  );
  result.categories = categories(findings);
  result.totals = metrics(exposure, findings, scope);
  if (breakdowns) Object.assign(result.totals, breakdowns);
  result.cohort = cohorts.overall;
  if (result.detail) {
    result.detail.participation = result.participation;
    result.detail.stages = result.stages;
    result.detail.cohort = result.cohort;
    if (breakdowns) Object.assign(result.detail.metrics, breakdowns);
  }
  result.comparison = null;
  if (previous) {
    const { from: beforeFrom, to: beforeTo } = previous,
      previousActs = all.activities.filter(
        (a) =>
          (a.start && a.end && M.minutes(a.start, a.end)
            ? stamp(a.date, a.start) < stamp(beforeTo) + DAY &&
              stamp(a.date, a.start) + M.minutes(a.start, a.end) * 60000 >
                stamp(beforeFrom)
            : a.date >= beforeFrom && a.date <= beforeTo) &&
          regionMatches(a) &&
          classMatches(a) &&
          selectedMatches(a) &&
          C.matches(C.activity(a), result.classification2),
      ),
      previousWorkers = participation(previousActs, roster).workers;
    result.comparison = {
      from: beforeFrom,
      to: beforeTo,
      findings: previousFindings.length,
      findingsDelta: findings.length - previousFindings.length,
      workers: previousWorkers,
      workersDelta: result.participation.workers - previousWorkers,
      rate: previousFindings.length
        ? (findings.length - previousFindings.length) / previousFindings.length
        : null,
    };
  }
  result.notes = [
    "참여율은 현재 활동 중인 명부 인원을 분모로, 선택 분류의 활동 기록에 연결된 명부 인원을 중복 없이 계산합니다. 명부 미연결·다른 현재 소속·비활동 구성원은 별도로 표시합니다.",
    "반별 찾기는 대상자에 저장된 반을, 활동은 기록의 반 또는 현재 활동자 명부의 반을 기준으로 합니다. 과거 명부 소속을 추정하지 않습니다.",
    "전일자·반일자·직장인 등 직업별 분석은 대상자의 직업이 아닌 현재 활동자·인도자 명부의 직업 구분을 사용합니다. 명부 미연결은 미입력과 구별합니다.",
    "기간 단계 실적은 각 단계의 상신일에 집계합니다. 단계향상률은 출발 단계 날짜가 조회 기간에 속한 사람을 분모로, 이후 도달이 확인된 사람을 분자로 집계합니다. 분류를 선택하면 전체 분류 목표와 달성률을 비교하지 않습니다.",
  ];
  if (kind === "classData") result.notes.push(
    "같은 반의 실적은 조회 구역 범위에서 합산합니다. 달성률은 해당 반 목표가 설정된 구역의 실적을 비교합니다.",
  );
  if (kind === "regionData") result.notes.push(
    "구역별 활동 참여율은 현재 명부의 노방·소셜링 참여자만 집계합니다. 합계는 두 활동에 모두 참여한 사람을 한 번만 셉니다.",
    "노방 시간대별 효율은 동일 구역의 본인 활동시간에 연결된 노방 찾기 건수를 순활동 인시간으로 나눕니다. 참여율·노방 시간대별 효율은 분류2 조회와 별도로 기간·구역·반·직업구분을 적용합니다.",
  );
  if (from && to && stamp(to) - stamp(from) > 365 * DAY)
    result.notes.push(
      "조회 기간이 366일을 넘어 일자별 표에는 기록이 있는 날짜만 표시합니다.",
    );
  return result;
}
function addDistrictOverviewSheets(workbook, result) {
  const change = workbook.addWorksheet("구역별 찾기 분석");
  const before = result.comparison;
  change.addRow(["구역", "조회 기간 찾기", "현재 비중", ...(before ? ["직전 기간 찾기", "증감"] : [])]);
  for (const row of result.districtOverview.findingChange) {
    change.addRow([row.region, row.current, row.share, ...(before ? [row.previous, row.delta] : [])]);
  }
  change.addRow(["조회 합계", result.totals.findings, result.totals.findings ? 1 : null,
    ...(before ? [before.findings, before.findingsDelta] : [])]);
  change.getColumn(3).numFmt = "0.0%";
  change.addRow([]);
  change.addRow(["조회 기간", result.from || "전체 시작", result.to || "전체 종료"]);
  if (before) change.addRow(["직전 기간", before.from, before.to]);
  const participation = workbook.addWorksheet("노방·소셜링 참여율"),
    hourly = workbook.addWorksheet("노방 시간대별 효율"),
    groups = [
      { label: "조회 전체", districtOverview: result.districtOverview },
      ...result.rows,
    ];
  participation.addRow([
    "구역",
    "명부 인원",
    "노방 참여자",
    "노방 참여율",
    "소셜링 참여자",
    "소셜링 참여율",
    "합산 참여자",
    "합산 참여율",
    "명부 범위 외 참여자",
    "활동자 미입력 기록",
  ]);
  hourly.addRow([
    "구역",
    "시간대",
    "활동자 수",
    "순활동(분)",
    "찾기 건수",
    "활동시간 내 찾기",
    "시간당 찾기",
  ]);
  for (const { label, districtOverview } of groups) {
    const { street, club, combined } = districtOverview.participation;
    participation.addRow([
      label,
      combined.members,
      street.workers,
      street.rate,
      club.workers,
      club.rate,
      combined.workers,
      combined.rate,
      combined.externalWorkers,
      combined.unassignedRecords,
    ]);
    for (const hour of districtOverview.streetMetrics.hours)
      hourly.addRow([
        label,
        hour.label,
        hour.workers,
        hour.minutes,
        hour.findings,
        hour.matchedFindings,
        hour.perPersonHour,
      ]);
  }
  for (const column of [4, 6, 8]) participation.getColumn(column).numFmt = "0.0%";
  hourly.getColumn(7).numFmt = "0.00";
}
async function workbook(result) {
  const E = require("exceljs"),
    w = new E.Workbook();
  const classData = result.kind === "classData";
  const employmentData = result.kind === "employmentData";
  const identityHeaders = employmentData ? ["이름", "직업구분", "소속 구역"] : [classData ? "반" : "구분"];
  const identityValues = (row) => employmentData
    ? [row.label, row.employmentLabel, row.region]
    : [row.label || row.name];
  const detailOffset = identityHeaders.length - 1;
  const overviewOffset = employmentData ? 1 : 0;
  const classComparison = classData && result.comparison;
  const title = {
    regionData: "구역별 데이터",
    memberData: "개인별 데이터",
    classData: "반별 데이터",
    dailyData: "일자별 데이터",
    employmentData: "전일자·직업별 데이터",
  }[result.kind];
  const sheetTitle = {
    regionData: "구역별 현황",
    memberData: "개인별 현황",
    classData: "반별 현황",
    dailyData: "일자별 현황",
    employmentData: "전일자·직업별 현황",
  }[result.kind];
  w.creator = "SMOA";
  const intro = w.addWorksheet("집계 기준");
  intro.addRows([
    [title],
    [
      `${result.from || "전체"} ~ ${result.to || "전체"} / ${result.region || "전체 구역"}`,
    ],
    [
      `분류2: ${C.label(result.classification2)} · 활동시간·효율은 노방에서만 표시`,
    ],
    [
      "찾기: 대상자당 1건, 인도자 ID 우선. 단계향상률: 조회 기간 내 출발 단계에 처음 도달한 사람 중 이후 도착 단계에 도달한 비율. 기간 종료 뒤에 기록된 도달도 포함합니다.",
    ],
    [
      "효율: 본인의 같은 구역 활동시간 내 찾기 / 실제 활동 인시간. 00분 보고는 활동 시작·종료 시 시간대에 연결하고 분이 입력된 찾기는 실제 시각으로 연결. 활동시간 합계는 실제 분을 사용.",
    ],
    [
      "활동자와 인도자 미입력·동명이인·기록 누락에 주의. 구간 상세의 원기록은 겹칠 수 있으나 합계 시간은 중복 제거함.",
    ],
  ]);
  for (const note of result.notes || []) intro.addRow([note]);
  const selectedClassLabel = result.selectedClass === C.UNCLASSIFIED ? "미입력"
    : result.classes?.find((item) => item.value === result.selectedClass)?.label || result.selectedClass || "전체";
  intro.addRow([
    `반: ${selectedClassLabel} / 직업: ${result.employments?.find((x) => x.value === result.selectedEmployment)?.label || "전체"}`,
  ]);
  if (result.comparison)
    intro.addRow([
      `이전 동기간 ${result.comparison.from} ~ ${result.comparison.to}: 찾기 ${result.comparison.findings}건, 대비 증감 ${result.comparison.findingsDelta}건, 명부 활동자 ${result.comparison.workers}명`,
    ]);
  const hasBreakdowns = result.kind === "memberData" || classData;
  if (hasBreakdowns)
    intro.addRow(["장소별 시간대와 나이별 건수는 찾기와 같은 조회 조건으로 집계합니다. 나이는 대상자 기록에 저장된 값을 사용합니다."]);
  const s = w.addWorksheet(sheetTitle);
  s.addRow([
    ...(employmentData ? identityHeaders : [classData ? "반" : "구분", classData ? "조회 구역" : "구역"]),
    "활동일수",
    "순활동(분)",
    "찾기 건수",
    "활동시간 내 찾기",
    "시간당 찾기",
    "찾기시간 미입력",
    "활동시간 미입력",
    "명부 인원",
    "명부 참여자",
    "명부 참여율",
    "명부 범위 외 참여자",
    ...(result.stages || []).flatMap((x) => [
      `${x.label} 기간 실적`,
      `${x.label} 목표`,
      `${x.label} 달성률`,
    ]),
    ...(result.categories || []).map((x) => `${x.label} 찾기`),
    ...(classComparison ? ["이전 동기간 찾기", "이전 대비 찾기 증감"] : []),
  ]);
  for (const r of result.rows) {
    const m = r.metrics;
    s.addRow([
      ...(employmentData ? identityValues(r) : [r.label, classData ? r.region || "전체 구역" : r.region]),
      m.activityDays,
      m.minutes,
      m.findings,
      m.matchedFindings,
      m.perHour,
      m.unknownFindingTime,
      m.unknownActivityTime,
      r.participation?.members ?? null,
      r.participation?.workers ?? null,
      r.participation?.rate ?? null,
      r.participation?.externalWorkers ?? null,
      ...(r.stages || []).flatMap((x) => [x.actual, x.target, x.rate]),
      ...(r.categories || []).map((x) => x.count),
      ...(classComparison ? [r.comparison?.findings ?? null, r.comparison?.findingsDelta ?? null] : []),
    ]);
  }
  s.getColumn(7 + overviewOffset).numFmt = "0.00";
  s.getColumn(12 + overviewOffset).numFmt = "0.0%";
  for (let i = 16 + overviewOffset; i <= 13 + overviewOffset + (result.stages || []).length * 3; i += 3)
    s.getColumn(i).numFmt = "0.0%";
  const c = w.addWorksheet("단계 도달률");
  c.addRow([
    ...identityHeaders,
    "찾B 기준",
    ...result.cohort.stages.flatMap((s) => [
      `${s.fromLabel} → ${s.label} 기준`,
      `${s.fromLabel} → ${s.label} 향상`,
      `${s.fromLabel} → ${s.label} 향상률`,
    ]),
  ]);
  for (const r of result.rows)
    c.addRow([
      ...identityValues(r),
      r.cohort.count,
      ...r.cohort.stages.flatMap((s) => [s.baseCount, s.count, s.rate]),
    ]);
  for (const i of result.cohort.stages.keys())
    c.getColumn(identityHeaders.length + 4 + i * 3).numFmt = "0.0%";
  const chosen = result.detail ? [result.detail] : result.rows;
  const d = w.addWorksheet("일자별"),
    h = w.addWorksheet("시간대별"),
    placeHours = hasBreakdowns ? w.addWorksheet("장소별 시간대") : null,
    places = hasBreakdowns ? w.addWorksheet("장소별") : null,
    ages = hasBreakdowns ? w.addWorksheet("나이별") : null,
    a = w.addWorksheet("활동 구간");
  d.addRow([
    ...identityHeaders,
    "날짜",
    "순활동(분)",
    "찾기 건수",
    "활동시간 내 찾기",
    "시간당 찾기",
  ]);
  h.addRow([
    ...identityHeaders,
    "시간대",
    "활동자 수",
    "순활동(분)",
    "찾기 건수",
    "활동시간 내 찾기",
    "시간당 찾기",
  ]);
  placeHours?.addRow([...identityHeaders, "찾기 장소", "시간대", "찾기 건수"]);
  places?.addRow([...identityHeaders, "찾기 장소", "찾기 건수"]);
  ages?.addRow([...identityHeaders, "대상자 나이", "찾기 건수"]);
  if (ages) ages.getColumn(identityHeaders.length + 1).numFmt = '0"세"';
  a.addRow([employmentData ? "이름" : "구분", "구역", "시작", "종료", "원기록 시간(분)", ...(employmentData ? ["직업구분"] : [])]);
  for (const r of chosen) {
    const identity = identityValues(r);
    for (const x of r.metrics.days)
      d.addRow([
        ...identity,
        x.date,
        x.minutes,
        x.findings,
        x.matchedFindings,
        x.perHour,
      ]);
    for (const x of r.metrics.hours)
      h.addRow([
        ...identity,
        x.label,
        x.workers,
        x.minutes,
        x.findings,
        x.matchedFindings,
        x.perPersonHour,
      ]);
    if (classData && r.metrics.unknownFindingTime)
      h.addRow([...identity, "시간 미입력", null, null, r.metrics.unknownFindingTime]);
    if (hasBreakdowns) {
      for (const place of r.metrics.findingPlaceHours) {
        places.addRow([...identity, place.label, place.findings]);
        for (const hour of place.hours)
          placeHours.addRow([...identity, place.label, hour.label, hour.findings]);
        if (place.unknownTime)
          placeHours.addRow([...identity, place.label, "시간 미입력", place.unknownTime]);
      }
      for (const entry of r.metrics.findingAges)
        ages.addRow([...identity, entry.age ?? entry.label, entry.findings]);
    }
    for (const x of r.metrics.intervals)
      a.addRow([
        x.name,
        x.region,
        x.start.replace("T", " "),
        x.end.replace("T", " "),
        x.minutes,
        ...(employmentData ? [r.employmentLabel] : []),
      ]);
  }
  d.getColumn(6 + detailOffset).numFmt = "0.00";
  h.getColumn(7 + detailOffset).numFmt = "0.00";
  if (result.activityAvailable === false) {
    for (const column of [9, 7, 6, 4, 3]) s.spliceColumns(column + overviewOffset, 1);
    for (const column of [6, 5, 3]) d.spliceColumns(column + detailOffset, 1);
    for (const column of [7, 6, 4, 3]) h.spliceColumns(column + detailOffset, 1);
    w.removeWorksheet(a.id);
  }
  if (result.districtOverview) addDistrictOverviewSheets(w, result);
  if (classData)
    for (const sheet of [placeHours, h, places, ages])
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: sheet.rowCount, column: sheet.columnCount },
      };
  for (const sheet of w.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns.forEach((col) => (col.width = 21));
    sheet.getRow(1).font = {
      name: "맑은 고딕",
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    sheet.getRow(1).eachCell(
      (cell) =>
        (cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF194B3B" },
        }),
    );
  }
  intro.getColumn(1).width = 115;
  return Buffer.from(await w.xlsx.writeBuffer());
}
module.exports = { summary, workbook, facts };
