"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  K = require("./codes.cjs");
const TITLES = {
  person: "개인별",
  area: "지역별",
  region: "구역별",
  class: "반별",
  hour: "시간대별",
  date: "일자별",
};
function summarize(ws, activities, creations, reports) {
  const result = {};
  for (const kind of Object.keys(TITLES)) {
    const bins = new Map();
    const get = (label) => {
      label ||= "미입력";
      if (!bins.has(label))
        bins.set(label, {
          label,
          workers: new Set(),
          days: new Set(),
          activities: new Set(),
          minutes: 0,
          unknownTimeCount: 0,
          creations: 0,
          reportedNew: 0,
          retained: 0,
          dropped: 0,
        });
      return bins.get(label);
    };
    const label = (r, type) => {
      if (kind === "person")
        return `${r.worker || "미입력"} · ${r.region || "구역 미입력"} [${r.workerId || r.memberCode || "이름 기준"}]`;
      if (kind === "area")
        return r.areaName ?? O.reportDimensions(ws, null, r.region).areaName;
      if (kind === "region") return r.region;
      if (kind === "class")
        return `${r.region || "구역 미입력"} / ${K.label(ws, "className", r.className) || "반 미입력"}`;
      if (kind === "date") return type === "creation" ? r.foundDate : r.date;
      return r.time ? r.time.slice(0, 2) + "시" : "미입력";
    };
    for (const a of activities) {
      const worker = a.workerId || `${a.region}/${a.worker}`,
        add = (l, mins) => {
          const b = get(l);
          b.workers.add(worker);
          b.days.add(a.date);
          b.activities.add(a.id);
          b.minutes += mins;
          if (!a.start || !a.end) b.unknownTimeCount++;
        };
      if (kind !== "hour") add(label(a, "activity"), a.minutes);
      else if (!a.start || !a.end) add("미입력", 0);
      else {
        let cursor =
            Number(a.start.slice(0, 2)) * 60 + Number(a.start.slice(3)),
          end = cursor + M.minutes(a.start, a.end);
        while (cursor < end) {
          const next = Math.min(end, (Math.floor(cursor / 60) + 1) * 60);
          add(
            `${String(Math.floor(cursor / 60) % 24).padStart(2, "0")}시`,
            next - cursor,
          );
          cursor = next;
        }
      }
    }
    for (const r of creations) get(label(r, "creation")).creations++;
    for (const r of reports)
      get(label(r, "report"))[
        r.status === "신규"
          ? "reportedNew"
          : r.status === "유지"
            ? "retained"
            : "dropped"
      ]++;
    result[kind] = [...bins.values()]
      .map((b) => ({
        ...b,
        workers: b.workers.size,
        days: b.days.size,
        activities: b.activities.size,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko", { numeric: true }));
  }
  return result;
}
async function workbook(ws, filters, data, kind = "all") {
  M.assert(
    kind === "all" || Object.hasOwn(TITLES, kind),
    "집계 기준을 확인하세요.",
  );
  const ExcelJS = require("exceljs"),
    wb = new ExcelJS.Workbook();
  wb.creator = "SMOA";
  const keys = kind === "all" ? Object.keys(TITLES) : [kind];
  for (const k of keys) {
    const s = wb.addWorksheet(TITLES[k], {
      views: [{ state: "frozen", ySplit: 4 }],
    });
    s.addRow([`SMOA ${TITLES[k]} 활동·전도 집계`]);
    s.addRow([
      `${filters.from || "전체"} ~ ${filters.to || "전체"} · ${filters.region || "전체 구역"}`,
    ]);
    s.addRow([
      "활동은 구간 시작일, 최초 창출은 찾은날짜, 보고 상태는 보고일 기준입니다. 시간대 활동자는 각 시각에 걸친 고유 인원입니다.",
    ]);
    s.addRow([
      "구분",
      "활동자 수",
      "활동일수",
      "활동 구간 수",
      "활동시간(분)",
      "최초 창출",
      "보고 신규",
      "보고 유지",
      "보고 탈락",
      "시간 미기록",
    ]);
    for (const r of data.dimensions[k])
      s.addRow([
        r.label,
        r.workers,
        r.days,
        r.activities,
        r.activities > 0 && r.unknownTimeCount === r.activities
          ? null
          : r.minutes,
        r.creations,
        r.reportedNew,
        r.retained,
        r.dropped,
        r.unknownTimeCount || 0,
      ]);
  }
  if (kind === "all") {
    const a = wb.addWorksheet("활동 상세");
    a.addRow([
      "활동일",
      "지역",
      "구역",
      "반",
      "활동자",
      "시작",
      "종료",
      "활동시간(분)",
    ]);
    data.activities.forEach((r) =>
      a.addRow([
        new Date(r.date + "T00:00:00Z"),
        r.areaName || "",
        r.region,
        K.label(ws, "className", r.className),
        r.worker,
        r.start,
        r.end,
        r.start && r.end ? r.minutes : null,
      ]),
    );
    a.getColumn(1).numFmt = "yyyy-mm-dd";
    const f = wb.addWorksheet("찾기 상세");
    f.addRow([
      "보고일",
      "지역",
      "구역",
      "단계",
      "구분",
      "찾은날짜",
      "도구",
      "대상자",
      "성별",
      "나이",
      "거주지",
      "찾기장소",
      "찾기시간",
      "인도자",
      "반",
    ]);
    data.records.forEach((r) =>
      f.addRow([
        new Date(r.date + "T00:00:00Z"),
        r.areaName || "",
        r.region,
        ws.stageNames[r.stage],
        r.status,
        r.foundDate ? new Date(r.foundDate + "T00:00:00Z") : null,
        r.tool,
        r.name,
        r.gender,
        r.age,
        r.residence,
        r.place,
        r.time,
        r.worker,
        K.label(ws, "className", r.className),
      ]),
    );
    f.getColumn(1).numFmt = f.getColumn(6).numFmt = "yyyy-mm-dd";
  }
  for (const s of wb.worksheets) {
    s.columns.forEach((c, i) => (c.width = i === 0 ? 35 : 20));
    s.eachRow((r) => {
      r.height = 25;
      r.font = { name: "맑은 고딕", size: 11 };
    });
    const header = s.getRow(Object.values(TITLES).includes(s.name) ? 4 : 1);
    header.eachCell((c) => {
      c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF194B3B" },
      };
      c.font = { name: "맑은 고딕", bold: true, color: { argb: "FFFFFFFF" } };
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports = { TITLES, summarize, workbook };
