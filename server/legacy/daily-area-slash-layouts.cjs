"use strict";

const stages = Object.freeze([
  "찾B",
  "만픽",
  "찾A",
  "합B",
  "합A",
  "영따",
  "복음방",
  "신카접수",
  "센터등록",
  "입교",
  "콜링",
]);

const fieldLabels = Object.freeze({
  date: "날짜",
  classification1: "분류1",
  classification2: "분류2",
  method: "도구",
  name: "대상자명",
  gender: "성별",
  age: "나이",
  phone: "핸드폰 번호",
  residence: "거주지",
  place: "찾기장소",
  time: "찾기시간",
  teacher: "상담사",
  introducer: "인도자",
  reason: "탈락사유",
  status: "구분",
});

const common = [
  "date",
  "classification1",
  "classification2",
  "method",
  "name",
  "gender",
  "age",
  "phone",
  "residence",
  "place",
  "time",
];
const early = Object.freeze([...common, "introducer", "reason"]);
const later = Object.freeze([...common, "teacher", "introducer", "reason"]);
const defaultLayouts = Object.freeze(
  Object.fromEntries(
    stages.map((stage) => [
      stage,
      ["찾B", "만픽", "콜링"].includes(stage) ? early : later,
    ]),
  ),
);

const alternateLabels = {
  date: ["일자", "찾은날짜", "찾기날짜", "찾은날", "찾기일", "찾B일"],
  classification1: ["분류1(개척/지인/가족)", "대분류"],
  classification2: ["분류2(노방/소셜링/온라인/세미나/기타)", "소분류"],
  method: ["사용도구", "전도도구"],
  name: ["대상자", "이름", "성명"],
  age: ["연령"],
  phone: [
    "연락처",
    "전화번호",
    "핸드폰",
    "휴대폰",
    "휴대폰번호",
    "휴대전화",
    "휴대전화번호",
  ],
  residence: ["거주지역"],
  place: ["찾은장소", "장소"],
  time: ["찾은시간", "시간"],
  teacher: ["교사", "상담사명", "교사명", "상담사·교사"],
  introducer: ["인도자명"],
  reason: ["사유", "탈락이유"],
  status: ["상태", "진행상태", "단계상태", "신규·유지·탈락"],
};
const labelKey = (label) =>
  label.normalize("NFKC").replace(/\s/gu, "").toLowerCase();
const fieldsByLabel = new Map(
  Object.entries(fieldLabels).flatMap(([id, label]) =>
    [label, ...(alternateLabels[id] || [])].map((item) => [labelKey(item), id]),
  ),
);

function checkFields(fields, label) {
  if (!Array.isArray(fields) || fields.length > Object.keys(fieldLabels).length)
    throw new Error(`${label}의 항목 목록을 확인해 주세요.`);
  const seen = new Set();
  for (const field of fields) {
    if (typeof field !== "string" || !Object.hasOwn(fieldLabels, field))
      throw new Error(`${label}에 알 수 없는 항목이 있습니다.`);
    if (seen.has(field))
      throw new Error(
        `${label}에서 ${fieldLabels[field]} 항목이 두 번 나왔습니다.`,
      );
    seen.add(field);
  }
  if (!seen.has("date") || !seen.has("name"))
    throw new Error(`${label}에 날짜와 대상자명을 넣어 주세요.`);
}

function parseLayout(text) {
  if (typeof text !== "string" || text.length > 600)
    throw new Error("일보 행 형식을 600자 이내로 입력해 주세요.");
  // Copied Excel headings can list classification values inside parentheses.
  const labels = text
    .normalize("NFKC")
    .split(/\/(?![^()]*\))/u)
    .map((label) => label.trim());
  if (labels.length > 1 && labels.at(-1) === "") labels.pop();
  const fields = labels.map((label) => {
    if (!label)
      throw new Error(
        "항목 사이에 빈칸이 있습니다. 항목 이름을 입력해 주세요.",
      );
    const field = fieldsByLabel.get(labelKey(label));
    if (!field) throw new Error(`알 수 없는 항목입니다. ${label}`);
    return field;
  });
  checkFields(fields, "일보 행 형식");
  return fields;
}

function validateLayouts(value) {
  if (value === undefined) return;
  if (
    !value ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    throw new Error("저장된 일보 행 형식을 확인해 주세요.");
  for (const [stage, fields] of Object.entries(value)) {
    if (!Object.hasOwn(defaultLayouts, stage))
      throw new Error("일보 행 형식의 단계를 확인해 주세요.");
    checkFields(fields, `${stage} 행 형식`);
  }
}

function describeLayouts(value) {
  validateLayouts(value);
  const descriptions = (layouts) =>
    Object.fromEntries(
      Object.entries(layouts).map(([stage, fields]) => [
        stage,
        fields.map((field) => fieldLabels[field]).join("/"),
      ]),
    );
  return {
    stages: [...stages],
    fields: Object.values(fieldLabels),
    defaults: descriptions(defaultLayouts),
    layouts: descriptions(value ?? {}),
  };
}

module.exports = {
  stages,
  fieldLabels,
  defaultLayouts,
  parseLayout,
  validateLayouts,
  describeLayouts,
};
