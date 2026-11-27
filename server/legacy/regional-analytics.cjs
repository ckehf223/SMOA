"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  K = require("./codes.cjs"),
  G = require("./goals.cjs"),
  C = require("./classification-scope.cjs"),
  RegionalActivity = require("./regional-activity.cjs"),
  StageCohorts = require("./stage-cohort.cjs"),
  Milestones = require("./ui/person-milestones.js");
const DAY = 86400000,
  iso = (t) => new Date(t).toISOString().slice(0, 10),
  at = (d) => Date.parse(`${d}T00:00:00Z`),
  percent = (n, d) => (d > 0 ? (n / d) * 100 : null),
  normalized = (s) =>
    String(s || "")
      .replace(/\s/g, "")
      .toLowerCase();
const employmentOf = (ws, value) =>
  !value || K.label(ws, "employment", value) === "미입력"
    ? "미입력"
    : K.find(ws, "employment", value)?.value || value;
function dates(from, to) {
  const out = [];
  for (let d = at(from); d <= at(to); d += DAY) out.push(iso(d));
  return out;
}
function monthRange(anchor, offset = 0) {
  const start = new Date(at(anchor));
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() + offset);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { from: iso(start), to: iso(end) };
}
function calendarRange(anchor, unit, weekStart = 0, offset = 0) {
  if (unit === "month") return monthRange(anchor, offset);
  const weekday = new Date(at(anchor)).getUTCDay();
  const start = at(anchor) + (offset * 7 - (weekday - weekStart + 7) % 7) * DAY;
  return { from: iso(start), to: iso(start + 6 * DAY) };
}
function merge(spans) {
  const out = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
function prepare(ws) {
  const org = O.get(ws),
    units = new Map(),
    members = new Map(),
    names = new Map();
  const unit = (id) => {
    if (!units.has(id)) {
      const chain = O.ancestors(org, id);
      units.set(id, {
        region: O.regionOf(org, id) || "구역 미입력",
        active: chain.every((n) => n.active),
      });
    }
    return units.get(id);
  };
  const roster = org.members.map((m) => ({
    ...m,
    region: unit(m.unitId).region,
    employment: employmentOf(ws, m.employment),
    currentActive: m.status === "active" && unit(m.unitId).active,
  }));
  for (const m of roster) {
    members.set(m.id, m);
    members.set(m.code, m);
    const key = normalized(m.name);
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(m);
  }
  const resolve = (a) => {
    let m = a.workerId ? members.get(a.workerId) : null;
    if (!a.workerId && a.worker) {
      const candidates = names.get(normalized(a.worker)) || [],
        local = candidates.filter((v) => v.region === a.region);
      if (local.length === 1) m = local[0];
      else if (candidates.length === 1) m = candidates[0];
    }
    const key = m
      ? `member:${m.id}`
      : a.workerId
        ? `external:${a.workerId}`
        : a.worker
          ? `name:${JSON.stringify([a.region || "", normalized(a.worker)])}`
          : "";
    return { member: m || null, key };
  };
  const activities = C.activities(ws).map((a) => ({ ...a, ...resolve(a) }));
  const people = new Map(ws.people.map((p) => [p.id, p])),
    fact = (r) => {
      const person = people.get(r.personId),
        introducer = members.get(person?.introducerId);
      return {
        ...r,
        region: r.region || "구역 미입력",
        classification2: C.person(person || {}),
        employment: employmentOf(
          ws,
          person?.introducerSnapshot?.employment || introducer?.employment,
        ),
      };
    };
  const findings = G.attainments(ws, "*").map(fact),
    knownCodes = new Set(ws.people.map((p) => p.code)),
    orphanCodes = new Set();
  for (const r of [...(ws.findingReports || [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    if (
      knownCodes.has(r.personCode) ||
      orphanCodes.has(r.personCode) ||
      !r.foundDate ||
      r.dateUnknown
    )
      continue;
    orphanCodes.add(r.personCode);
    findings.push({
      date: r.foundDate,
      region: r.region || "구역 미입력",
      className: r.className,
      reportedStage: r.stage,
      classification2: r.classification2 ?? "노방",
      employment: employmentOf(
        ws,
        r.employment || members.get(r.memberCode || r.memberId)?.employment,
      ),
    });
  }
  return {
    roster,
    activities,
    findings,
    stages: new Map(
      ws.stages.map((id) => [id, G.attainments(ws, id).map(fact)]),
    ),
  };
}
function trackedStages(ws, facts) {
  const findingId = ws.stages.find((id) =>
    [id, ws.stageNames[id]].some((value) => normalized(value) === "찾b"),
  );
  return [
    {
      id: findingId || "찾B",
      label: "찾B",
      finding: true,
      rows: [
        ...(facts.stages.get(findingId) || []),
        ...facts.findings.filter((entry) => entry.reportedStage && entry.reportedStage === findingId),
      ],
    },
    ...[["찾A", "findADate"], ["합B", "habBDate"]].map(([label, field]) => {
      const id = Milestones.stageId(ws, field);
      const rows = id
        ? facts.stages.get(id)
        : ws.people
            .filter((person) => person.stageDates?.[field])
            .map((person) => ({
              date: person.stageDates[field],
              className: person.className,
            }));
      return { id: id || label, label, rows };
    }),
  ];
}
function trackedSnapshot(stages, window, from, to) {
  return stages.map(({ id, label, rows, finding }) => {
    const entries = rows.filter((entry) => entry.date >= from && entry.date <= to);
    const detailAvailable = window.source === "detail" || entries.length > 0;
    return {
      id,
      label,
      source: detailAvailable ? "detail" : finding ? "reported" : null,
      entries: detailAvailable ? entries : null,
      actual: detailAvailable ? entries.length : finding ? window.totals.findings : null,
    };
  });
}
function districtFindings(window) {
  const counts = new Map();
  const reported = window.source === "reported";
  for (const row of reported ? window.reports : window.findings) {
    const region = row.region || "구역 미입력";
    counts.set(region, (counts.get(region) || 0) + (reported ? row.found : 1));
  }
  return counts;
}
function trackedCohorts(ws, snapshot, from, to) {
  const numbers = new Map();
  const classNumber = (value) => {
    if (!numbers.has(value)) {
      const code = K.find(ws, "className", value);
      const known = [value, code?.value, code?.label, ...(code?.aliases || [])]
        .map(normalized)
        .find((label) => /^[123]반?$/.test(label));
      numbers.set(value, known?.[0]);
    }
    return numbers.get(value);
  };
  const { overall, groups } = StageCohorts.measure(ws, {
    from,
    to,
    // Unassigned and other classes still contribute to the whole-region cohort.
    classify: ({ className }) => classNumber(className),
    includeReports: true,
  });
  // 반 이름(N반)과 실제 반 코드 값은 다를 수 있다. 상세 이동은 코드 값으로 한다.
  const classValueOf = (number) => {
    const code = (K.group(ws, "className")?.items || []).find((item) =>
      [item.value, item.label, ...(item.aliases || [])]
        .map(normalized)
        .some((name) => name === number || name === `${number}반`),
    );
    return code?.value ?? number;
  };
  const classCounts = ["1", "2", "3"].map((number) => {
    const cohortStages = groups.get(number)?.stages || [];
    const conversions = snapshot.slice(1).map((destination, index) => {
      const source = snapshot[index];
      const match = cohortStages.find(({ fromId, id }) =>
        normalized(fromId) === normalized(source.id) &&
        normalized(id) === normalized(destination.id),
      );
      const { count = 0, baseCount = 0 } = match || {};
      return {
        from: source.label,
        to: destination.label,
        count,
        baseCount,
        rate: percent(count, baseCount),
      };
    });
    return {
      label: `${number}반`,
      value: classValueOf(number),
      stages: snapshot.map(({ id, label, entries }) => ({
        id,
        label,
        count: entries
          ? entries.filter(({ className }) => classNumber(className) === number).length
          : null,
      })),
      conversions,
    };
  });
  const [finding, findA, habB] = snapshot.map((stage) => stage.id);
  const manpik = Milestones.stageId(ws, "manpikDate") || "만픽";
  const pairs = [[finding, manpik], [manpik, findA], [finding, findA], [findA, habB]];
  const regionalCohorts = pairs.flatMap(([from, to]) => {
    const stage = overall.stages.find((s) => normalized(s.fromId) === normalized(from) &&
      normalized(s.id) === normalized(to));
    return stage ? [{
      from: stage.fromLabel, to: stage.label, count: stage.count,
      baseCount: stage.baseCount, rate: percent(stage.count, stage.baseCount),
    }] : [];
  });
  return { classCounts, regionalCohorts };
}
function touches(a, from, to) {
  const duration = a.start && a.end && M.minutes(a.start, a.end);
  if (!duration) return a.date >= from && a.date <= to;
  const start = Date.parse(`${a.date}T${a.start}:00Z`),
    end = start + duration * 60000;
  return end > at(from) && start < at(to) + DAY;
}
function streetTime(activities, from, to) {
  const spans = new Map(),
    low = at(from),
    high = at(to) + DAY;
  let unknownTimeCount = 0,
    unassignedTimeCount = 0;
  for (const a of activities) {
    if (C.activity(a) !== "노방") continue;
    if (!a.start || !a.end || !M.minutes(a.start, a.end)) {
      if (a.date >= from && a.date <= to) unknownTimeCount++;
      continue;
    }
    const start = at(a.date) + M.minutes("00:00", a.start) * 60000,
      end = start + M.minutes(a.start, a.end) * 60000,
      clipped = { start: Math.max(low, start), end: Math.min(high, end) };
    if (clipped.start >= clipped.end) continue;
    if (!a.key) {
      unassignedTimeCount++;
      continue;
    }
    if (!spans.has(a.key)) spans.set(a.key, []);
    spans.get(a.key).push(clipped);
  }
  const daily = new Map();
  let minutes = 0;
  for (const entries of spans.values())
    for (const s of merge(entries)) {
      minutes += (s.end - s.start) / 60000;
      for (let t = s.start; t < s.end;) {
        const next = Math.min(s.end, Math.floor(t / DAY) * DAY + DAY),
          d = iso(t);
        daily.set(d, (daily.get(d) || 0) + (next - t) / 60000);
        t = next;
      }
    }
  return { minutes, daily, unknownTimeCount, unassignedTimeCount };
}
function participationByClassification(groups, members) {
  return Array.from(groups, ([classification2, ids]) => {
    const workers = members.filter((member) => ids.has(member.id)).length;
    return { classification2, workers, rate: percent(workers, members.length) };
  });
}
function windowData(ws, facts, from, to, requestedSource = "auto") {
  const inDate = (r) => r.date >= from && r.date <= to,
    findings = facts.findings.filter(inDate),
    reports = (ws.dailyReports || []).filter(inDate),
    source =
      requestedSource === "auto"
        ? !findings.length && reports.length
          ? "reported"
          : "detail"
        : requestedSource,
    activities = facts.activities.filter((a) => touches(a, from, to)),
    active = new Set(),
    activeByClassification = new Map(
      M.PERSON_CLASSIFICATIONS.classification2.map((value) => [
        value,
        new Set(),
      ]),
    ),
    external = new Set(),
    inactive = new Set();
  let unknownActivityCount = 0;
  for (const a of activities) {
    if (a.member?.currentActive) {
      active.add(a.member.id);
      const category = C.activity(a) || C.UNCLASSIFIED;
      if (!activeByClassification.has(category)) activeByClassification.set(category, new Set());
      activeByClassification.get(category).add(a.member.id);
    } else if (a.member) inactive.add(a.member.id);
    else if (a.key) external.add(a.key);
    else unknownActivityCount++;
  }
  const members = facts.roster.filter((m) => m.currentActive),
    activityParticipation = participationByClassification(
      activeByClassification,
      members,
    ),
    street = activityParticipation.find(
      (entry) => entry.classification2 === "노방",
    ),
    time = streetTime(facts.activities, from, to);
  return {
    source,
    findings,
    reports,
    activities,
    active,
    activeByClassification,
    external,
    inactive,
    members,
    time,
    totals: {
      members: members.length,
      workers: active.size,
      participationRate: percent(active.size, members.length),
      activityParticipation,
      streetWorkers: street.workers,
      streetParticipationRate: street.rate,
      externalWorkers: external.size,
      inactiveWorkers: inactive.size,
      unknownActivityCount,
      findings:
        source === "reported"
          ? reports.reduce((n, r) => n + r.found, 0)
          : findings.length,
      streetMinutes: time.minutes,
      streetUnknownTimeCount: time.unknownTimeCount,
      streetUnassignedTimeCount: time.unassignedTimeCount,
      activityCount: activities.length,
    },
  };
}
function regionalSummary(ws, input = {}) {
  const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    periodUnit = input.periodUnit || input.dashboardPeriod || "week",
    anchor = M.date(input.from || input.to || today),
    weekStart =
      Number.isInteger(input.weekStart) &&
      input.weekStart >= 0 &&
      input.weekStart <= 6
        ? input.weekStart
        : 0,
    defaultRange = calendarRange(anchor, periodUnit, weekStart),
    to = M.date(input.to || defaultRange.to),
    from = M.date(input.from || defaultRange.from),
    requestedSource = input.dashboardSource || "auto";
  M.assert(
    ["week", "month", "custom"].includes(periodUnit),
    "조회 기간 단위를 확인하세요.",
  );
  M.assert(
    ["auto", "detail", "reported"].includes(requestedSource),
    "실적 자료원을 확인하세요.",
  );
  M.assert(
    from <= to && at(to) - at(from) < 3660 * DAY,
    "조회 기간은 10년 이내로 지정해 주세요.",
  );
  const facts = prepare(ws),
    current = windowData(ws, facts, from, to, requestedSource),
    days = dates(from, to),
    { from: beforeFrom, to: beforeTo } =
      periodUnit === "month"
        ? monthRange(from, -1)
        : {
            from: iso(at(from) - (periodUnit === "week" ? 7 : days.length) * DAY),
            to: iso(at(from) - DAY),
          },
    before = windowData(ws, facts, beforeFrom, beforeTo, requestedSource),
    currentFindings = districtFindings(current),
    beforeFindings = districtFindings(before),
    tracked = trackedStages(ws, facts),
    currentTracked = trackedSnapshot(tracked, current, from, to),
    priorTracked = trackedSnapshot(tracked, before, beforeFrom, beforeTo),
    exactGoals = ws.goals.filter(
      (g) => !g.className && g.from === from && g.to === to,
    ),
    allRegions = new Set([
      ...facts.roster.map((m) => m.region),
      ...current.findings.map((r) => r.region),
      ...current.reports.map((r) => r.region || "구역 미입력"),
      ...current.activities.map((r) => r.region || "구역 미입력"),
      ...exactGoals.map((g) => g.region),
    ]);
  for (const entries of facts.stages.values()) {
    for (const entry of entries) {
      if (entry.date >= from && entry.date <= to) allRegions.add(entry.region);
    }
  }
  for (const n of O.get(ws).nodes)
    if (n.active && (n.reportRegion || /구역/.test(n.type)))
      allRegions.add(O.regionOf(O.get(ws), n.id));
  allRegions.delete("");
  const stageSources = new Map(
    ws.stages.map((id) => [
      id,
      current.source === "reported" &&
      !facts.stages.get(id).some((r) => r.date >= from && r.date <= to)
        ? "reported"
        : "detail",
    ]),
  );
  const stageRows = (region) =>
    ws.stages.map((id) => {
      const goals = exactGoals.filter(
          (g) => (g.stageId || "*") === id && (!region || g.region === region),
        ),
        rows = facts.stages
          .get(id)
          .filter(
            (r) =>
              r.date >= from &&
              r.date <= to &&
              (!region || r.region === region),
          ),
        actualFor = (name) => {
          if (stageSources.get(id) !== "reported")
            return rows.filter((r) => !name || r.region === name).length;
          if (id !== ws.stages[0] || !current.reports.length) return null;
          return name ? currentFindings.get(name) ?? null : current.totals.findings;
        },
        actual = actualFor(region),
        target = goals.length ? goals.reduce((n, g) => n + g.target, 0) : null,
        goalValues = goals.map((goal) => ({ target: goal.target, actual: actualFor(goal.region) })),
        comparedActual =
          actual === null || goalValues.some((g) => g.actual === null)
            ? null
            : goalValues.reduce((n, g) => n + g.actual, 0);
      return {
        id,
        label: M.stageName(ws, id),
        source: stageSources.get(id),
        actual,
        target,
        comparedActual,
        rate:
          comparedActual === null || target === null
            ? null
            : percent(comparedActual, target),
        shortfall:
          goals.length && comparedActual !== null
            ? goalValues.reduce(
                (n, g) => n + Math.max(0, g.target - g.actual),
                0,
              )
            : null,
        configured: goals.length,
        goalDistricts: goals.length,
      };
    });
  const stages = stageRows(),
    districts = [...allRegions]
      .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
      .map((region) => {
        const members = current.members.filter((m) => m.region === region),
          workers = members.filter((m) => current.active.has(m.id)).length,
          activityParticipation = participationByClassification(
            current.activeByClassification,
            members,
          ),
          street = activityParticipation.find(
            (entry) => entry.classification2 === "노방",
          ),
          acts = current.activities.filter(
            (a) => (a.region || "구역 미입력") === region,
          );
        return {
          region,
          members: members.length,
          workers,
          participationRate: percent(workers, members.length),
          activityParticipation,
          streetWorkers: street.workers,
          streetParticipationRate: street.rate,
          externalWorkers: new Set(
            acts.filter((a) => !a.member && a.key).map((a) => a.key),
          ).size,
          findings: currentFindings.get(region) || 0,
          stages: stageRows(region),
        };
      });
  const findingChanges = [...new Set([...currentFindings.keys(), ...beforeFindings.keys()])]
    .map((region) => {
      // A district without a submitted daily total has no observed value in reported mode.
      const actual = currentFindings.get(region) ?? (current.source === "detail" ? 0 : null);
      const previous = beforeFindings.get(region) ?? (before.source === "detail" ? 0 : null);
      const delta = current.source === before.source && actual !== null && previous !== null
        ? actual - previous
        : null;
      return { region, actual, previous, delta };
    })
    .sort((a, b) =>
      (Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)) ||
      ((b.actual ?? 0) - (a.actual ?? 0)) ||
      a.region.localeCompare(b.region, "ko", { numeric: true }),
    );
  const categories = [...M.PERSON_CLASSIFICATIONS.classification2, ""].map(
    (classification2) => {
      const count =
        current.source === "reported"
          ? null
          : current.findings.filter(
              (r) => r.classification2 === classification2,
            ).length;
      return {
        classification2: classification2 || C.UNCLASSIFIED,
        label: classification2 || "미입력",
        findings: count,
        share: count === null ? null : percent(count, current.totals.findings),
        stages: ws.stages.map((id) => ({
          id,
          label: M.stageName(ws, id),
          count:
            stageSources.get(id) === "reported"
              ? null
              : facts.stages
                  .get(id)
                  .filter(
                    (r) =>
                      r.date >= from &&
                      r.date <= to &&
                      r.classification2 === classification2,
                  ).length,
        })),
      };
    },
  );
  const daily = days.map((date) => {
    const ids = new Set(
      current.activities
        .filter((a) => touches(a, date, date) && a.member?.currentActive)
        .map((a) => a.member.id),
    );
    return {
      date,
      findings:
        current.source === "reported"
          ? current.reports
              .filter((r) => r.date === date)
              .reduce((n, r) => n + r.found, 0)
          : current.findings.filter((r) => r.date === date).length,
      workers: ids.size,
      participationRate: percent(ids.size, current.totals.members),
      streetMinutes: current.time.daily.get(date) || 0,
      stages: Object.fromEntries(
        ws.stages.map((id) => [
          id,
          stageSources.get(id) === "reported"
            ? id === ws.stages[0]
              ? current.reports
                  .filter((r) => r.date === date)
                  .reduce((n, r) => n + r.found, 0)
              : null
            : facts.stages.get(id).filter((r) => r.date === date).length,
        ]),
      ),
    };
  });
  const periods = [];
  for (let i = 5; i >= 0; i--) {
    let start, end;
    if (i === 0) {
      start = from;
      end = to;
    } else if (periodUnit === "month") {
      ({ from: start, to: end } = monthRange(from, -i));
    } else {
      start = iso(at(from) - i * 7 * DAY);
      end = iso(at(start) + 6 * DAY);
    }
    const r = windowData(ws, facts, start, end, requestedSource);
    periods.push({
      from: start,
      to: end,
      label:
        periodUnit === "month"
          ? start.slice(0, 7)
          : `${start.slice(5)} ~ ${end.slice(5)}`,
      source: r.source,
      ...r.totals,
      stages: Object.fromEntries(
        trackedSnapshot(tracked, r, start, end).map(({ id, actual }) => [id, actual]),
      ),
    });
  }
  const employmentValues = [
    ...new Set(
      [
        "전일자",
        "반일자",
        "직장인",
        "미입력",
        ...current.members.map((m) => m.employment || "미입력"),
        ...current.findings.map((r) => r.employment),
      ].map((v) => employmentOf(ws, v)),
    ),
  ];
  const employments = employmentValues.map((employment) => {
    const members = current.members.filter(
        (m) => (m.employment || "미입력") === employment,
      ),
      workers = members.filter((m) => current.active.has(m.id)).length;
    return {
      employment,
      label: K.label(ws, "employment", employment),
      members: members.length,
      workers,
      participationRate: percent(workers, members.length),
      findings:
        current.source === "reported"
          ? null
          : current.findings.filter((r) => r.employment === employment).length,
    };
  });
  const notes = [
    "지역원 수는 현재 명부의 활동 중 구성원 수입니다. 과거 시점의 명부 인원은 보관되지 않아 현재 명부를 공통 기준으로 비교합니다.",
    "활동자는 조회 기간에 활동 기록이 있는 현재 명부 구성원의 중복 없는 인원입니다. 모든 분류2의 활동을 포함하고, 명부 미연결·비활성 구성원은 참여율에서 제외해 따로 표시합니다. 자정을 넘는 활동은 실제 겹치는 날짜에도 포함합니다.",
    "분류별 활동자율은 조회 기간에 해당 분류로 활동을 기록한 현재 명부 구성원의 고유 인원을 현재 지역원 수로 나눕니다. 같은 사람이 여러 분류에서 활동하면 각 분류에 한 번씩 포함합니다.",
    "구역별 참여 인원은 현재 소속 기준, 찾기·단계 실적은 기록 당시 구역 기준입니다. 찾기는 찾은날짜, 단계별 실적은 최초 도달일 기준이며 유지·반복 도달은 제외합니다.",
    "달성률은 조회 시작일·종료일이 정확히 일치하는 구역 목표가 있는 구역의 실적만 비교합니다. 미설정 목표는 0으로 추정하지 않으며 다른 기간의 목표를 나누어 계산하지 않습니다.",
    "활동시간은 노방 기록만 포함하며 같은 활동자의 겹치는 시간은 한 번만 계산합니다. 시간 또는 활동자 정보가 없는 기록은 시간 합산에서 제외합니다.",
    "주별 증감은 전주, 월별 증감은 전월과 비교합니다. 최근 추이는 선택한 주 시작일 또는 달력 월을 기준으로 표시합니다. 전일자 등 구분별 찾기는 인도자의 기록 당시 직업 구분이 있으면 우선 사용합니다.",
  ];
  if (current.source === "reported")
    notes.unshift(
      "해당 기간 상세 찾기 기록이 없어 찾기 합계는 구역 일계로 집계했습니다. 분류별 찾기는 미확인이며, 단계별 실적은 별도 상세 도달 기록이 있으면 해당 기록을 우선 사용합니다. 후속 단계의 상세 도달 기록도 없으면 미확인으로 표시합니다.",
    );
  if (current.source === "detail" && current.reports.length) {
    const reportRegions = [
        ...new Set(current.reports.map((r) => r.region || "구역 미입력")),
      ],
      missing = reportRegions.filter(
        (region) => !current.findings.some((r) => r.region === region),
      );
    notes.unshift(
      `동일 기간 구역 일계 ${current.reports.length}행(${current.reports.reduce((n, r) => n + r.found, 0)}건)이 함께 있습니다. 중복 방지를 위해 현재 합계는 상세 기록만 사용합니다.${missing.length ? ` 상세 찾기 기록이 없는 일계 구역: ${missing.join(", ")}.` : ""} 일계와 상세 기록의 입력 범위를 확인해 주세요.`,
    );
  }
  if (before.source !== current.source)
    notes.push(
      "비교 기간과 현재 기간의 자료원이 다릅니다. 구역 일계와 상세 기록의 작성 범위를 확인해 증감을 해석해 주세요.",
    );
  return {
    from,
    to,
    periodUnit,
    source: current.source,
    totals: current.totals,
    stages,
    goalStages: stages.filter(({ id, label }) =>
      ![id, label].some((value) =>
        ["콜링", "새단계13"].includes(normalized(value)),
      ),
    ),
    stageCounts: currentTracked.map(({ id, label, actual, source }, index) => ({
      id,
      label,
      actual,
      source,
      previousSource: priorTracked[index].source,
      previous: priorTracked[index].actual,
    })),
    ...trackedCohorts(ws, currentTracked, from, to),
    employmentShares: ["전일자", "반일자"].map((id) => {
      const code = employmentOf(ws, id);
      const members = current.members.filter(({ employment }) =>
        employment === code ||
        [employment, K.label(ws, "employment", employment)].some(
          (value) => normalized(value) === id,
        ),
      ).length;
      return { id, members, rate: percent(members, current.members.length) };
    }),
    regionalActivity: RegionalActivity.comparePeriods(
      ws,
      { from, to },
      { from: beforeFrom, to: beforeTo },
      current.members.map(({ id: memberId }) => ({ memberId })),
      periodUnit === "month",
    ),
    districts,
    findingChanges,
    categories,
    employments,
    daily,
    periods,
    notes,
    reportedCoverage: {
      rows: current.reports.length,
      findings: current.reports.reduce((n, r) => n + r.found, 0),
      usedInTotal: current.source === "reported",
    },
    comparison: {
      from: beforeFrom,
      to: beforeTo,
      source: before.source,
      ...before.totals,
      findingsDelta: current.totals.findings - before.totals.findings,
      workersDelta: current.totals.workers - before.totals.workers,
      streetWorkersDelta:
        current.totals.streetWorkers - before.totals.streetWorkers,
      streetParticipationDelta:
        current.totals.streetParticipationRate === null ||
        before.totals.streetParticipationRate === null
          ? null
          : current.totals.streetParticipationRate -
            before.totals.streetParticipationRate,
      participationDelta:
        current.totals.participationRate === null ||
        before.totals.participationRate === null
          ? null
          : current.totals.participationRate - before.totals.participationRate,
    },
  };
}
module.exports = { regionalSummary, calendarRange };
