"use strict";

const Excel = require("exceljs");
const M = require("./model.cjs");
const { addIssue, inputFields, issueFields, ISSUE_LIMIT } = require("./daily-area-import-issues.cjs");
const {
  activityHeaders,
  findingHeaders,
  updateHeaders,
  updateContactIdentity,
  updateIdentity,
  format,
} = require("./daily-area-workbook.cjs");

const sheets = {
  activity: { name: "활동자", headers: activityHeaders },
  finding: { name: "찾기", headers: findingHeaders },
  updates: { name: "업데이트", headers: updateHeaders },
};
const detailPageSize = 20;
const dateColumns = new Set([
  "찾B",
  "만픽",
  "찾A",
  "탈락",
  "합B",
  "합A\n(육따)",
  "영따",
  "복신",
  "신카접수",
  "센터등록",
  "입교",
]);
const headerKey = (value) =>
  String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, "")
    .toUpperCase();
const cellValue = (value) =>
  Array.isArray(value?.richText)
    ? value.richText.map((run) => run.text).join("")
    : value;

function validDate(value) {
  try {
    return M.date(value) >= "1900-01-01" ? value : "";
  } catch {
    return "";
  }
}

function matchesHeaders(sheet, headers) {
  const row = sheet.getRow(1);
  return (
    row.values.slice(headers.length + 1).every((value) => !value) &&
    headers.every(
      (header, index) =>
        headerKey(cellValue(row.getCell(index + 1).value)) ===
        headerKey(header),
    )
  );
}

function readDistrictMap(value) {
  return new Map(
    Object.entries(value || {})
      .slice(0, 10000)
      .filter(
        ([key, district]) =>
          /^[a-f\d]{64}$/u.test(key) &&
          (district === null ||
            (typeof district === "string" && district.length <= 100)),
      ),
  );
}

function select(workbook, fileName = "") {
  let metadata;
  try {
    const parsed = JSON.parse(workbook.description);
    if (parsed?.format === format) metadata = parsed;
  } catch {}
  const available = Object.keys(sheets).filter((key) =>
    workbook.getWorksheet(sheets[key].name),
  );
  if (
    !available.length ||
    (!metadata &&
      available.length !== 3 &&
      !available.some((key) =>
        matchesHeaders(
          workbook.getWorksheet(sheets[key].name),
          sheets[key].headers,
        ),
      ))
  )
    return null;

  const archiveDate = fileName.match(
    /^일보분석-(\d{4}-\d{2}-\d{2})(?:-\d+| \(\d+\))?\.xlsx$/iu,
  )?.[1];
  const summary = cellValue(
    workbook.getWorksheet("활동자보고")?.getCell("A2").value,
  );
  const label =
    typeof summary === "string" &&
    summary.match(
      /^\s*(\d{1,2})\/(\d{1,2})\s*\([월화수목금토일]\)\s*전도 일일 보고 현황/u,
    );
  const monthDay = label
    ? `${label[1].padStart(2, "0")}-${label[2].padStart(2, "0")}`
    : "";
  const date = validDate(metadata?.date) || validDate(archiveDate);
  const activityDistricts =
    Array.isArray(metadata?.activityDistricts) &&
    metadata.activityDistricts.length <= 10000 &&
    metadata.activityDistricts.every(
      (district) => typeof district === "string" && district.length <= 100,
    )
      ? metadata.activityDistricts
      : undefined;
  return {
    workbook,
    fileName,
    available,
    date,
    monthDay,
    activityDistricts,
    updateDistricts: readDistrictMap(metadata?.updateDistricts),
    updateDistrictsByContact: readDistrictMap(metadata?.updateDistrictsByContact),
  };
}

async function read(buffer, fileName) {
  require("./importer.cjs").checkZip(buffer, { allowPrinterSettings: true });
  const workbook = new Excel.Workbook();
  await workbook.xlsx.load(buffer, {
    ignoreNodes: ["drawing", "legacyDrawing", "extLst", "pageSetup"],
  });
  return select(workbook, fileName);
}

function updateDistrict(source, values) {
  const byContact = source.updateDistrictsByContact.get(updateContactIdentity(values));
  if (typeof byContact === "string") return byContact;
  const byDate = source.updateDistricts.get(updateIdentity(values));
  return byDate === undefined ? byContact : byDate;
}

function readRows(source, scope, date, errors, warnings, issues, details) {
  const { name, headers } = sheets[scope];
  const sheet = source.workbook.getWorksheet(name);
  const issue = (severity, message, row = null, fields = []) => {
    const location = row ? `${name} ${row}행 · ` : "";
    const summary = location + message;
    (severity === "error" ? errors : warnings).push(summary);
    addIssue(issues, { sheet: name, row, severity, message, summary, fields });
  };
  if (!matchesHeaders(sheet, headers)) {
    issue("error", `${name} 시트의 열 제목이나 순서를 확인해 주세요.`);
    return [];
  }
  if (sheet.actualRowCount > 30001) {
    issue("error", `${name} 시트는 한 번에 30,000행까지 가져올 수 있습니다.`);
    return [];
  }
  const rows = [];
  sheet.eachRow((row, number) => {
    if (number <= 1) return;
    let values = {};
    let invalidCell;
    try {
      const columns = headers.map((header, index) => {
        const cell = row.getCell(index + 1);
        let value = cellValue(cell.value);
        if (typeof value === "number" && source.workbook.properties.date1904 && dateColumns.has(header))
          value = new Date(Date.UTC(1904, 0, 1) + Math.floor(value) * 86400000);
        return { header, cell, value: value === "" ? null : value };
      });
      values = Object.fromEntries(columns.map(({ header, value }) => [header, value]));
      const extraColumn = row.values.findIndex(
        (value, index) => index > headers.length && value != null && value !== "",
      );
      if (extraColumn !== -1) {
        invalidCell = row.getCell(extraColumn);
        throw new Error("일보 양식에 없는 열에 값이 있습니다.");
      }
      for (const { header, cell, value } of columns) {
        if (value == null || (!cell.isMerged && (
          typeof value === "string" || typeof value === "number" || value instanceof Date
        ))) continue;
        invalidCell = cell;
        throw new Error(`${header.trim()} 열의 수식, 오류 값, 병합을 확인해 주세요.`);
      }
      if (
        !Object.values(values).some(
          (value) => value != null && String(value).trim(),
        )
      )
        return;
      const district =
        scope === "updates" ? updateDistrict(source, values) : undefined;
      if (district === null) {
        const message = "대상자 정보에 해당하는 원본 구역이 여러 개입니다.";
        issue(
          "warning", message, number, inputFields(name, values, { date }),
        );
        details.push({ sheet: name, row: number, outcome: "확인 필요", message, values, date });
        return;
      }
      rows.push({ row: number, values, district });
    } catch (error) {
      issue("error", error.message, number, [
        ...inputFields(name, values, { date }),
        ...issueFields([
          ["문제 셀", invalidCell?.address],
          ["셀 값", cellValue(invalidCell?.value)],
        ]),
      ]);
    }
  });
  return rows;
}

function preview(workspace, source, { date: supplied = "", scopes }, actor) {
  M.assert(
    Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.length <= source.available.length &&
      scopes.every((scope) => source.available.includes(scope)) &&
      new Set(scopes).size === scopes.length,
    "가져올 시트를 선택해 주세요.",
  );
  const date = validDate(supplied || source.date);
  const errors = [],
    warnings = [],
    counts = {};
  const issues = [];
  const details = [];
  const reportIssue = (message, fields) => {
    errors.push(message);
    addIssue(issues, { severity: "error", message, fields });
  };
  const mergeIssues = (result) => {
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    issues.push(...result.issues.slice(0, ISSUE_LIMIT - issues.length));
    for (const row of result.details) details.push(row);
  };
  const reportDates = issueFields([
    ["엑셀 보고일", source.date || source.monthDay],
    ["입력한 보고일", supplied],
  ]);
  if (!date) reportIssue("일보의 보고일을 입력해 주세요.", reportDates);
  else if (
    (source.date && date !== source.date) ||
    (source.monthDay && date.slice(5) !== source.monthDay)
  )
    reportIssue("엑셀에 기록된 보고일과 입력한 날짜가 다릅니다.", reportDates);
  const selected = Object.fromEntries(
    scopes.map((scope) => [scope, readRows(source, scope, date, errors, warnings, issues, details)]),
  );
  const updatesNeedingReview = details.length;
  const draft = M.copy(workspace);
  if (!errors.length) {
    if (selected.activity) {
      const result = require("./daily-area-activity-import.cjs").applyActivity(
        draft,
        {
          activity: selected.activity,
          date,
          activityDistricts: source.activityDistricts,
        },
        actor,
      );
      counts.activity = result.counts;
      mergeIssues(result);
    }
    if (selected.finding || selected.updates) {
      const result = require("./daily-area-target-import.cjs").applyTargets(
        draft,
        {
          finding: selected.finding || [],
          updates: selected.updates || [],
          date,
        },
        actor,
      );
      for (const scope of ["finding", "updates"])
        if (selected[scope]) counts[scope] = result.counts[scope];
      if (counts.updates) counts.updates["확인 필요"] += updatesNeedingReview;
      mergeIssues(result);
    }
  }
  if (!errors.length) {
    try {
      M.validateWorkspace(draft);
    } catch (error) {
      reportIssue(error.message);
    }
  }
  const canApply = !errors.length && draft.revision !== workspace.revision;
  return {
    date,
    counts,
    canApply,
    errors: errors.slice(0, 300),
    totalErrors: errors.length,
    warnings: warnings.slice(0, 300),
    totalWarnings: warnings.length,
    issues,
    totalIssues: errors.length + warnings.length,
    details,
    draft: canApply ? draft : null,
  };
}

function detailsPage(details, { sheet, outcome, page }) {
  M.assert(
    Object.values(sheets).some(({ name }) => name === sheet) &&
      typeof outcome === "string" &&
      Number.isSafeInteger(page) && page > 0,
    "확인할 시트와 처리 내역을 다시 선택해 주세요.",
  );
  const matching = details
    .filter((row) => row.sheet === sheet && row.outcome === outcome)
    .sort((left, right) => left.row - right.row);
  const lastPage = Math.max(1, Math.ceil(matching.length / detailPageSize));
  const currentPage = Math.min(page, lastPage);
  const start = (currentPage - 1) * detailPageSize;
  return {
    items: matching.slice(start, start + detailPageSize).map(({ values, district, date, ...row }) => ({
      ...row,
      fields: inputFields(row.sheet, values, { district, date }),
    })),
    total: matching.length,
    page: currentPage,
    pageSize: detailPageSize,
  };
}

module.exports = { select, read, preview, detailsPage };
