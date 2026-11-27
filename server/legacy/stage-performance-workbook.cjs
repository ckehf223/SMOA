"use strict";
const ExcelJS = require("exceljs");

const fraction = (percent) => percent == null ? null : percent / 100;
const periodRateDefinition = "같은 기간의 현재 단계 건수를 직전 단계 건수로 나눕니다. 찾B 실적이 있으면 100%를 기준으로 표시합니다.";

function table(book, name, headers, types = []) {
  const sheet = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = headers.map((header, index) => ({
    header,
    width: Math.max(14, header.length * 2 + 4),
    style: types[index] ? { numFmt: types[index] } : {},
  }));
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF194B3B" } };
    cell.font = { name: "맑은 고딕", bold: true, color: { argb: "FFFFFFFF" } };
  });
  return sheet;
}

function sourceLabel(source) {
  return { reported: "구역 일계", detail: "대상자 상세" }[source] || "자료 부족";
}

function addStrength(book, notes, result, options) {
  const byClass = options.grouping === "class";
  const grouping = byClass ? "반" : "구역";
  const groups = byClass ? result.classes : result.districts;
  const selected = groups.find((row) => row.key === options.strengthGroup);
  const rows = [result.total, ...(selected ? [selected] : groups)];
  const labels = result.stages.map((stage) => stage.label);
  notes.addRows([
    ["조회 기간", result.from || result.to ? `${result.from || "처음"} ~ ${result.to || "전체"}` : "전체"],
    ["집계 단위", grouping],
    ...(selected ? [["표시 범위", selected.label + " 및 전체"]] : []),
    ["자료원", sourceLabel(result.source)],
    ["기간 실적 비율", periodRateDefinition],
    ["전체 실적 비율", "전체의 단계별 건수를 합산한 뒤 직전 단계 건수로 나눕니다."],
    ["평균 대비", "해당 실적을 같은 단계의 구역 또는 반 평균과 비교합니다."],
    ["활동자 100명당", "선택 기간 활동 기록에 있는 고유 활동자 수를 사용합니다."],
    ["빈 셀", "해당 단계의 집계 근거 또는 계산 분모가 없습니다."],
  ]);
  const summary = table(book, "단계향상률 취합", [
    grouping, "활동자 수", ...labels.flatMap((label) => [`${label} 신규`, `${label} 비율`]),
  ], [null, null, ...labels.flatMap(() => [null, "0.0%"])]);
  const strength = table(book, "단계 강약", [
    grouping, "단계", "신규 실적", "평균 실적", "평균 대비", "활동자 100명당",
  ], [null, null, null, "0.0", "+0.0%;-0.0%;0.0%", "0.0"]);
  for (const row of rows) {
    summary.addRow([row.label, row.workers, ...row.stages.flatMap((stage) => [stage.count, fraction(stage.rate)])]);
    for (const stage of row.stages) {
      strength.addRow([row.label, stage.label, stage.count, stage.average, fraction(stage.deviation), stage.per100]);
    }
  }
}

function addTrend(book, notes, result, options) {
  const stage = result.stages.find((item) => item.key === options.trendStage) || result.stages[0];
  const scope = (week, key) => key ? week.districts.find((row) => row.key === key) : week.total;
  const names = new Map(result.weekly.flatMap((week) => week.districts.map((row) => [row.key, row.label])));
  const primary = names.has(options.trendDistrict) ? options.trendDistrict : "";
  const secondary = names.has(options.trendCompare) && options.trendCompare !== primary
    ? options.trendCompare
    : "";
  const keys = secondary ? [primary, secondary] : [primary];
  notes.addRows([
    ["단계", stage.label],
    ["기간 실적 비율", periodRateDefinition],
    ["보유 기준", "주별 집계 종료일 당시 해당 단계에 있던 활성 대상자 수입니다."],
    ["빈 셀", "해당 단계의 집계 근거 또는 계산 분모가 없습니다."],
  ]);
  const trend = table(book, "구역별 8주 추이", [
    "구역", "시작일", "집계 종료일", "주 종료일", "상태", "자료원", "신규 건수", "기간 실적 비율", "기준일 보유",
  ], [null, null, null, null, null, null, null, "0.0%"]);
  function addWeek(sheet, week, state) {
    for (const key of keys) {
      const row = scope(week, key);
      const entry = row?.stages.find((item) => item.key === stage.key);
      sheet.addRow([
        row?.label || names.get(key), week.from, week.to, week.end || null, state,
        sourceLabel(row?.source), entry?.count, fraction(entry?.rate), entry?.stock,
      ]);
    }
  }
  for (const week of result.weekly) addWeek(trend, week, week.partial ? "진행 중" : "완료");
  const latest = result.weekly.at(-1);
  if (latest?.comparison) {
    const comparison = table(book, "전주 같은 요일 비교", [
      "구역", "시작일", "집계 종료일", "주 종료일", "구분", "자료원", "신규 건수", "기간 실적 비율", "기준일 보유",
    ], [null, null, null, null, null, null, null, "0.0%"]);
    addWeek(comparison, latest.comparison, "전주 같은 요일까지");
    addWeek(comparison, latest, "이번 주");
  }
}

async function workbook(result, options = {}) {
  const book = new ExcelJS.Workbook();
  book.creator = "SMOA";
  const notes = table(book, "집계 기준", ["항목", "기준"]);
  notes.getColumn(2).width = 98;
  if (options.stageView === "trend") addTrend(book, notes, result, options);
  else addStrength(book, notes, result, options);
  for (const sheet of book.worksheets.slice(1)) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

module.exports = { workbook };
