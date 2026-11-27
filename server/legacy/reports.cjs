"use strict";
const ExcelJS = require("exceljs");
const O = require("./organization.cjs");
const K = require("./codes.cjs");
const Milestones = require("./ui/person-milestones.js");
const { PHONE_HEADER } = require("./person-phone.cjs");
const { query, group, band, assert, text, stageName } = require("./model.cjs");
const COLUMNS = [
  ["code", "대상자 식별번호"],
  ["name", "대상자"],
  ["phone", PHONE_HEADER],
  ["gender", "성별"],
  ["age", "나이"],
  ["ageAsOf", "나이 기준일"],
  ["date", "등록일"],
  ["time", "찾기 시간"],
  ["classification1", "분류1"],
  ["classification2", "분류2"],
  ["place", "찾기 장소"],
  ["tool", "사용 도구"],
  ["residence", "거주지"],
  ["teacher", "교사"],
  ["reason", "사유"],
  ...Milestones.fields.map(({ field, label }) => [field, label]),
  ["stage", "현재 단계"],
  ["status", "현재 상태"],
  ["worker", "담당자"],
  ["region", "현재 구역"],
  ["className", "반"],
  ["employment", "직업 구분"],
  ["appointment", "확정 일정"],
  ["activityCount", "활동 건수"],
  ["activityMinutes", "활동 시간(분)"],
  ["notes", "메모"],
  ["introducerCode", "인도자 구성원ID"],
  ["introducerName", "현재 인도자 이름"],
  ["introducerUnit", "현재 인도자 소속"],
  ["introducerOriginalUnit", "인도자 연결 당시 소속"],
];
function columns(ws) {
  return [
    ...COLUMNS.map(([key, label]) => ({ key, label })),
    ...ws.fields.map((f) => ({ key: `custom:${f.id}`, label: f.label })),
  ];
}
function excelDate(value) {
  return value ? new Date(value + "T00:00:00Z") : null;
}
function filterDescription(f, ws) {
  const labels = {
    search: "검색어",
    worker: "담당자",
    region: "구역",
    className: "반",
    employment: "직장인 구분",
    stage: "단계",
    timeBand: "시간대",
    minMinutes: "최소 활동(분)",
    maxMinutes: "최대 활동(분)",
    transitionFrom: "변경 전 단계",
    transitionTo: "변경 후 단계",
    introducerId: "인도자",
    orgUnitId: "인도자 소속 조직 · 하위 포함",
    classification2: "분류2",
  };
  return [
    `기간 기준: ${f.basis === "activity" ? "활동일" : f.basis === "transition" ? "단계 변경일" : "등록일"}`,
    `기간: ${f.from || "제한 없음"} ~ ${f.to || "제한 없음"}`,
    ...Object.entries(labels)
      .filter(([key]) => f[key] !== "" && f[key] != null)
      .map(([key, label]) => {
        const org = O.get(ws),
          m = org.members.find((m) => m.id === f.introducerId);
        const value =
          key === "classification2"
            ? require("./classification-scope.cjs").label(f[key])
            : ["className", "employment"].includes(key)
              ? K.label(ws, key, f[key])
              : key === "introducerId"
                ? m
                  ? `${m.name} (${m.code})`
                  : f[key]
                : key === "orgUnitId"
                  ? O.pathName(org, f[key])
                  : f[key];
        return `${label}: ${value}`;
      }),
  ].join(" / ");
}
async function createReport(ws, input, template = "detail", selected) {
  if (template === "reported") return createReportedReport(ws, input);
  const result = query(ws, input);
  const { people, activities, summary, filters } = result;
  const org = O.get(ws);
  assert(
    [
      "detail",
      "activity",
      "daily",
      "person",
      "class",
      "employment",
      "timeBand",
      "custom",
      "region",
      "transitions",
      "stageSummary",
    ].includes(template),
    "출력 양식을 확인해 주세요.",
  );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SMOA";
  workbook.created = new Date();
  const titles = {
    detail: "대상자 상세",
    activity: "활동 상세",
    daily: "일별 활동",
    person: "사람별 활동",
    class: "반별 현황",
    employment: "직장인 구분별 현황",
    timeBand: "시간대별 활동",
    custom: "사용자 지정 상세",
    region: "구역별 목표 실적",
    transitions: "단계 변경 이력",
    stageSummary: "구역별 단계 현황",
  };
  const sheet = workbook.addWorksheet(titles[template], {
    views: [{ state: "frozen", ySplit: 5 }],
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  let headers,
    rows,
    kinds = [];
  if (template === "detail" || template === "custom") {
    const available = columns(ws);
    const chosen =
      template === "custom"
        ? selected
        : available
            .filter((c) => !["code", "introducerCode"].includes(c.key))
            .map((c) => c.key);
    assert(
      Array.isArray(chosen) &&
        chosen.length > 0 &&
        chosen.length <= available.length &&
        new Set(chosen).size === chosen.length,
      "출력할 열을 선택해 주세요.",
    );
    const defs = chosen.map((key) => {
      const col = available.find((c) => c.key === key);
      assert(col, "알 수 없는 출력 항목입니다.");
      return col;
    });
    headers = defs.map((c) => c.label);
    kinds = defs.map((c) =>
      ["date", "ageAsOf"].includes(c.key) ||
      Milestones.fields.some(({ field }) => field === c.key)
        ? "date"
        : ["age", "activityCount", "activityMinutes"].includes(c.key)
          ? "number"
          : c.key === "phone"
            ? "phone"
            : c.key.startsWith("custom:")
              ? ws.fields.find((f) => `custom:${f.id}` === c.key)?.type
              : "text",
    );
    const byPerson = new Map();
    activities.forEach((a) => {
      const val = byPerson.get(a.personId) || { count: 0, minutes: 0 };
      val.count++;
      val.minutes += a.minutes;
      byPerson.set(a.personId, val);
    });
    rows = people.map((person) => {
      const m = org.members.find((m) => m.id === person.introducerId);
      const p = {
        ...person,
        ...Object.fromEntries(
          Milestones.fields.map(({ field }) => [
            field,
            Milestones.value(person, field, ws),
          ]),
        ),
        className: K.label(ws, "className", person.className),
        employment: K.label(ws, "employment", person.employment),
        introducerCode: m?.code || person.introducerSnapshot?.code || "",
        introducerName: m?.name || person.introducerSnapshot?.name || "",
        introducerUnit: m ? O.pathName(org, m.unitId) : "",
        introducerOriginalUnit: person.introducerSnapshot?.unitPath || "",
      };
      return defs.map((c) =>
        c.key === "activityCount"
          ? byPerson.get(p.id)?.count || 0
          : c.key === "activityMinutes"
            ? byPerson.get(p.id)?.minutes || 0
            : c.key === "stage"
              ? stageName(ws, p.stage)
              : c.key === "status"
                ? p.status === "dropped"
                  ? "탈락"
                  : "진행"
                : c.key.startsWith("custom:")
                  ? ws.fields.find((f) => `custom:${f.id}` === c.key)
                      ?.codeGroupId
                    ? K.label(
                        ws,
                        ws.fields.find((f) => `custom:${f.id}` === c.key)
                          .codeGroupId,
                        p.custom[c.key.slice(7)],
                      )
                    : (p.custom[c.key.slice(7)] ?? "")
                  : (p[c.key] ?? ""),
      );
    });
  } else if (template === "stageSummary") {
    headers = [
      "현재 구역",
      ...ws.stages.flatMap((s) =>
        ["목표", "신규진입", "유지보유", "기간말재고", "기간복귀"].map(
          (label) => `${stageName(ws, s)} · ${label}`,
        ),
      ),
    ];
    kinds = ["text", ...Array(headers.length - 1).fill("number")];
    const regions = [
      ...new Set([
        ...ws.people.map((p) => p.region || "미입력"),
        ...ws.goals.map((g) => g.region),
      ]),
    ]
      .filter((r) => r && (!filters.region || r === filters.region))
      .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
    rows = regions.map((region) => {
      const per = query(ws, { ...input, region });
      return [
        region,
        ...per.summary.inventory.flatMap((s) => [
          s.target,
          s.entered,
          s.retained,
          s.stock,
          s.restored,
        ]),
      ];
    });
  } else if (template === "region") {
    headers = [
      "현재 구역",
      "검색된 대상자 수",
      "기간 목표",
      "미달 건수",
      "달성률",
    ];
    kinds = ["text", "number", "number", "number", "number"];
    rows = summary.regions.map((r) => [
      r.label,
      r.value,
      summary.goalComparable ? r.target : null,
      summary.goalComparable ? r.shortfall : null,
      summary.goalComparable && r.rate !== null ? r.rate / 100 : null,
    ]);
  } else if (template === "transitions") {
    headers = [
      "대상자",
      "변경 전 단계",
      "변경 후 단계",
      "적용 시각(PC 현지시간)",
      "기록 시각(UTC)",
      "기록자",
      "당시 구역",
      "당시 반",
      "당시 담당자",
      "변경 사유",
    ];
    rows = result.transitions.map((t) => [
      t.personName,
      stageName(ws, t.from),
      stageName(ws, t.to),
      t.effectiveLocal,
      t.recordedAt,
      t.actor,
      t.region,
      K.label(ws, "className", t.className),
      t.worker,
      t.reason,
    ]);
  } else if (template === "activity") {
    headers = [
      "활동일",
      "대상자",
      "활동 담당자",
      "현재 반",
      "현재 단계",
      "직장인 구분",
      "활동 종류",
      "시작",
      "종료",
      "활동 시간(분)",
      "메모",
      "활동 장소",
      "분류2",
    ];
    kinds = [
      "date",
      "text",
      "text",
      "text",
      "text",
      "text",
      "text",
      "text",
      "text",
      "number",
      "text",
      "text",
    ];
    rows = activities
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
      )
      .map((a) => [
        a.date,
        a.personName,
        a.worker,
        K.label(ws, "className", a.className),
        stageName(ws, a.stage),
        K.label(ws, "employment", a.employment),
        K.label(ws, "activityKind", a.kind),
        a.start,
        a.end,
        a.minutes,
        a.notes,
        K.label(ws, "activityPlace", a.place),
        a.classification2 ?? "노방",
      ]);
    kinds.push("text");
  } else if (template === "class" || template === "employment") {
    const key = template === "class" ? "className" : "employment";
    headers = [
      template === "class" ? "현재 반" : "직장인 구분",
      "대상자 수",
      ...ws.stages.map((s) => stageName(ws, s)),
      "활동 건수",
      "활동 시간(분)",
    ];
    kinds = ["text", ...Array(headers.length - 1).fill("number")];
    rows = group(people, (p) => K.label(ws, key, p[key]) || "미입력")
      .sort((a, b) => a.label.localeCompare(b.label, "ko", { numeric: true }))
      .map((g) => {
        const peopleGroup = people.filter(
            (p) => (K.label(ws, key, p[key]) || "미입력") === g.label,
          ),
          ids = new Set(peopleGroup.map((p) => p.id)),
          acts = activities.filter((a) => ids.has(a.personId));
        return [
          g.label,
          g.value,
          ...ws.stages.map(
            (s) => peopleGroup.filter((p) => p.stage === s).length,
          ),
          acts.length,
          acts.reduce((sum, a) => sum + a.minutes, 0),
        ];
      });
  } else {
    headers = [
      template === "daily"
        ? "활동일"
        : template === "person"
          ? "대상자"
          : "시간대",
      "활동 건수",
      "활동 시간(분)",
    ];
    kinds = [template === "daily" ? "date" : "text", "number", "number"];
    const key =
      template === "daily"
        ? (a) => a.date
        : template === "person"
          ? (a) => a.personId
          : (a) => band(a.start);
    rows = group(activities, key)
      .sort((a, b) => a.label.localeCompare(b.label, "ko"))
      .map((g) => [
        template === "person"
          ? `${people.find((p) => p.id === g.label)?.name || ""} [${g.label.slice(0, 8)}]`
          : g.label,
        g.value,
        activities
          .filter((a) => key(a) === g.label)
          .reduce((s, a) => s + a.minutes, 0),
      ]);
  }
  const width = Math.max(headers.length, 3);
  sheet.mergeCells(1, 1, 1, width);
  sheet.getCell(1, 1).value = `${ws.name} · ${titles[template]}`;
  sheet.getRow(1).height = 34;
  sheet.getCell(1, 1).font = {
    name: "맑은 고딕",
    size: 18,
    bold: true,
    color: { argb: "FF164D45" },
  };
  sheet.mergeCells(2, 1, 2, width);
  sheet.getCell(2, 1).value = filterDescription(filters, ws);
  sheet.getRow(2).height = 38;
  sheet.getCell(2, 1).alignment = { wrapText: true, vertical: "middle" };
  sheet.mergeCells(3, 1, 3, width);
  sheet.getCell(3, 1).value =
    `대상자 ${summary.people}명 · 활동 ${summary.activities}건 · 활동 시간 ${summary.minutes}분 | 내보낸 시각 ${new Date().toLocaleString("ko-KR")}`;
  sheet.mergeCells(4, 1, 4, width);
  sheet.getCell(4, 1).value =
    "현재 단계·현재 반 기준입니다. 활동 시간은 각 구간의 시작~종료 시간을 그대로 합산하며, 종료가 빠르면 익일로 처리합니다.";
  sheet.getRow(4).height = 30;
  sheet.getCell(4, 1).alignment = { wrapText: true };
  sheet.getCell(4, 1).font = { size: 10, color: { argb: "FF64746E" } };
  const header = sheet.getRow(5);
  header.values = headers;
  header.height = 26;
  header.eachCell((c) => {
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF164D45" },
    };
    c.font = { name: "맑은 고딕", bold: true, color: { argb: "FFFFFFFF" } };
    c.alignment = { vertical: "middle" };
  });
  for (const values of rows) {
    const row = sheet.addRow(
      values.map((v, i) => (kinds[i] === "date" ? excelDate(v) : v)),
    );
    row.height = 23;
    row.eachCell({ includeEmpty: true }, (cell, index) => {
      cell.font = { name: "맑은 고딕", size: 10 };
      cell.alignment = { vertical: "middle", wrapText: true };
      if (row.number % 2 === 0)
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF2F7F5" },
        };
      if (kinds[index - 1] === "date") cell.numFmt = "yyyy-mm-dd";
      if (kinds[index - 1] === "number") cell.numFmt = "#,##0.##";
      if (kinds[index - 1] === "phone") cell.numFmt = "@";
      if (template === "region" && index === 5) cell.numFmt = "0.0%";
    });
  }
  headers.forEach((label, i) => {
    sheet.getColumn(i + 1).width =
      label === "메모"
        ? 45
        : kinds[i] === "date"
          ? 15
          : Math.max(15, Math.min(30, label.length * 2 + 5));
  });
  sheet.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: Math.max(5, sheet.rowCount), column: headers.length },
  };
  sheet.pageSetup.printTitlesRow = "1:5";
  sheet.headerFooter.oddFooter = "&LSMOA&R&P / &N";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function createReportedReport(ws, input) {
  const { summary, filters } = query(ws, input),
    r = summary.reported,
    b = new ExcelJS.Workbook();
  b.creator = "SMOA";
  const s = b.addWorksheet("입력 일계 보고", {
    views: [{ state: "frozen", ySplit: 4, xSplit: 1 }],
    pageSetup: {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const title = `${ws.name} · 구역별 입력 일계`;
  s.mergeCells("A1:G1");
  s.getCell("A1").value = title;
  s.getRow(1).height = 34;
  s.getCell("A1").font = {
    name: "맑은 고딕",
    size: 17,
    bold: true,
    color: { argb: "FF194B3B" },
  };
  s.mergeCells("A2:G2");
  s.getCell("A2").value =
    `보고일 ${filters.from || "전체"} ~ ${filters.to || "전체"}${filters.region ? " · " + filters.region : ""} | 찾기 ${r.found}건 · 향상 ${r.advanced}건 · 탈락 ${r.dropped}건`;
  s.mergeCells("A3:G3");
  s.getCell("A3").value =
    "사용자 입력 일계입니다. 상세 기록과 합산하지 않으며 기간·구역 조건만 적용합니다. 찾B 신규 진입 목표와 비교합니다.";
  s.getRow(3).height = 32;
  s.getCell("A3").alignment = { wrapText: true };
  s.addRow([
    "구역",
    "찾기 목표",
    "찾기 보고",
    "향상 보고",
    "탈락 보고",
    "구역별 미달",
    "달성률",
  ]);
  for (const row of r.regions)
    s.addRow([
      row.label,
      row.target,
      row.value,
      row.advanced,
      row.dropped,
      row.shortfall,
      row.rate === null ? null : row.rate / 100,
    ]);
  const hasAllGoals =
      r.regions.length > 0 && r.regions.every((row) => row.target !== null),
    totalTarget = hasAllGoals
      ? r.regions.reduce((n, row) => n + row.target, 0)
      : null;
  s.addRow([
    "합계",
    totalTarget,
    r.found,
    r.advanced,
    r.dropped,
    hasAllGoals ? r.regions.reduce((n, row) => n + row.shortfall, 0) : null,
    totalTarget ? r.found / totalTarget : null,
  ]);
  s.eachRow((row) => {
    row.height = row.number === 1 ? 34 : row.number === 3 ? 32 : 26;
    row.eachCell({ includeEmpty: true }, (cell, index) => {
      cell.font = {
        name: "맑은 고딕",
        size: 11,
        bold: row.number === 4 || row.number === s.rowCount,
      };
      cell.alignment = { vertical: "middle", wrapText: true };
      if (row.number >= 5 && index > 1)
        cell.numFmt = index === 7 ? "0.0%" : "#,##0";
      if (row.number === 4 || row.number === s.rowCount) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: row.number === 4 ? "FF194B3B" : "FFE8F1E3" },
        };
        if (row.number === 4)
          cell.font = {
            name: "맑은 고딕",
            bold: true,
            color: { argb: "FFFFFFFF" },
          };
      }
    });
  });
  [20, 17, 17, 17, 17, 20, 16].forEach(
    (width, i) => (s.getColumn(i + 1).width = width),
  );
  s.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: Math.max(4, s.rowCount - 1), column: 7 },
  };
  return Buffer.from(await b.xlsx.writeBuffer());
}
async function createAIReport(result) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SMOA";
  const summary = workbook.addWorksheet("분석 요약");
  summary.addRow([result.title]);
  summary.addRow([result.summary]);
  for (const note of result.notes) summary.addRow([note]);
  summary.getColumn(1).width = 110;
  summary.eachRow((r) => {
    r.height = r.number === 1 ? 32 : 65;
    r.eachCell((c) => {
      c.font = {
        name: "맑은 고딕",
        size: r.number === 1 ? 16 : 11,
        bold: r.number === 1,
      };
      c.alignment = { wrapText: true, vertical: "middle" };
    });
  });
  for (let i = 0; i < result.tables.length; i++) {
    const t = result.tables[i],
      s = workbook.addWorksheet(`결과표 ${i + 1}`, {
        views: [{ state: "frozen", ySplit: 2 }],
      });
    s.addRow([t.title]);
    s.addRow(t.columns);
    t.rows.forEach((r) => s.addRow(r));
    s.getRow(2).eachCell((c) => {
      c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF194B3B" },
      };
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    });
    t.columns.forEach((_, n) => (s.getColumn(n + 1).width = 25));
    s.eachRow((r) =>
      r.eachCell((c) => {
        c.alignment = { wrapText: true, vertical: "middle" };
      }),
    );
    s.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: Math.max(2, s.rowCount), column: t.columns.length },
    };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
module.exports = { columns, createReport, createAIReport, filterDescription };
