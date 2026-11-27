"use strict";

const M = require("./model.cjs");
const Calling = require("./calling.cjs");
const { parseClock } = require("./clock.cjs");
const { PREVIEW_LIMIT } = require("./import-preview.cjs");

const SHEET = "콜링 일보";
const MAX_TEXT = 500000;
const SECTION_MARK = /^(?:✅|☑\uFE0F?|✔\uFE0F?|🔶|🔷)\s*/u;
const normalize = (value) => value.normalize("NFKC").replace(/\s+/gu, "");
const isBlank = (value) => /^(?:-|–|—)?$/u.test(value);
const DISTRICT = /^(\d+)\s*구역(?:\s*\([^)]*\))?$/u;
const CALLER_SUMMARY = /^([^/／]+)[/／]([^/／]*)$/u;
const COUNT_FIELD = /^(?:[\d,]+건?|[-–—?])$/u;

function headingText(line) {
  return line
    .replace(/^\\(?=[-*])/u, "")
    .replace(/^[-*▪▫•]\s+(?!\s*[/／])/u, "")
    .replace(/^\*\*(.*)\*\*$/u, "$1")
    .trim();
}

function districtHeading(line) {
  const match = DISTRICT.exec(line.replace(/^\[(.*)\]$/u, "$1"));
  return match ? match[1].replace(/^0+(?=\d)/u, "") + "구역" : "";
}

function roundHeading(line, followByDistrict) {
  const marked = SECTION_MARK.test(line);
  const label = headingText(line.replace(SECTION_MARK, "").trim());
  const named = /^(?:회차|차수|구분)\s*[:：]\s*(.+)$/u.exec(label);
  const value = (named?.[1] ?? label).replace(/\s*콜링$/u, "").trim();
  const compact = normalize(value);
  if (/^(?:신규|\d+(?:회)?차)$/u.test(compact)) return compact;
  if (/^추가(?:회차)?$/u.test(compact)) return "추가회차";
  if (
    value &&
    !/[/／]/u.test(value) &&
    (marked ||
      named ||
      /콜링$/u.test(label) ||
      compact === "수능인원" ||
      followByDistrict)
  )
    return value;
  return null;
}

function reportDate(value, year) {
  const match =
    /^(?:(\d{4})[-./]\s*)?(\d{1,2})\s*[-./]\s*(\d{1,2})(?:\s*\([월화수목금토일](?:요일)?\))?$/u.exec(
      value.trim(),
    );
  M.assert(match, "일보 날짜는 11/22 또는 2026-11-22 형식으로 입력해 주세요.");
  const yearValue = match[1] || year;
  M.assert(yearValue, "일보 날짜에 연도가 없으면 조회할 연도를 입력해 주세요.");
  const date = [
    yearValue,
    match[2].padStart(2, "0"),
    match[3].padStart(2, "0"),
  ].join("-");
  const timestamp = new Date(date + "T00:00:00Z");
  M.assert(
    Number.isFinite(timestamp.getTime()) &&
      timestamp.toISOString().slice(0, 10) === date,
    "일보 날짜를 확인해 주세요.",
  );
  return date;
}

function detailHeader(line) {
  const key = normalize(line);
  const match =
    /^(콜링자\/)?인도자\/대상자(?:명)?\/(?:시간대|(?:콜링)?시간)\/(?:콜링)?결과(?:\/특이사항)?\/?$/u.exec(
      key,
    );
  return match ? { includesCaller: Boolean(match[1]) } : null;
}

function detailFields(line, includesCaller) {
  const fixedFields = includesCaller ? 5 : 4;
  const fields = [];
  let consumed = 0;
  for (const delimiter of line.matchAll(/[/／]/gu)) {
    fields.push(line.slice(consumed, delimiter.index).trim());
    consumed = delimiter.index + 1;
    if (fields.length === fixedFields) break;
  }
  fields.push(line.slice(consumed).trim());
  M.assert(
    fields.length >= fixedFields,
    "인도자/대상자/시간대/결과/특이사항 순서와 / 구분자를 확인해 주세요.",
  );
  if (fields.length === fixedFields) fields.push("");
  const caller = includesCaller ? fields.shift() : "";
  const [introducer, personName, time, result, notes] = fields;
  M.assert(personName && !isBlank(personName), "대상자명을 입력해 주세요.");
  M.assert(result && !isBlank(result), "콜링 결과를 입력해 주세요.");
  return {
    caller: M.text(isBlank(caller) ? "" : caller, 100),
    introducer: M.text(isBlank(introducer) ? "" : introducer, 100),
    personName: M.text(personName, 100, true),
    time: parseClock(isBlank(time) ? "" : time),
    result: M.text(result, 100, true),
    notes: M.text(notes, Calling.MAX_NOTES),
  };
}

function parse(text, { date: selectedDate = "", year = "", caller = "" } = {}) {
  M.assert(
    typeof text === "string" && text.trim() && text.length <= MAX_TEXT,
    "콜링 일보는 500,000자 이내로 입력해 주세요.",
  );
  M.assert(
    year === "" || /^[1-9]\d{3}$/.test(String(year)),
    "일보 연도는 네 자리 숫자로 입력해 주세요.",
  );
  M.assert(
    typeof selectedDate === "string" &&
      (selectedDate === "" || /^\d{4}-\d{2}-\d{2}$/u.test(selectedDate)),
    "가져올 콜링 날짜를 확인해 주세요.",
  );
  const fallbackDate = selectedDate ? reportDate(selectedDate, "") : "";
  const fallbackYear = year || fallbackDate.slice(0, 4);
  const fallbackCaller = M.text(caller, 100);
  const rows = [];
  const errors = [];
  let errorCount = 0;
  let totalRows = 0;

  const issue = (row, message) => {
    errorCount++;
    if (errors.length < PREVIEW_LIMIT) errors.push({ sheet: SHEET, row, message });
  };

  let date = fallbackDate;
  let round = "";
  let district = "";
  let summaryMode = false;
  let inFooter = false;
  let includesCaller = false;
  let explicitCaller = "";
  const reportedCallers = new Map();
  const resetReport = () => {
    district = "";
    round = "";
    summaryMode = false;
    inFooter = false;
    includesCaller = false;
    explicitCaller = "";
    reportedCallers.clear();
  };
  const sources = text.split(/\r\n?|\n/u);
  const markdownLineBreaks = sources.some((source) =>
    /^\\(?:$|[-*]\s)/u.test(source.trim()),
  );
  const lines = sources
    .map((source, index) => {
      const text = source.trim();
      return {
        row: index + 1,
        value: headingText(text.replace(/\\$/u, "").trimEnd()),
        detail: headingText(
          markdownLineBreaks ? text.replace(/(?<!\b[a-z]:)\\$/iu, "") : text,
        ),
      };
    })
    .filter(({ value }) => value);

  for (const [index, { row, value, detail }] of lines.entries()) {
    if (/^(?:☎\uFE0F?\s*)?콜링\s*(?:배분|일보)(?:\s*☎\uFE0F?)?$/u.test(value)) {
      if (inFooter || district) {
        resetReport();
        date = fallbackDate || date;
      }
      continue;
    }
    const dateLine = /^(?:콜링\s*)?날짜\s*[:：]\s*(.*)$/u.exec(value);
    if (dateLine) {
      resetReport();
      date = "";
      try {
        date = reportDate(dateLine[1], fallbackYear);
      } catch (error) {
        issue(row, error.message);
      }
      continue;
    }
    if (
      /^(?:ex|예시?)\s*[):：]/iu.test(value) ||
      /^결과의\s*지정된\s*값/u.test(value)
    )
      inFooter = true;
    if (inFooter) continue;

    if (/^콜링자[/／](?:건수|콜링건수)$/u.test(normalize(value))) {
      summaryMode = true;
      continue;
    }
    const callerLine = /^콜링자\s*[:：]\s*(.*)$/u.exec(value);
    if (callerLine) {
      try {
        explicitCaller = M.text(callerLine[1], 100, true);
        summaryMode = false;
      } catch {
        issue(row, "‘콜링자: 이름’ 형식으로 콜링자를 입력해 주세요.");
      }
      continue;
    }

    const newDistrict = districtHeading(value);
    if (newDistrict) {
      district = newDistrict;
      summaryMode = false;
      continue;
    }
    const newRound = roundHeading(
      value,
      !round && Boolean(districtHeading(lines[index + 1]?.value ?? "")),
    );
    if (newRound) {
      district = "";
      try {
        round = M.text(newRound, Calling.MAX_ROUND_LENGTH, true);
        M.assert(
          Calling.parseRound(round, { legacyFifth: false }) !== undefined,
          "콜링 차수 또는 회차 이름을 확인해 주세요.",
        );
      } catch (error) {
        round = "";
        issue(row, error.message);
      }
      summaryMode = false;
      continue;
    }
    const header = detailHeader(value);
    if (header) {
      includesCaller = header.includesCaller;
      summaryMode = false;
      continue;
    }

    const callerSummary =
      summaryMode || (!round && !district) ? CALLER_SUMMARY.exec(value) : null;
    if (summaryMode || (callerSummary && COUNT_FIELD.test(normalize(callerSummary[2])))) {
      if (!callerSummary) {
        issue(
          row,
          "‘콜링자/건수’ 아래에는 ‘이름/건수’ 형식으로 입력해 주세요.",
        );
        continue;
      }
      try {
        const name = M.text(callerSummary[1], 100, true);
        reportedCallers.set(normalize(name), name);
      } catch (error) {
        issue(row, error.message);
      }
      continue;
    }

    totalRows++;
    try {
      M.assert(date, "콜링 날짜를 선택하거나 상세 행 앞에 일보 날짜를 입력해 주세요.");
      M.assert(round, "상세 행 앞에 콜링 회차 제목을 입력해 주세요.");
      M.assert(
        district,
        "상세 행 앞에 ‘- 1구역’처럼 구역을 입력해 주세요.",
      );
      const fields = detailFields(detail, includesCaller);
      const singleCaller =
        reportedCallers.size === 1
          ? reportedCallers.values().next().value
          : "";
      const name =
        fields.caller || explicitCaller || singleCaller || fallbackCaller;
      M.assert(
        name,
        "콜링자를 확인할 수 없습니다. ‘콜링자: 이름’을 상세 앞에 입력하거나 기본 콜링자를 지정해 주세요.",
      );
      rows.push({
        ...fields,
        sheet: SHEET,
        row,
        date,
        round,
        area: M.text(district, 60, true),
        caller: name,
      });
    } catch (error) {
      issue(row, error.message);
    }
  }
  if (!totalRows && !errorCount) issue(1, "변환할 콜링 상세 행이 없습니다.");
  return { rows, errors, totalRows, errorCount };
}

module.exports = { MAX_TEXT, parse };
