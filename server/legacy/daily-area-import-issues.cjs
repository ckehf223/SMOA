"use strict";

const ISSUE_LIMIT = 300;
const CANDIDATE_LIMIT = 5;
const dateLabels = {
  찾B: "찾B 날짜",
  만픽: "만픽 날짜",
  찾A: "찾A 날짜",
  탈락: "탈락 날짜",
  합B: "합B 날짜",
  "합A\n(육따)": "합A 날짜",
  영따: "영따 날짜",
  복신: "복신 날짜",
  신카접수: "신카접수 날짜",
  센터등록: "센터등록 날짜",
  입교: "입교 날짜",
};
const targetFields = new Set([
  "대상자", "인도자", "  구역", "연락처", "단계", "탈락사유", ...Object.keys(dateLabels),
]);

function fieldValue(value) {
  if (value instanceof Date)
    return Number.isFinite(value.valueOf()) ? value.toISOString().slice(0, 10) : "잘못된 날짜";
  if (value && typeof value === "object")
    return String(value.error || value.text || (value.formula || value.sharedFormula ? "수식" : "읽을 수 없는 값")).trim().slice(0, 300);
  return String(value ?? "").trim().slice(0, 300);
}

function issueFields(entries) {
  return entries.flatMap(([label, value]) => {
    const text = fieldValue(value);
    return text ? [{ label, value: text }] : [];
  });
}

function excelDate(value) {
  return typeof value === "number" && value >= 1 && value <= 2958465
    ? new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000)
    : value;
}

function inputFields(sheet, values, { district, date } = {}) {
  if (sheet === "활동자")
    return issueFields([
      ["이름", values.이름],
      ["부", values.부],
      ["구역", values.구역],
      ["반", values.반],
      ["활동여부", values.활동여부],
      ["보고일", date],
    ]);
  return issueFields([
    ["대상자명", values.대상자],
    ["인도자", values.인도자],
    ["인도자 구역", district ?? values["  구역"]],
    ["연락처", values.연락처],
    ["단계", values.단계],
    ...Object.entries(dateLabels).map(([column, label]) => [label, excelDate(values[column])]),
    ["탈락 사유", values.탈락사유],
    ["보고일", date],
    ...Object.entries(values).filter(([column]) => !targetFields.has(column)),
  ]);
}

function addIssue(issues, {
  sheet = "", row = null, severity, message, summary = message, fields = [],
  candidates, totalCandidates,
}) {
  if (issues.length >= ISSUE_LIMIT) return;
  const issue = { sheet, row, severity, message, summary, fields };
  if (candidates?.length) {
    issue.candidates = candidates.slice(0, CANDIDATE_LIMIT);
    issue.totalCandidates = totalCandidates ?? candidates.length;
  }
  issues.push(issue);
}

module.exports = { ISSUE_LIMIT, CANDIDATE_LIMIT, addIssue, inputFields, issueFields };
