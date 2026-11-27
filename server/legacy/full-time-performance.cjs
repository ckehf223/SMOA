"use strict";

const ExcelJS = require("exceljs");
const K = require("./codes.cjs");
const M = require("./model.cjs");
const O = require("./organization.cjs");
const { facts } = require("./performance.cjs");
const { calendarRange } = require("./regional-analytics.cjs");
const { stageArrivals, stagesFor } = require("./stage-performance.cjs");

const DAY = 86400000;
const normalize = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .replace(/\s/g, "")
    .toLowerCase();
const sortName = (a, b) => a.localeCompare(b, "ko", { numeric: true });
const day = (date) => date.slice(0, 10);
const shift = (date, days) =>
  day(new Date(Date.parse(date) + days * DAY).toISOString());

function roster(ws) {
  const org = O.get(ws);
  return org.members.flatMap((member) => {
    if (
      member.status !== "active" ||
      O.ancestors(org, member.unitId).some((node) => !node.active)
    )
      return [];
    const item = K.find(ws, "employment", member.employment);
    if (
      ![
        member.employment,
        item?.value,
        item?.label,
        ...(item?.aliases || []),
      ].some((value) => normalize(value) === "전일자")
    )
      return [];
    const classLabel = K.label(ws, "className", member.className);
    return [
      {
        key: `member:${member.code}`,
        name: member.name,
        region: O.regionOf(org, member.unitId) || "구역 미입력",
        classLabel: /^\d+$/.test(classLabel) ? `${classLabel}반` : classLabel,
      },
    ];
  });
}

function districtOptions(ws, members) {
  const org = O.get(ws);
  const districts = new Set(members.map(({ region }) => region));
  for (const node of org.nodes) {
    if (!(node.reportRegion || /구역/.test(node.type))) continue;
    if (O.ancestors(org, node.id).some((parent) => !parent.active)) continue;
    const region = O.regionOf(org, node.id);
    if (region) districts.add(region);
  }
  return [...districts]
    .sort(sortName)
    .map((region) => ({ region, label: region }));
}

function blankCounts(stages) {
  return {
    current: stages.map(({ configured }) => (configured ? 0 : null)),
    previous: stages.map(({ configured }) => (configured ? 0 : null)),
    holdings: stages.map(({ ids }) => (ids.length ? 0 : null)),
  };
}

function summarize(rows, stages) {
  const counts = { ...blankCounts(stages), members: rows.length };
  for (const row of rows) {
    for (const field of ["current", "previous", "holdings"])
      row[field].forEach((count, index) => {
        if (count !== null) counts[field][index] += count;
      });
  }
  return counts;
}

function lastAt(events, anchor, changed = () => true) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.effectiveLocal &&
      day(event.effectiveLocal) <= anchor &&
      changed(event)
    )
      return event;
  }
}

function query(ws, input = {}) {
  const asOf = M.date(input.asOf || day(new Date().toISOString())),
    requestedAnchor = M.date(input.anchor || asOf),
    anchor = requestedAnchor > asOf ? asOf : requestedAnchor,
    weekStart =
      Number.isInteger(input.weekStart) &&
      input.weekStart >= 0 &&
      input.weekStart <= 6
        ? input.weekStart
        : 0,
    current = {
      from: calendarRange(anchor, "week", weekStart).from,
      to: anchor,
    },
    previous = { from: shift(current.from, -7), to: shift(anchor, -7) },
    stages = stagesFor(ws),
    members = roster(ws),
    districts = districtOptions(ws, members),
    selectedRegion = districts.some(({ region }) => region === input.region)
      ? input.region
      : "",
    search = normalize(input.search),
    rows = members
      .filter(
        ({ region, name }) =>
          (!selectedRegion || region === selectedRegion) &&
          normalize(name).includes(search),
      )
      .map((member) => ({ ...member, ...blankCounts(stages) }))
      .sort(
        (a, b) =>
          sortName(a.region, b.region) ||
          sortName(a.name, b.name) ||
          a.key.localeCompare(b.key),
      );

  if (rows.length) {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const { findings } = facts(ws);
    for (const { workerKey, index, date } of stageArrivals(
      ws,
      stages,
      findings,
    )) {
      const counts = byKey.get(workerKey);
      if (!counts || counts.current[index] === null) continue;
      if (date >= current.from && date <= current.to) counts.current[index]++;
      if (date >= previous.from && date <= previous.to)
        counts.previous[index]++;
    }
    const stageIndex = new Map(
      stages.flatMap(({ ids }, index) => ids.map((id) => [id, index])),
    );
    for (const { person, worker } of findings) {
      const counts = byKey.get(worker.key);
      if (!counts || !person) continue;
      if (lastAt(person.lifecycle || [], anchor)?.to === "dropped") continue;
      const stage = lastAt(
        person.transitions || [],
        anchor,
        ({ from, to }) => from !== to,
      )?.to;
      const index = stageIndex.get(stage);
      if (index !== undefined) counts.holdings[index]++;
    }
  }

  const groupRows = new Map();
  for (const row of rows) {
    if (!groupRows.has(row.region)) groupRows.set(row.region, []);
    groupRows.get(row.region).push(row);
  }
  const groups = districts.flatMap(({ region, label }) => {
    const visible =
      groupRows.get(region) ||
      (selectedRegion === region && !search ? [] : null);
    return visible
      ? [{ region, label, rows: visible, totals: summarize(visible, stages) }]
      : [];
  });
  return {
    asOf,
    anchor,
    current,
    previous,
    districts,
    groups,
    selectedRegion,
    stages: stages.map(({ key, label, configured, ids }) => ({
      key,
      label,
      configured,
      holdingsAvailable: ids.length > 0,
    })),
    totals: summarize(rows, stages),
  };
}

async function workbook(result) {
  const exportBook = new ExcelJS.Workbook();
  const nameCells = ["구역", "이름", "반"];
  const summaryCells = ["구역", "전일자 수"];
  const stageCells = result.stages.flatMap(({ label }) => [
    `${label} 신규`,
    `${label} 7일 전`,
    `${label} 보유`,
  ]);
  const values = (row) =>
    result.stages.flatMap((_, i) => [
      row.current[i],
      row.previous[i],
      row.holdings[i],
    ]);
  const format = (sheet, headers, rows, splits) => {
    sheet.addRows([headers, ...rows]);
    sheet.views = [{ state: "frozen", xSplit: splits, ySplit: 1 }];
    sheet.columns = headers.map((_, i) => ({ width: i < splits ? 16 : 19 }));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF264E73" },
    };
  };
  const overview = exportBook.addWorksheet("구역 합계");
  format(
    overview,
    [...summaryCells, ...stageCells],
    [
      ...result.groups.map(({ label, totals }) => [
        label,
        totals.members,
        ...values(totals),
      ]),
      ["조회 합계", result.totals.members, ...values(result.totals)],
    ],
    summaryCells.length,
  );
  const detail = exportBook.addWorksheet("전일자 개인별");
  format(
    detail,
    [...nameCells, ...stageCells],
    result.groups.flatMap(({ label, rows }) =>
      rows.map((row) => [label, row.name, row.classLabel, ...values(row)]),
    ),
    nameCells.length,
  );
  const notes = exportBook.addWorksheet("집계 기준");
  notes.columns = [{ width: 21 }, { width: 75 }];
  notes.addRows([
    ["조회 기간", `${result.current.from} ~ ${result.current.to}`],
    ["비교 기간", `${result.previous.from} ~ ${result.previous.to}`],
    [
      "전일자 · 구역",
      "현재 활성 구성원 명부의 직업 구분과 소속 구역 기준입니다.",
    ],
    ["신규", "기간 안에 최초 도달한 단계입니다."],
    [
      "보유",
      "조회 종료일의 마지막 단계와 탈락·복귀 기록을 사용합니다. 보유 단계가 자료실에 없으면 빈칸입니다.",
    ],
  ]);
  return Buffer.from(await exportBook.xlsx.writeBuffer());
}

module.exports = { query, workbook };
