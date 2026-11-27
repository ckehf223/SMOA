"use strict";

const ExcelJS = require("exceljs");
const M = require("./model.cjs");
const Calling = require("./calling.cjs");
const { checkZip, cellText } = require("./importer.cjs");
const { parseClock } = require("./clock.cjs");
const { PREVIEW_LIMIT } = require("./import-preview.cjs");

const SHEET = "콜링";
const ROUND_FORMAT = "SMOA 콜링 회차 v2";
const REPORT_FORMAT = "SMOA 콜링 일보 v1";
const HEADERS = [
  "인도자",
  "인도자구역",
  "대상자명",
  "콜링자",
  "콜링날짜",
  "콜링시간",
  "차수",
  "콜링결과",
];
const PERSON_ID = "대상자ID";
const NOTES = "특이사항";
const OPTIONAL_HEADERS = [PERSON_ID, NOTES];
const MAX_ROWS = 30000;
const normalize = (value) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const normalizeArea = (value) => normalize(value).replace(/^(\d+)구역$/, "$1");
const inputHeaders = new Map(
  [...HEADERS, ...OPTIONAL_HEADERS].map((header) => [
    normalize(header),
    header,
  ]),
);
inputHeaders.set("대상자코드", PERSON_ID);

function findHeaders(sheet) {
  const columns = new Map();
  sheet.getRow(1).eachCell((cell) => {
    if (typeof cell.value !== "string") return;
    const header = inputHeaders.get(normalize(cell.value));
    if (!header) return;
    if (columns.has(header)) columns.set(header, null);
    else columns.set(header, cell.isMerged ? null : cell.col);
  });
  return columns;
}

function callDate(raw) {
  const message =
    "콜링날짜는 엑셀 날짜 또는 YYYY-MM-DD 형식으로 입력해 주세요.";
  if (raw instanceof Date && Number.isFinite(raw.valueOf()))
    return M.date(raw.toISOString().slice(0, 10));
  const match = /^(\d{4})([-./])(\d{1,2})\2(\d{1,2})\.?$/.exec(cellText(raw));
  M.assert(match, message);
  const [, year, , month, day] = match;
  return M.date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
}

function importPreview(ws, { migration, report, legacyFifth }) {
  const rows = [],
    errors = [];
  let totalRows = 0,
    duplicateCount = 0,
    errorCount = 0,
    unlinkedCount = 0;
  const issue = (sheet, row, message) => {
    errorCount++;
    if (errors.length < PREVIEW_LIMIT)
      errors.push({ sheet, row, message });
  };

  const profileOf = Calling.personProfile(ws);
  const peopleByName = new Map();
  for (const person of ws.people) {
    const profile = { ...profileOf(person), personId: person.id };
    const key = normalize(profile.personName);
    if (!peopleByName.has(key)) peopleByName.set(key, []);
    peopleByName.get(key).push(profile);
  }
  const existing = ws.callingRecords || [];
  const attempts = Calling.attemptIndex(existing, { matchUnlinked: report });
  function readRow(sheet, row, read) {
    totalRows++;
    try {
      const input = read();
      const name = M.text(input.personName, 100);
      M.assert(name, "대상자명을 입력해 주세요.");
      const introducer = M.text(input.introducer ?? "", 100);
      const area = M.text(input.area ?? "", 60);
      const introducerKey = normalize(introducer);
      const areaKey = normalizeArea(area);
      const code = normalize(M.text(input.personCode ?? "", 60));
      const matches = (peopleByName.get(normalize(name)) || []).filter(
        (person) =>
          (!code || code === normalize(person.personCode)) &&
          (!introducerKey || introducerKey === normalize(person.introducer)) &&
          (!areaKey || areaKey === normalizeArea(person.area)),
      );
      let person = matches[0];
      if (matches.length !== 1) {
        M.assert(
          (report || migration) && !code,
          matches.length
            ? `‘${name}’과 일치하는 대상자가 여러 명입니다. 인도자·구역으로 구분하거나 대상자ID 열을 추가해 주세요.`
            : `대상자 관리에서 ‘${name}’의 이름·인도자·구역을 확인해 주세요.`,
        );
        M.assert(
          areaKey,
          "대상자 미연결 기록은 인도자구역을 입력해 주세요.",
        );
        person = {
          personId: "",
          personCode: "",
          personName: name,
          introducer,
          area,
          findingDate: "",
        };
      }
      const round = Calling.parseRound(input.round, { legacyFifth });
      M.assert(
        round !== undefined,
        `콜링 차수 또는 회차 이름을 ${Calling.MAX_ROUND_LENGTH}자 이내로 입력해 주세요.`,
      );
      const callResult = Calling.parseResult(input.result, { migration, freeText: !migration });
      M.assert(callResult, "콜링결과를 입력해 주세요.");
      const date = M.date(input.date);
      const time = M.time(input.time, false);
      const caller = M.text(input.caller, 100);
      M.assert(caller, "콜링자를 입력해 주세요.");
      const attempt = {
        ...person,
        date,
        time,
        caller,
        round,
        ...callResult,
        notes: M.text(input.notes ?? "", Calling.MAX_NOTES),
      };
      if (report && person.personId)
        attempt.reportPerson = { personName: name, introducer, area };
      if (attempts.has(attempt, attempt.reportPerson)) duplicateCount++;
      else {
        attempts.add(attempt);
        rows.push({ sheet, row, ...attempt });
        if (!person.personId) unlinkedCount++;
      }
    } catch (error) {
      issue(sheet, row, error.message);
    }
  }
  function finish(sheet) {
    if (existing.length + rows.length > Calling.MAX_RECORDS)
      issue(sheet, 1, "가져오면 자료실의 콜링 기록 수 제한을 초과합니다.");
    return {
      rows,
      errors,
      totalRows,
      duplicateCount,
      errorCount,
      unlinkedCount,
      validCount: rows.length,
    };
  }
  return { issue, readRow, finish };
}

function previewRows(ws, rows, { migration = false } = {}) {
  M.assert(
    Array.isArray(rows) && rows.length <= MAX_ROWS,
    `콜링 일보는 최대 ${MAX_ROWS.toLocaleString("ko-KR")}행까지 가져올 수 있습니다.`,
  );
  const sheetName = "콜링 일보";
  const result = importPreview(ws, { migration, report: !migration, legacyFifth: false });
  rows.forEach((row, index) =>
    result.readRow(row.sheet ?? sheetName, row.row ?? index + 1, () => row),
  );
  return result.finish(sheetName);
}

async function preview(ws, buffer, { migration = false } = {}) {
  checkZip(buffer, { allowPrinterSettings: true });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, {
    ignoreNodes: ["drawing", "legacyDrawing", "extLst", "pageSetup"],
  });
  const reportWorkbook = workbook.subject === REPORT_FORMAT;
  const result = importPreview(ws, {
    migration: migration && !reportWorkbook,
    report: reportWorkbook,
    legacyFifth: !reportWorkbook && (migration || workbook.subject !== ROUND_FORMAT),
  });
  const worksheets = workbook.worksheets.map((sheet) => ({
    sheet,
    columns: findHeaders(sheet),
  }));
  const named = worksheets.find(({ sheet }) =>
    [SHEET, "콜링기록"].includes(normalize(sheet.name)),
  );
  const candidates = named
    ? [named]
    : worksheets.filter(({ columns }) =>
        HEADERS.every((header) => columns.has(header)),
      );
  if (candidates.length !== 1) {
    result.issue(
      SHEET,
      1,
      candidates.length
        ? "콜링 양식과 일치하는 시트가 여러 개입니다. 가져올 시트의 이름을 ‘콜링’으로 지정해 주세요."
        : "콜링 시트와 첫 행의 머리글을 확인해 주세요. 앱에서 콜링 엑셀 양식을 받을 수 있습니다.",
    );
    return result.finish(SHEET);
  }

  const [{ sheet, columns }] = candidates;
  const invalid = HEADERS.filter((header) => !columns.get(header));
  invalid.push(
    ...OPTIONAL_HEADERS.filter(
      (header) => columns.has(header) && !columns.get(header),
    ),
  );
  if (invalid.length) {
    result.issue(
      sheet.name,
      1,
      `머리글의 누락, 중복 또는 병합을 확인해 주세요. ${invalid.join(", ")}`,
    );
    return result.finish(sheet.name);
  }
  M.assert(
    sheet.rowCount <= MAX_ROWS + 1,
    `콜링 엑셀은 최대 ${MAX_ROWS.toLocaleString("ko-KR")}행까지 가져올 수 있습니다.`,
  );
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const cells = Array.from(columns.values(), (column) => row.getCell(column));
    if (
      !cells.some(
        ({ value }) =>
          value != null && (typeof value !== "string" || value.trim()),
      )
    )
      return;
    result.readRow(sheet.name, number, () => {
      M.assert(
        !cells.some((cell) => cell.isMerged),
        "입력한 셀의 병합을 해제해 주세요.",
      );
      const read = (header) =>
        columns.has(header) ? row.getCell(columns.get(header)).value : null;
      const rawTime = read("콜링시간");
      return {
        personName: cellText(read("대상자명")),
        introducer: cellText(read("인도자")),
        area: cellText(read("인도자구역")),
        personCode: cellText(read(PERSON_ID)),
        round: cellText(read("차수")),
        result: cellText(read("콜링결과")),
        date: callDate(read("콜링날짜")),
        time: parseClock(
          rawTime instanceof Date || typeof rawTime === "number"
            ? rawTime
            : cellText(rawTime),
        ),
        caller: cellText(read("콜링자")),
        notes: cellText(read(NOTES)),
      };
    });
  });
  const summary = result.finish(sheet.name);
  return reportWorkbook ? { ...summary, reportWorkbook } : summary;
}

function createCallingSheet(workbook, subject = ROUND_FORMAT) {
  workbook.subject = subject;
  const sheet = workbook.addWorksheet(SHEET, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const widths = [20, 18, 24, 20, 17, 15, 20, 16, 42];
  sheet.columns = [...HEADERS, NOTES].map((header, i) => ({
    header,
    width: widths[i],
  }));
  sheet.autoFilter = "A1:I1";
  const heading = sheet.getRow(1);
  heading.height = 25;
  heading.font = { color: { argb: "FFFFFFFF" }, bold: true };
  heading.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF23416C" },
  };
  heading.alignment = { vertical: "middle" };
  sheet.getColumn(5).numFmt = "yyyy-mm-dd";
  sheet.getColumn(6).numFmt = "hh:mm";
  sheet.getColumn(9).numFmt = "@";
  return sheet;
}

async function createExport(rows, { report = false } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = createCallingSheet(workbook, report ? REPORT_FORMAT : ROUND_FORMAT);
  sheet.getColumn(9).alignment = { vertical: "top", wrapText: true };
  for (const row of rows) {
    const time = row.time || "";
    const [hours, minutes] = time.split(":").map(Number);
    sheet.addRow([
      row.introducer,
      row.area,
      row.personName,
      row.caller,
      new Date(`${row.date}T00:00:00Z`),
      time ? (hours * 60 + minutes) / 1440 : null,
      Calling.roundLabel(row.round),
      row.reportedResult || row.originalResult || row.result,
      row.notes ?? "",
    ]);
  }
  sheet.autoFilter = `A1:I${sheet.rowCount}`;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = createCallingSheet(workbook);
  sheet.dataValidations.add(`G2:G${MAX_ROWS + 1}`, {
    type: "list",
    allowBlank: true,
    formulae: [`"${Calling.ROUND_LABELS.join(",")}"`],
    showErrorMessage: false,
  });
  const guide = workbook.addWorksheet("작성안내");
  guide.columns = [{ width: 21 }, { width: 94 }];
  guide.addRows([
    [
      "대상자 확인",
      "대상자명을 적습니다. 아는 경우 인도자와 인도자구역을 적어 동명이인을 구분합니다.",
    ],
    [
      "동명이인",
      "이름·인도자·구역이 같은 경우 대상자ID 열을 추가해 대상자 관리의 식별번호를 적습니다.",
    ],
    [
      "콜링날짜·시간",
      "콜링날짜는 YYYY-MM-DD로 입력합니다. 콜링시간은 HH:mm 형식으로 입력하고, 모르는 경우 비워 둡니다.",
    ],
    [
      "차수",
      `차수는 ${Calling.ROUND_LABELS.join("·")} 중 하나를 선택하거나 5차·수능인원처럼 직접 입력합니다. 기존 양식과 MIG의 5차는 추가회차로 가져옵니다.`,
    ],
    [
      "콜링결과",
      "결과를 자유롭게 적습니다. 만남 약속이 잡힌 기록은 만픽으로 적으면 결과 보고에서 연결로 집계합니다.",
    ],
    [
      "특이사항",
      `필요할 때 ${Calling.MAX_NOTES.toLocaleString("ko-KR")}자까지 적습니다. 같은 통화 기록의 특이사항은 콜링 관리에서 수정합니다.`,
    ],
    [
      "가져오기",
      "미리보기에서 연결과 오류를 확인한 뒤 저장합니다. 같은 대상자의 날짜·시간·콜링자·차수·결과가 모두 같은 기록은 건너뜁니다.",
    ],
    [
      "MIG 이전 자료",
      "MIG로 가져올 때 대상자명과 구역이 있으면 확인할 수 없는 연결은 비워 둡니다. 기존 결과명은 보존하며, 차수 ‘추가’는 ‘추가회차’로 읽습니다.",
    ],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { preview, previewRows, createTemplate, createExport };
