"use strict";
const ExcelJS = require("exceljs");
const M = require("./model.cjs");
const O = require("./organization.cjs");
const { checkZip } = require("./importer.cjs");
const { duplicateCollector } = require("./import-preview.cjs");

const SHEET = "활동기록";
const CODE_HEADERS = ["활동종류", "활동여부", "종료시간"];
const MAX_ROWS = 30000;
const clean = (value) => value.trim().normalize("NFC");
const blank = (value) =>
  value == null || (typeof value === "string" && !value.trim());
const textValue = (value) =>
  typeof value === "string"
    ? value
    : value?.richText?.map((run) => run.text).join("");

function readText(cell, label, limit) {
  if (!cell || blank(cell.value)) return "";
  const value = cell.value;
  M.assert(!cell.isMerged, `${label}의 셀 병합을 해제해 주세요.`);
  const text = textValue(value);
  M.assert(
    typeof text === "string" && text.length <= limit,
    `${label}을 ${limit}자 이내 문자로 입력해 주세요.`,
  );
  return clean(text);
}

function readCode(cell, header) {
  const value = cell.value;
  M.assert(!blank(value), `${header} 열에 활동 구분 번호(1~4)를 입력해 주세요.`);
  const normalized = typeof value === "string" ? value.trim() : value;
  M.assert(
    !cell.isMerged &&
      (typeof normalized === "number" || typeof normalized === "string") &&
      /^[1-4]$/.test(String(normalized)),
    `${header} 열에는 1, 2, 3, 4 중 하나를 입력해 주세요.`,
  );
  return Number(normalized);
}

function readDate(cell) {
  const message = "날짜를 엑셀 날짜 또는 YYYY-MM-DD 형식으로 입력해 주세요.";
  M.assert(!cell.isMerged, "날짜의 셀 병합을 해제해 주세요.");
  const raw = cell.value;
  let value;
  if (raw instanceof Date) {
    M.assert(Number.isFinite(raw.valueOf()), message);
    value = raw.toISOString().slice(0, 10);
    M.assert(value >= "1900-01-01", message);
  } else {
    M.assert(typeof raw === "string", message);
    const match = /^(\d{4})([-./])(\d{1,2})\2(\d{1,2})\.?$/.exec(raw.trim());
    M.assert(match, message);
    const [, year, , month, day] = match;
    value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  M.assert(!value.startsWith("0000"), message);
  try {
    return M.date(value);
  } catch {
    throw new Error(message);
  }
}

async function preview(ws, buffer, options = {}) {
  const month = options.month ?? null,
    region = clean(M.text(options.region || "", 60));
  // This workbook can carry Excel printer settings. The importer ignores the
  // related worksheet metadata and keeps the archive's normal size guards.
  checkZip(buffer, { allowPrinterSettings: true });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, {
    ignoreNodes: ["drawing", "legacyDrawing", "extLst", "pageSetup"],
  });
  if (options.dailyAreaFile !== undefined) {
    const dailyArea = require("./daily-area-import.cjs").select(workbook, options.dailyAreaFile);
    if (dailyArea) return { dailyArea };
  }
  const sheet = workbook.getWorksheet(SHEET),
    duplicate = duplicateCollector(),
    rows = [],
    errors = [],
    counts = {
      total: 0,
      valid: 0,
      errors: 0,
      insert: 0,
      replace: 0,
      unchanged: 0,
    };
  let dateMode = false,
    firstDate = null,
    lastDate = null;
  const result = () => ({
    month,
    region,
    dateMode,
    firstDate,
    lastDate,
    sheet: SHEET,
    rows,
    errors,
    counts: { ...counts, valid: rows.length, errors: errors.length },
    canCommit: rows.length > 0 && errors.length === 0,
    ...duplicate.result(),
  });
  if (!sheet) {
    errors.push({ row: 1, message: "활동기록 시트를 찾을 수 없습니다." });
    return result();
  }
  const columns = new Map(),
    headerCells = new Map();
  let codeHeader;
  try {
    sheet.getRow(1).eachCell((cell) => {
      const header = clean(textValue(cell.value) || "");
      if (!header) return;
      if (!headerCells.has(header)) headerCells.set(header, []);
      headerCells.get(header).push(cell);
    });
    codeHeader = CODE_HEADERS.find((header) => headerCells.has(header));
    M.assert(
      headerCells.has("이름") && codeHeader,
      "첫 행에 이름과 활동종류(또는 활동여부) 머리글을 넣어 주세요. 이전 종료시간 양식도 사용할 수 있습니다.",
    );
    const legacy = codeHeader === "종료시간";
    M.assert(legacy || headerCells.has("날짜"), "첫 행에 날짜 머리글이 필요합니다.");
    const usedHeaders = ["날짜", "이름", codeHeader];
    if (legacy) usedHeaders.push("구성원ID", "구역");
    for (const header of usedHeaders) {
      const cells = headerCells.get(header);
      if (!cells) continue;
      M.assert(cells.length === 1, `첫 행에 ${header} 머리글이 두 번 있습니다.`);
      M.assert(!cells[0].isMerged, `${header} 머리글의 셀 병합을 해제해 주세요.`);
      columns.set(header, cells[0].col);
    }
  } catch (error) {
    errors.push({ row: 1, message: error.message });
    return result();
  }
  dateMode = columns.has("날짜");
  if (!dateMode)
    M.assert(
      typeof month === "string" &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
        !month.startsWith("0000"),
      "기록 월을 YYYY-MM 형식으로 선택해 주세요.",
    );
  M.assert(
    sheet.actualRowCount <= MAX_ROWS + 1,
    `한 번에 ${MAX_ROWS.toLocaleString("ko-KR")}행까지 가져올 수 있습니다.`,
  );

  const org = O.get(ws),
    usedColumns = [...columns.values()],
    existing = new Map(),
    byIdentifier = new Map(),
    byName = new Map(),
    candidates = [],
    firstRow = new Map(),
    duplicates = new Set();
  for (const entry of ws.regionalActivities || []) {
    if (dateMode ? entry.date : !entry.date && entry.month === month)
      existing.set(`${entry.date || entry.month}/${entry.memberId}`, entry);
  }
  for (const member of org.members) {
    const item = { member, region: O.regionOf(org, member.unitId) };
    // Index the member code and internal ID together. A collision must stay ambiguous.
    for (const id of new Set([member.id, member.code])) {
      if (!byIdentifier.has(id)) byIdentifier.set(id, []);
      byIdentifier.get(id).push(item);
    }
    const name = clean(member.name);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(item);
  }
  sheet.eachRow((data, row) => {
    if (row === 1) return;
    if (usedColumns.every((index) => blank(data.getCell(index).value))) return;
    counts.total++;
    const cell = (header) =>
      columns.has(header) ? data.getCell(columns.get(header)) : null;
    try {
      const date = dateMode ? readDate(cell("날짜")) : null,
        period = date || month,
        rowMonth = date ? date.slice(0, 7) : month,
        name = readText(cell("이름"), "이름", 100),
        identifier = readText(cell("구성원ID"), "구성원ID", 80),
        rowRegion = readText(cell("구역"), "구역", 60),
        code = readCode(cell(codeHeader), codeHeader);
      M.assert(name || identifier, "이름 또는 구성원ID를 입력해 주세요.");
      M.assert(
        !region || !rowRegion || region === rowRegion,
        "행의 구역이 선택한 구역과 다릅니다.",
      );
      const scopedRegion = region || rowRegion,
        matches = identifier
          ? byIdentifier.get(identifier) || []
          : byName.get(name) || [];
      M.assert(
        matches.length,
        identifier
          ? "명부에서 구성원ID를 찾을 수 없습니다."
          : "명부에서 같은 이름을 찾을 수 없습니다.",
      );
      const matchedRecords = matches.map((item) => {
        const key = `${period}/${item.member.id}`,
          record = existing.get(key);
        return {
          key,
          member: item.member,
          region: record?.region ?? item.region,
          record,
        };
      });
      const scoped = scopedRegion
        ? matchedRecords.filter(
            (item) => clean(item.region || "") === scopedRegion,
          )
        : matchedRecords;
      M.assert(scoped.length, "일치하는 구성원이 지정한 구역에 없습니다.");
      M.assert(
        scoped.length === 1,
        "동명이인 또는 중복 ID가 있습니다. 구성원ID와 구역을 확인해 주세요.",
      );
      const { key, member, region: recordRegion, record } = scoped[0];
      M.assert(
        !name || clean(member.name) === name,
        "이름과 구성원ID가 같은 명부 항목을 가리키는지 확인해 주세요.",
      );
      const first = firstRow.get(key);
      if (first) {
        const priorRow = first.row,
          periodLabel = dateMode ? "날짜" : "월",
          message = `같은 ${periodLabel}의 동일 구성원 기록이 여러 행에 있습니다.`;
        duplicate.add(
          SHEET,
          row,
          {
            name: member.name,
            memberCode: member.code,
            region: recordRegion,
            month: rowMonth,
            ...(date ? { date } : {}),
            code,
          },
          first,
          {
            matchedRow: priorRow,
            matchedSheet: SHEET,
            blocking: true,
            reason: `같은 ${periodLabel}의 동일 구성원이 파일에서 반복됩니다.`,
          },
        );
        if (!duplicates.has(priorRow))
          errors.push({
            row: priorRow,
            message,
          });
        duplicates.add(priorRow);
        throw new Error(message);
      }
      const candidate = {
        row,
        memberId: member.id,
        memberCode: member.code,
        name: member.name,
        region: recordRegion || "",
        month: rowMonth,
        ...(date ? { date } : {}),
        code,
        previousCode: record?.code ?? null,
        action: !record
          ? "insert"
          : record.code === code
            ? "unchanged"
            : "replace",
      };
      firstRow.set(key, candidate);
      candidates.push(candidate);
    } catch (error) {
      errors.push({ row, message: error.message });
    }
  });
  for (const candidate of candidates) {
    if (duplicates.has(candidate.row)) continue;
    rows.push(candidate);
    if (candidate.date) {
      if (!firstDate || candidate.date < firstDate) firstDate = candidate.date;
      if (!lastDate || candidate.date > lastDate) lastDate = candidate.date;
    }
    counts[candidate.action]++;
    if (candidate.action === "unchanged")
      duplicate.add(SHEET, candidate.row, candidate, {
        name: candidate.name,
        memberCode: candidate.memberCode,
        region: candidate.region,
        month: candidate.month,
        ...(candidate.date ? { date: candidate.date } : {}),
        code: candidate.previousCode,
      });
  }
  if (!counts.total)
    errors.push({ row: 2, message: "가져올 활동기록이 없습니다." });
  errors.sort((a, b) => a.row - b.row);
  return result();
}

module.exports = { preview };
