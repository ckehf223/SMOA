"use strict";
const M = require("./model.cjs");
const S = require("./person-stages.cjs");
const milestones = require("./ui/person-milestones.js");

const normalize = (label) =>
  String(label ?? "")
    .replace(/\s/g, "")
    .toLowerCase();

function pathway(ws, includeFindingToFindA) {
  const keyFor = (label) =>
    normalize(label) === "찾b"
      ? "finding"
      : milestones.fieldForStageLabel(label)?.field;
  const keysById = new Map(
    ws.stages.map((id) => [
      id,
      keyFor(id) || keyFor(M.stageName(ws, id)) || `configured:${id}`,
    ]),
  );
  const aliases = new Map();
  for (const [id, key] of keysById) {
    if (!aliases.has(key)) aliases.set(key, []);
    aliases.get(key).push(id);
  }
  const fieldsWithDates = new Set();
  for (const person of ws.people)
    for (const field of Object.keys(person.stageDates || {}))
      fieldsWithDates.add(field);

  const finding = { key: "finding", id: aliases.get("finding")?.[0] || "찾B" };
  finding.label = M.stageName(ws, finding.id);
  const known = milestones.fields.map(({ field, stage }) => {
    const ids = aliases.get(field) || [];
    const preferred = S.stageId(ws, field);
    const id = ids.includes(preferred) ? preferred : ids[0] || stage;
    return {
      key: field,
      field,
      id,
      label: M.stageName(ws, id),
      included: ids.length > 0 || fieldsWithDates.has(field),
    };
  });
  const byKey = new Map([finding, ...known].map((stage) => [stage.key, stage]));
  const pairs = [];
  for (const [index, stage] of known.entries()) {
    if (!stage.included) continue;
    const previous = index === 0 ? finding : known[index - 1];
    if (stage.field === "findADate") {
      if (includeFindingToFindA) pairs.push({ from: finding, to: stage });
      if (!previous.included) continue;
    }
    pairs.push({ from: previous, to: stage });
  }
  let previous = finding;
  for (const id of ws.stages) {
    const key = keysById.get(id);
    let stage = byKey.get(key);
    if (!stage) {
      stage = { key, id, label: M.stageName(ws, id) };
      byKey.set(key, stage);
      pairs.push({ from: previous, to: stage });
    }
    previous = stage;
  }
  const earlyStages = [byKey.get("manpikDate"), byKey.get("findADate")];
  return { finding, pairs, keysById, earlyStages };
}

function measure(
  ws,
  {
    from,
    to,
    people = ws.people,
    classify = () => undefined,
    includeReports = false,
    includeFindingToFindA = true,
    onPair,
  } = {},
) {
  const { finding, pairs, keysById, earlyStages } = pathway(ws, includeFindingToFindA);
  const descriptors = pairs.map(({ from, to }) => ({
    id: to.id,
    label: to.label,
    fromId: from.id,
    fromLabel: from.label,
    baseCount: 0,
    count: 0,
    rate: null,
  }));
  const sources = new Map([[finding.key, { stage: finding, pairs: [] }]]);
  for (const [index, pair] of pairs.entries()) {
    const key = pair.from.key;
    if (!sources.has(key)) sources.set(key, { stage: pair.from, pairs: [] });
    sources.get(key).pairs.push([pair.to, index]);
  }
  const empty = () => ({
    count: 0,
    stages: descriptors.map((stage) => ({ ...stage })),
  });
  const overall = empty(),
    groups = new Map();
  const firstReports = new Map(),
    firstDatedReports = new Map();
  for (const report of ws.findingReports || []) {
    if (
      !firstReports.has(report.personCode) ||
      report.date < firstReports.get(report.personCode).date
    )
      firstReports.set(report.personCode, report);
    if (
      includeReports &&
      report.foundDate &&
      !report.dateUnknown &&
      (!firstDatedReports.has(report.personCode) ||
        report.date < firstDatedReports.get(report.personCode).date)
    )
      firstDatedReports.set(report.personCode, report);
  }
  const attainmentById = new Map(
    ws.stages.map((id) => [id, S.attainmentFor(ws, id)]),
  );
  const gospelAttainment = attainmentById.get(S.stageId(ws, "bokshinDate"));
  const update = (aggregate, source, indexes) => {
    if (source.key === finding.key) aggregate.count++;
    for (const [index, reached] of indexes) {
      const row = aggregate.stages[index];
      row.baseCount++;
      if (reached) row.count++;
    }
  };
  const inPeriod = (date) =>
    date && (!from || date >= from) && (!to || date <= to);
  const addSource = (source, row, indexes) => {
    if (!inPeriod(row.date)) return;
    const key = classify(row);
    if (key === null) return;
    if (onPair) {
      for (const [index, reachedDate] of indexes)
        onPair(row, source.key, pairs[index].to.key, reachedDate || null);
    }
    update(overall, source, indexes);
    if (key === undefined) return;
    if (!groups.has(key)) groups.set(key, empty());
    update(groups.get(key), source, indexes);
  };

  for (const person of people) {
    const events = new Map();
    for (const event of person.transitions) {
      const key = keysById.get(event.to);
      if (key && !events.has(key)) events.set(key, event);
    }
    const report = firstReports.get(person.code);
    const entries = new Map();
    function entry(stage) {
      if (entries.has(stage.key)) return entries.get(stage.key);
      if (stage.key === finding.key) {
        const firstFinding = events.get(stage.key);
        const hasFindingEvent = firstFinding?.from === null;
        const explicitEarlyPath =
          !person.dateUnknown &&
          person.date &&
          earlyStages.some((later) => {
            const date = entry(later)?.date;
            return date > person.date ||
              (later.field === "manpikDate" && date === person.date);
          });
        const confirmedReport =
          !report?.dateUnknown &&
          report?.foundDate === person.date &&
          keysById.get(report?.stage) === finding.key
            ? report
            : null;
        const date =
          !person.dateUnknown &&
          (hasFindingEvent || explicitEarlyPath || confirmedReport)
            ? person.date
            : "";
        const event = hasFindingEvent
          ? firstFinding
          : confirmedReport ||
            person.transitions.find((candidate) => candidate.from === null);
        const record = date ? { date, time: person.time, event } : null;
        entries.set(stage.key, record);
        return record;
      }
      const gospel = stage.key === "bokshinDate" && gospelAttainment;
      const gospelEntry = gospel && gospel(person, report);
      const event = gospel ? gospelEntry?.event : events.get(stage.key);
      const date = gospel
        ? gospelEntry?.date
        : (stage.field && person.stageDates?.[stage.field]) ||
          (event && attainmentById.get(event.to)(person, report)?.date);
      const time =
        date &&
        event &&
        !event.baseline &&
        !event.timeUnknown &&
        event.effectiveLocal.startsWith(date)
          ? event.effectiveLocal.slice(11, 16)
          : "";
      const record = date ? { date, time, event } : null;
      entries.set(stage.key, record);
      return record;
    }
    for (const { stage, pairs } of sources.values()) {
      const source = entry(stage);
      if (!inPeriod(source?.date)) continue;
      const { event, date } = source;
      addSource(
        stage,
        {
          code: person.code,
          date,
          region: event?.region ?? person.region,
          className: event?.className ?? person.className,
        },
        pairs.map(([nextStage, index]) => {
          const destination = entry(nextStage);
          const sameDayFindingToManpik =
            stage.key === finding.key && nextStage.field === "manpikDate";
          const reached =
            destination &&
            (destination.date > date ||
              (destination.date === date &&
                (sameDayFindingToManpik ||
                  !source.time ||
                  !destination.time ||
                  destination.time >= source.time)));
          return [index, reached ? destination.date : null];
        }),
      );
    }
  }

  if (includeReports) {
    const registered = new Set(ws.people.map((person) => person.code));
    const rates = sources
      .get(finding.key)
      .pairs.map(([, index]) => [index, false]);
    for (const report of firstDatedReports.values())
      if (
        !registered.has(report.personCode) &&
        keysById.get(report.stage) === finding.key
      )
        addSource(
          finding,
          {
            code: report.personCode,
            date: report.foundDate,
            region: report.region,
            className: report.className,
          },
          rates,
        );
  }
  for (const summary of [overall, ...groups.values()])
    for (const stage of summary.stages)
      if (stage.baseCount) stage.rate = stage.count / stage.baseCount;
  return { overall, groups, empty };
}

module.exports = { measure };
