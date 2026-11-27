"use strict";

const Model = require("./model.cjs");
const Organization = require("./organization.cjs");
const Codes = require("./codes.cjs");
const Classification = require("./classification-scope.cjs");
const Goals = require("./goals.cjs");
const Performance = require("./performance.cjs");
const Milestones = require("./ui/person-milestones.js");
const { calendarRange } = require("./regional-analytics.cjs");

const MISSING_DISTRICT = "구역 미입력";
const MISSING_CLASS = Classification.UNCLASSIFIED;
const dayMs = 86400000;
const compare = new Intl.Collator("ko", { numeric: true }).compare;
const koreanDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
});
const normalize = (value) => String(value || "").normalize("NFC").replace(/\s/g, "").toLowerCase();
const stamp = (day, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const shiftDay = (day, days) => new Date(stamp(day) + days * dayMs).toISOString().slice(0, 10);
const percent = (count, base) => count !== null && base > 0 ? count / base * 100 : null;
const districtKey = (region) => region || MISSING_DISTRICT;
const equivalentStages = {
  youngTtaDate: ["따기"],
  bokshinDate: ["복C"],
  cardReceivedDate: ["수강신청서", "수신서"],
};

function readOptions(input) {
  const asOf = Model.date(input.asOf || koreanDate.format(new Date()));
  const weekStart = input.weekStart ?? 0;
  Model.assert(Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6, "주 시작일을 확인해 주세요.");
  const from = input.from !== undefined
    ? Model.date(input.from, false)
    : calendarRange(asOf, "week", weekStart).from;
  const to = input.to !== undefined ? Model.date(input.to, false) : asOf;
  const trendEnd = Model.date(input.trendEnd || input.trendAnchor || asOf);
  const source = input.source || "auto";
  Model.assert(!from || !to || from <= to, "조회 기간의 시작일과 종료일을 확인해 주세요.");
  Model.assert(["auto", "detail", "reported"].includes(source), "자료원을 확인해 주세요.");
  Model.assert(trendEnd <= asOf, "오늘까지의 주별 추이를 선택해 주세요.");
  return {
    from, to, asOf, weekStart, trendEnd, source, includeCurrent: input.includeCurrent === true,
    region: Model.text(input.region || "", 100),
    statsClass: Model.text(input.statsClass || "", 100),
    classification: Classification.filter(input.statsClassification2 ?? ""),
  };
}

function stagesFor(ws) {
  const definitions = [
    { key: "finding", label: "찾B", names: ["찾B"] },
    ...Milestones.fields.map(({ field, stage, aliases = [] }) => ({
      key: field, label: field === "habADate" ? "합A" : stage.replace("합 ", "합"),
      names: [stage, ...aliases, ...(equivalentStages[field] || [])],
    })),
  ];
  return definitions.map(({ key, label, names }) => {
    const ids = names.flatMap((name) => ws.stages.filter((id) =>
      [id, ws.stageNames[id]].some((value) => normalize(value) === normalize(name)),
    ));
    const configured = key === "finding" || ids.length > 0 || ws.people.some((person) => person.stageDates?.[key]);
    return { key, id: ids[0] || label, label, configured, ids: [...new Set(ids)] };
  });
}

function* stageArrivals(ws, stages = stagesFor(ws), findings = Performance.facts(ws).findings) {
  const people = new Map(ws.people.map((person) => [person.id, person]));
  const findingById = new Map(findings.filter(({ person }) => person).map((finding) => [finding.person.id, finding]));
  for (const [index, stage] of stages.entries()) {
    if (!stage.configured) continue;
    const attained = new Map();
    for (const id of index === 0 ? ["*"] : stage.ids) {
      for (const entry of Goals.attainments(ws, id)) {
        const prior = attained.get(entry.personId);
        if (!prior || prior.date > entry.date) attained.set(entry.personId, entry);
      }
    }
    if (index > 0) {
      for (const person of ws.people) {
        const date = person.stageDates?.[stage.key];
        const current = attained.get(person.id);
        if (!date || current?.date === date) continue;
        const event = person.transitions.find((entry) => stage.ids.includes(entry.to) &&
          entry.effectiveLocal.slice(0, 10) === date && !entry.baseline);
        attained.set(person.id, {
          date, personId: person.id, region: event?.region ?? person.region,
          className: event?.className ?? person.className,
        });
      }
    }
    for (const entry of attained.values()) {
      const finding = findingById.get(entry.personId);
      const person = people.get(entry.personId);
      yield {
        ...entry, index, key: stage.key, name: person.name, personCode: person.code,
        workerKey: finding?.worker?.key,
        classification2: Classification.person(person),
      };
    }
    if (index !== 0) continue;
    for (const finding of findings) {
      if (!finding.person) yield {
        date: finding.date, region: finding.region, className: finding.className, index,
        key: stage.key, name: finding.name, personId: null, personCode: finding.code,
        workerKey: finding.worker?.key,
        classification2: finding.classification2,
      };
    }
  }
}

function prepare(ws, options) {
  const stages = stagesFor(ws);
  const classCodes = new Map();
  const classes = new Map();
  for (const item of Codes.group(ws, "className")?.items || []) {
    for (const value of [item.value, item.label, ...item.aliases]) classCodes.set(value, item.value);
    if (item.active) classes.set(item.value, true);
  }
  const classKey = (value) => {
    const legacyNumber = /^(\d+)\s*반$/.exec(value || "")?.[1];
    return classCodes.get(value) || (legacyNumber && classCodes.get(legacyNumber)) || value || MISSING_CLASS;
  };
  const classLabel = (key) => {
    if (key === MISSING_CLASS) return "반 미입력";
    const label = Codes.label(ws, "className", key) || key;
    return /^\d+$/.test(label) ? `${label}반` : label;
  };
  const groupFor = (region, className) => ({ district: districtKey(region), className: classKey(className) });
  const org = Organization.get(ws);
  const districts = new Map();
  for (const node of org.nodes) {
    if (!(node.reportRegion || /구역/.test(node.type))) continue;
    if (!Organization.ancestors(org, node.id).every((parent) => parent.active)) continue;
    const region = Organization.regionOf(org, node.id);
    if (region) districts.set(region, true);
  }
  const roster = new Map();
  for (const member of org.members) {
    if (member.status !== "active" || !Organization.ancestors(org, member.unitId).every((node) => node.active)) continue;
    const row = groupFor(Organization.regionOf(org, member.unitId), member.className);
    roster.set(`member:${member.code}`, row);
  }
  const { findings, activities } = Performance.facts(ws);
  const stageIndex = new Map(stages.flatMap((stage, index) => stage.ids.map((id) => [id, index])));
  const inClassification = (value) => Classification.matches(value, options.classification);
  const arrivals = [];
  for (const entry of stageArrivals(ws, stages, findings)) {
    if (!inClassification(entry.classification2)) continue;
    arrivals.push({ ...groupFor(entry.region, entry.className), index: entry.index, date: entry.date, name: entry.name });
  }
  const activityRows = activities.flatMap((activity) => {
    if (activity.worker.key === "unassigned" || !inClassification(activity.classification2)) return [];
    const duration = Model.minutes(activity.start, activity.end);
    const lastDate = duration && activity.end && activity.end < activity.start && activity.end !== "00:00"
      ? shiftDay(activity.date, 1)
      : activity.date;
    return [{ ...groupFor(activity.region, activity.className), date: activity.date, lastDate, key: activity.worker.key }];
  });
  const reports = ws.dailyReports || [];
  const people = ws.people.filter((person) => inClassification(Classification.person(person)));
  const rememberDistrict = (key) => {
    if (!districts.has(key)) districts.set(key, false);
  };
  for (const records of [arrivals, activityRows, roster.values()]) {
    for (const record of records) rememberDistrict(record.district);
  }
  for (const report of reports) rememberDistrict(districtKey(report.region));
  for (const person of people) {
    rememberDistrict(districtKey(person.region));
    for (const event of person.transitions) rememberDistrict(districtKey(event.region ?? person.region));
  }
  if (options.region) rememberDistrict(options.region);
  return {
    stages, stageIndex, arrivals, activityRows, roster, classKey, classLabel, districts, classes, people, reports,
  };
}

function createBucket(stages) {
  return {
    counts: stages.map(() => 0), holdings: stages.map(() => 0), workers: new Set(),
    members: 0, held: 0, reportedFound: 0, reportedDays: 0,
  };
}

function windowData(facts, options, range, weekly = false) {
  const { stages } = facts;
  const selectedClass = options.statsClass ? facts.classKey(options.statsClass) : "";
  const matchesRegion = (key) => !options.region || key === options.region;
  const matchesClass = (key) => !selectedClass || key === selectedClass;
  const total = createBucket(stages);
  const districtBuckets = new Map([...facts.districts.keys()].map((key) => [key, createBucket(stages)]));
  const classBuckets = new Map([...facts.classes.keys()].map((key) => [key, createBucket(stages)]));
  function get(buckets, key) {
    if (!buckets.has(key)) buckets.set(key, createBucket(stages));
    return buckets.get(key);
  }
  function visit(row, add) {
    if (matchesRegion(row.district) && matchesClass(row.className)) add(total);
    if (matchesClass(row.className)) add(get(districtBuckets, row.district));
    if (matchesRegion(row.district)) add(get(classBuckets, row.className));
  }
  const beforeEnd = (date) => !range.to || date <= range.to;
  const afterStart = (date) => !range.from || date >= range.from;
  for (const member of facts.roster.values()) visit(member, (bucket) => bucket.members++);
  for (const entry of facts.arrivals) {
    if (beforeEnd(entry.date) && afterStart(entry.date)) visit(entry, (bucket) => bucket.counts[entry.index]++);
  }
  for (const activity of facts.activityRows) {
    if (beforeEnd(activity.date) && afterStart(activity.lastDate)) visit(activity, (bucket) => bucket.workers.add(activity.key));
  }
  const canReport = !options.classification && !selectedClass;
  if (canReport) {
    for (const report of facts.reports) {
      if (!beforeEnd(report.date) || !afterStart(report.date)) continue;
      const key = districtKey(report.region);
      const district = get(districtBuckets, key);
      district.reportedFound += report.found;
      district.reportedDays++;
      if (matchesRegion(key)) {
        total.reportedFound += report.found;
        total.reportedDays++;
      }
    }
  }
  // Use the whole workspace to establish the source before showing a single district.
  const hasStageArrivals = [...districtBuckets.values()].some((bucket) => bucket.counts.some(Boolean));
  const hasReports = [...districtBuckets.values()].some((bucket) => bucket.reportedDays > 0);
  const source = options.source === "auto" ? (!hasStageArrivals && hasReports ? "reported" : "detail") : options.source;
  return { ...range, total, districtBuckets, classBuckets, visit, source, weekly };
}

function addHoldings(facts, windows) {
  const ordered = [...windows].sort((a, b) => a.to.localeCompare(b.to));
  for (const person of facts.people) {
    const transitions = [...person.transitions].filter((event) => event.from !== event.to)
      .sort((a, b) => a.effectiveLocal.localeCompare(b.effectiveLocal));
    if (!transitions.length) continue;
    const lifecycle = [...(person.lifecycle || [])].sort((a, b) => a.effectiveLocal.localeCompare(b.effectiveLocal));
    let transitionIndex = 0;
    let lifecycleIndex = 0;
    for (const window of ordered) {
      while (transitions[transitionIndex]?.effectiveLocal.slice(0, 10) <= window.to) transitionIndex++;
      while (lifecycle[lifecycleIndex]?.effectiveLocal.slice(0, 10) <= window.to) lifecycleIndex++;
      if (!transitionIndex || lifecycle[lifecycleIndex - 1]?.to === "dropped") continue;
      const transition = transitions[transitionIndex - 1];
      const index = facts.stageIndex.get(transition.to);
      const row = {
        district: districtKey(transition.region ?? person.region),
        className: facts.classKey(transition.className ?? person.className),
      };
      window.visit(row, (bucket) => {
        bucket.held++;
        if (index !== undefined) bucket.holdings[index]++;
      });
    }
  }
}

function makeRow(key, label, bucket, window, stages, grouping) {
  const { source, weekly } = window;
  // A district with only summary reporting has no evidence of zero detail-stage arrivals.
  const onlyReported = grouping !== "class" && bucket.reportedDays > 0 && !bucket.counts.some(Boolean);
  const hasDetail = source === "detail" && !onlyReported;
  const hasReported = source === "reported" && grouping !== "class" && bucket.reportedDays > 0;
  const actual = stages.map(({ configured }, index) => {
    if (index === 0 && hasReported) return bucket.reportedFound;
    return configured && hasDetail ? bucket.counts[index] : null;
  });
  const row = {
    key, label, members: bucket.members, workers: bucket.workers.size,
    source: hasDetail ? "detail" : hasReported ? "reported" : null,
    stages: stages.map(({ key, id, label, configured, ids }, index) => ({
      key, id, label, configured, count: actual[index],
      rate: percent(actual[index], actual[index === 0 ? 0 : index - 1]),
      per100: percent(actual[index], bucket.workers.size),
      average: null, deviation: null,
      ...(weekly && { stock: ids.length && (hasDetail || bucket.held > 0) ? bucket.holdings[index] : null }),
    })),
  };
  return row;
}

function benchmark(rows, stages, missing) {
  return stages.map(({ key, id, label }, index) => {
    const withCounts = rows.filter((row) => row.benchmarkEligible && row.key !== missing && row.stages[index].count !== null);
    const actual = withCounts.reduce((sum, row) => sum + row.stages[index].count, 0);
    const withWorkers = withCounts.filter((row) => row.workers > 0);
    const comparable = withWorkers.reduce((sum, row) => sum + row.stages[index].count, 0);
    const workers = withWorkers.reduce((sum, row) => sum + row.workers, 0);
    const average = withCounts.length ? actual / withCounts.length : null;
    for (const row of rows) {
      const stage = row.stages[index];
      stage.average = average;
      stage.deviation = row.benchmarkEligible && row.key !== missing && stage.count !== null && average > 0
        ? percent(stage.count - average, average)
        : null;
    }
    return { key, id, label, average, groups: withCounts.length, per100: percent(comparable, workers) };
  });
}

function rowsFor(facts, window, withBenchmarks) {
  const { stages } = facts;
  const total = makeRow("total", "전체", window.total, window, stages, "total");
  const eligible = (bucket, known) => !!(known || bucket.members || bucket.workers.size || bucket.reportedDays || bucket.counts.some(Boolean));
  const districts = [...window.districtBuckets.entries()].sort(([a], [b]) => compare(a, b))
    .map(([key, bucket]) => ({ ...makeRow(key, key, bucket, window, stages, "district"),
      benchmarkEligible: eligible(bucket, facts.districts.get(key)) }));
  if (!withBenchmarks) return { total, districts };
  const classes = [...window.classBuckets.entries()].sort(([a], [b]) => compare(a, b))
    .map(([key, bucket]) => ({ ...makeRow(key, facts.classLabel(key), bucket, window, stages, "class"),
      benchmarkEligible: eligible(bucket, facts.classes.get(key)) }));
  return {
    total, districts, classes,
    districtBenchmark: benchmark(districts, stages, MISSING_DISTRICT),
    classBenchmark: benchmark(classes, stages, MISSING_CLASS),
  };
}

function summary(ws, input = {}) {
  const options = readOptions(input);
  const facts = prepare(ws, options);
  const { from, to, region, statsClass, trendEnd, asOf, includeCurrent, weekStart } = options;
  const period = windowData(facts, options, { from, to });
  const currentWeek = calendarRange(trendEnd, "week", weekStart);
  const complete = (week) => week.to <= trendEnd && week.to < asOf;
  const endOffset = includeCurrent || complete(currentWeek) ? 0 : -1;
  const weeks = Array.from({ length: 8 }, (_, index) => {
    const full = calendarRange(trendEnd, "week", weekStart, endOffset - 7 + index);
    const partial = !complete(full);
    return windowData(facts, options, { from: full.from, to: partial ? trendEnd : full.to, end: full.to, partial }, true);
  });
  const latest = weeks.at(-1);
  const comparison = latest.partial && windowData(facts, options, {
    from: shiftDay(latest.from, -7), to: shiftDay(latest.to, -7),
  }, true);
  addHoldings(facts, comparison ? [...weeks, comparison] : weeks);
  const weekly = weeks.map((window) => ({
    from: window.from, to: window.to, end: window.end, partial: window.partial,
    ...rowsFor(facts, window, false),
    ...(window === latest && comparison && { comparison: {
      from: comparison.from, to: comparison.to, ...rowsFor(facts, comparison, false),
    } }),
  }));
  return {
    from, to, region, statsClass, trendEnd, asOf, includeCurrent, source: period.source,
    stages: facts.stages.map(({ key, id, label, configured }) => ({ key, id, label, configured })),
    ...rowsFor(facts, period, true), weekly,
  };
}

function details(ws, input = {}) {
  const options = readOptions(input);
  const facts = prepare(ws, options);
  const { from, to, region, statsClass } = options;
  const period = windowData(facts, options, { from, to });
  const { grouping, group, stage } = input;
  Model.assert(["total", "district", "class"].includes(grouping), "상세 조회 구분을 확인해 주세요.");
  const index = facts.stages.findIndex(({ key }) => key === stage);
  Model.assert(index >= 0, "조회할 단계를 확인해 주세요.");
  const rows = rowsFor(facts, period, true);
  const scope = grouping === "total" ? rows.total
    : (grouping === "district" ? rows.districts : rows.classes).find(({ key }) => key === group);
  Model.assert(scope, "조회할 조직을 확인해 주세요.");
  const count = scope.stages[index].count;
  const inDate = (date) => (!from || date >= from) && (!to || date <= to);
  const result = { count, source: scope.source, rows: [] };
  if (!count) return result;
  if (scope.source === "reported") {
    const district = grouping === "district" ? group : region;
    result.rows = facts.reports.filter((report) => report.found && inDate(report.date) &&
      (!district || districtKey(report.region) === district)).map((report) => ({
      name: "", region: districtKey(report.region), className: "", date: report.date,
      source: "reported", count: report.found,
    }));
  } else {
    const district = grouping === "district" ? group : region;
    const className = grouping === "class" ? group : statsClass && facts.classKey(statsClass);
    result.rows = facts.arrivals.filter((entry) => entry.index === index && inDate(entry.date) &&
      (!district || entry.district === district) && (!className || entry.className === className)).map((entry) => ({
      name: entry.name, region: entry.district, className: facts.classLabel(entry.className), date: entry.date,
      source: "detail", count: 1,
    }));
  }
  result.rows.sort((a, b) => a.date.localeCompare(b.date) || compare(a.region, b.region) || compare(a.name, b.name));
  return result;
}

module.exports = { summary, details, stagesFor, stageArrivals };
