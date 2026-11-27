"use strict";

const { updateWorkbook } = require("./cumulative-xlsx.cjs");
const { phoneKey } = require("./person-phone.cjs");

const FINDING = "찾기DB";
const TEACHER = "교사DB";
const ACTIVITY = "활동수";
const stages = [
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
];
const identityFields = ["name", "district", "worker"];
const dateHeaders = {
  찾B: ["찾B", "찾B일", "찾B날짜", "찾은날짜", "찾기일"],
  만픽: ["만픽", "만픽일", "만픽날짜"],
  찾A: ["찾A", "찾A일", "찾A날짜"],
  합B: ["합B", "합B일", "합B날짜"],
  합A: ["합A(육따)", "합A", "육따"],
  영따: ["영따", "영따일", "따기"],
  복음방: [
    "복신",
    "복음방",
    "복신일",
    "복음방신청서",
    "복음방일",
    "복A",
    "복B",
    "복C",
  ],
  신카접수: [
    "신카접수",
    "신커접수",
    "신가접수",
    "신카",
    "수강신청서",
    "수신서",
  ],
  센터등록: ["센터등록", "센터등록일"],
  입교: ["입교", "입교일"],
  drop: ["탈락", "탈락일", "탈락일자", "탈락날짜", "탈락보고일"],
};
const detailHeaders = {
  first: ["분류1(개척/지인/가족)", "분류1", "유형"],
  second: ["분류2(노방/소셜링/온라인/세미나/기타)", "분류2"],
  tool: ["도구", "전도도구"],
  gender: ["성별"],
  age: ["나이", "연령"],
  phone: [
    "연락처",
    "휴대폰번호",
    "핸드폰번호",
    "휴대전화번호",
    "전화번호",
    "핸드폰",
    "휴대폰",
    "전화",
  ],
  residence: ["거주지", "거주지역"],
  place: ["찾기장소", "찾은장소"],
  time: ["찾기시간", "찾은시간"],
};
const targetHeaders = {
  ...detailHeaders,
  ...dateHeaders,
  dropReason: ["탈락사유", "탈락이유"],
  stage: ["단계", "현재단계"],
  name: ["대상자", "대상자명", "이름", "성명"],
  worker: ["인도자", "인도자명"],
};
const blank = (value) => /^(?:[-–—])?$/u.test(String(value ?? "").trim());
const blankDate = (value) => blank(value) || value === 0 || value === "0";
const key = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toUpperCase();
const districtKey = (value) => key(value).replace(/^(\d+)구역$/u, "$1");
const classKey = (value) => key(value).replace(/^(\d+)반$/u, "$1");
const isoDate = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : "";
function phoneText(value) {
  if (typeof value !== "number") return value;
  const match = phoneKey(value).match(/^(01[016789])(\d{3,4})(\d{4})$/u);
  return match ? match.slice(1).join("-") : String(value);
}
function stageIndex(value) {
  const label = key(value);
  if (!label) return -1;
  return stages.findIndex((stage) =>
    dateHeaders[stage].some((alias) => key(alias) === label),
  );
}

class Table {
  constructor(sheet, fields, required, main) {
    this.sheet = sheet;
    const header = sheet.header(fields, required);
    this.header = header.row;
    this.columns = header.columns;
    this.rows = [...sheet.rows.keys()].filter(
      (row) => row > this.header && !blank(this.get(row, main)),
    );
    this.last = this.rows.reduce(
      (last, row) => Math.max(last, row),
      this.header,
    );
    this.changed = new Set();
  }
  get(row, field) {
    return this.sheet.value(row, this.columns[field]);
  }
  date(row, field, reference) {
    return this.sheet.book.readDate(this.get(row, field), reference);
  }
  stage(row, reference) {
    for (let index = stages.length - 1; index >= 0; index--)
      if (this.date(row, stages[index], reference))
        return Math.max(index, stageIndex(this.get(row, "stage")));
    return stageIndex(this.get(row, "stage"));
  }
  plan(row, values, dates, critical = []) {
    const columns = Object.keys(values)
      .filter((field) => !blank(values[field]))
      .map((field) => this.columns[field])
      .filter(Boolean);
    const nextRow = row || this.sheet.nextRow(this.header, this.last, columns);
    const writes = [];
    for (const [field, value] of Object.entries(values)) {
      if (blank(value) || (!this.columns[field] && field !== "phone")) continue;
      const isDate = dates.includes(field);
      const current = isDate
        ? this.date(nextRow, field, value)
        : this.get(nextRow, field);
      if (String(current) === String(value)) continue;
      if (isDate && !current && !blankDate(this.get(nextRow, field))) {
        if (critical.includes(field)) return null;
        continue;
      }
      if (this.sheet.formula(nextRow, this.columns[field])) {
        if (
          critical.includes(field) ||
          (!row && identityFields.includes(field))
        )
          return null;
        continue;
      }
      writes.push({ field, value, isDate });
    }
    return { row: nextRow, writes, append: !row };
  }
  apply({ row, writes, append }) {
    if (!writes.length) return;
    for (const { field, value, isDate } of writes) {
      const col = (this.columns[field] ||= this.sheet.extraColumn(
        this.header,
        "연락처",
      ));
      this.sheet.set(
        row,
        col,
        value,
        isDate,
        col,
        append ? this.last : undefined,
      );
    }
    if (append) {
      this.sheet.extendRanges(this.header, row, this.last);
      this.rows.push(row);
      this.last = row;
    }
    this.changed.add(row);
  }
}

function makeTables(sheets) {
  return {
    activity: new Table(
      sheets[ACTIVITY],
      {
        area: ["부", "지역"],
        district: ["구역"],
        className: ["반"],
        name: ["이름", "성명", "활동자"],
        status: ["활동여부", "활동상태"],
        date: ["일자", "날짜", "보고일", "활동일자", "활동일"],
      },
      ["district", "name", "status"],
      "name",
    ),
    finding: new Table(
      sheets[FINDING],
      {
        ...targetHeaders,
        area: ["지역", "부", "인도자지역", "인도자부"],
        district: ["구역", "인도자구역"],
        className: ["반", "인도반", "인도자반"],
        teacher: ["상담사", "상담사/교사", "상담사·교사", "상담사/교사명"],
      },
      [
        "stage",
        "name",
        "worker",
        "district",
        "찾B",
        "찾A",
        "drop",
      ],
      "name",
    ),
    teacher: new Table(
      sheets[TEACHER],
      {
        ...targetHeaders,
        area: ["인도자지역", "인도자부", "지역", "부"],
        district: ["인도자구역", "인도구역"],
        className: ["인도자반", "인도반"],
        teacher: [
          "상담사/교사",
          "상담사·교사",
          "상담사",
          "교사",
          "상담사/교사명",
        ],
      },
      ["stage", "name", "worker", "district", "teacher", "합B"],
      "name",
    ),
  };
}

function applyActivity(table, result, warnings) {
  for (const [area, district, className, name, status] of result.activityRows) {
    if (!result.activityDistricts.has(district)) continue;
    const candidates = table.rows.filter(
      (row) =>
        key(table.get(row, "name")) === key(name) &&
        districtKey(table.get(row, "district")) === districtKey(district) &&
        (!area ||
          !table.get(row, "area") ||
          key(table.get(row, "area")) === key(area)) &&
        (!className ||
          !table.get(row, "className") ||
          classKey(table.get(row, "className")) === classKey(className)) &&
        (!table.columns.date ||
          table.date(row, "date", result.date) === result.date),
    );
    const label = `${ACTIVITY} · ${district} ${name}`;
    if (candidates.length > 1) {
      warnings.push(`${label} · 활동자가 여러 행과 일치해 확인이 필요합니다.`);
      continue;
    }
    const row = candidates[0];
    const values = row
      ? { status }
      : { area, district, className, name, status, date: result.date };
    const plan = table.plan(row, values, ["date"], ["status"]);
    if (plan) table.apply(plan);
    else warnings.push(`${label} · 활동 상태 셀에 수식이 있습니다.`);
  }
}

function details(row) {
  return {
    first: row["분류1(개척/지인/가족)"],
    second: row["분류2(노방/소셜링/온라인/세미나/기타)"],
    tool: row.도구,
    name: row.대상자,
    gender: row.성별,
    age: row.나이,
    phone: row.연락처,
    residence: row.거주지,
    place: row.찾기장소,
    time: row.찾기시간,
    area: row.지역,
    district: row["  구역"],
    className: row.반,
    worker: row.인도자,
    teacher: row.상담사,
  };
}

function matches(table, { row, district, worker }) {
  const values = details(row);
  const districts = [district, values.district].map(districtKey);
  const workers = [worker, values.worker].filter(Boolean).map(key);
  return table.rows.filter(
    (index) =>
      key(table.get(index, "name")) === key(values.name) &&
      districts.includes(districtKey(table.get(index, "district"))) &&
      workers.includes(key(table.get(index, "worker"))) &&
      (!values.area ||
        !table.get(index, "area") ||
        key(table.get(index, "area")) === key(values.area)),
  );
}

const isActive = (table, row) => blankDate(table.get(row, "drop"));

function activeMatches(table, rows, explicitPhone) {
  const candidates = rows.filter((row) => isActive(table, row));
  const phone = phoneKey(explicitPhone);
  if (candidates.length > 1 && phone) {
    const exact = candidates.filter(
      (index) => phoneKey(table.get(index, "phone")) === phone,
    );
    if (exact.length) return exact;
  }
  return candidates;
}

function applyTargets({ finding, teacher }, result, warnings) {
  const { date: day } = result;
  const changes = [...result.cumulativeChanges].sort(
    (a, b) =>
      Number(a.status === "탈락") - Number(b.status === "탈락") ||
      stageIndex(a.row.단계) - stageIndex(b.row.단계),
  );
  for (const change of changes) {
    const { row, status, explicitPhone, detailDate } = change;
    const stage = row.단계;
    const index = stageIndex(stage);
    const warn = (message) =>
      warnings.push(`${change.district} ${row.대상자} · ${message}`);
    if (index < 0) {
      warn(`${stage} 단계는 누적 엑셀에 반영할 수 없습니다.`);
      continue;
    }
    if (!row.인도자) {
      warn("누적 반영에 필요한 인도자를 확인해 주세요.");
      continue;
    }
    const isNewFinding = index === 0 && status === "신규";
    const isManpik = stage === "만픽" && status === "신규";
    const promotion = stage === "합B" && status === "신규";
    const table = index < 3 ? finding : teacher;
    const foundDate = isNewFinding ? isoDate(row.찾B) : "";
    if (isNewFinding && !foundDate) {
      warn("신규 찾B 날짜를 확인해 주세요.");
      continue;
    }
    const candidates = matches(table, change);
    const recorded = candidates.filter((index) => !isActive(table, index));
    if (isNewFinding && candidates.some((row) => table.date(row, "찾B", day) === foundDate))
      continue;
    const current = isNewFinding ? [] : activeMatches(table, candidates, explicitPhone);
    const sources = promotion
      ? activeMatches(finding, matches(finding, change), explicitPhone)
      : [];
    if (current.length > 1 || sources.length > 1) {
      warn("누적 엑셀에서 여러 대상자가 일치해 반영할 행을 확인해 주세요.");
      continue;
    }
    const target = current[0];
    const previousStage = table.stage(target, day);
    if ((foundDate || table.date(target, "찾B", day)) > day) {
      warn("찾B 날짜가 보고일보다 늦어 누적에 반영하지 않았습니다.");
      continue;
    }
    if (status === "탈락") {
      if (!table.columns.drop) {
        warn(`${table.sheet.name}의 탈락일 열을 확인해 주세요.`);
        continue;
      }
      if (recorded.some((row) => table.date(row, "drop", day) === day)) continue;
      if (!target) {
        warn(recorded.length
          ? "이미 기록된 탈락일을 확인해 주세요."
          : `${table.sheet.name}에서 일치하는 대상자를 찾지 못했습니다.`);
        continue;
      }
      if (stages.some((step) => table.date(target, step, day) > day)) {
        warn("누적 엑셀의 단계 날짜가 이번 탈락일보다 늦습니다.");
        continue;
      }
      const plan = table.plan(target, { drop: day }, ["drop"], ["drop"]);
      if (plan) table.apply(plan);
      else warn("탈락일 형식 또는 탈락일 셀의 수식을 확인해 주세요.");
      continue;
    }

    const closedDates = recorded.map((row) => table.date(row, "drop", day));
    const duplicate = recorded.some((row, index) => {
      const date = table.date(row, stage, day);
      return closedDates[index] >= day &&
        (date === day || (isManpik && detailDate && date === detailDate));
    });
    if (duplicate) continue;
    if (!target && closedDates.some((date) => !date || date >= day || (foundDate && foundDate <= date))) {
      warn("이전 탈락일과 신규 등록 날짜를 확인해 주세요.");
      continue;
    }
    if (!target && table === finding && matches(teacher, change).some((row) => isActive(teacher, row))) {
      warn(`교사DB에 진행 중인 대상자가 있어 신규 단계(${stage})를 추가하지 않았습니다.`);
      continue;
    }

    const update = target ? {} : details(row);
    let findingPlan;
    const source = sources[0];
    if (source) {
      const sourceFoundDate = finding.date(source, "찾B", day);
      if (sourceFoundDate > day) {
        warn("찾기DB의 찾B 날짜가 보고일보다 늦어 상신을 반영하지 않았습니다.");
        continue;
      }
      const findingStages = ["만픽", "찾A"];
      if (findingStages.some((step) => finding.date(source, step, day) > day)) {
        warn("찾기DB 단계 날짜가 보고일보다 늦어 상신을 반영하지 않았습니다.");
        continue;
      }
      if (!finding.columns.dropReason) {
        warn("찾기DB의 탈락사유 열을 확인해 주세요.");
        continue;
      }
      const reason = finding.get(source, "dropReason");
      if (!blank(reason) && key(reason) !== "상신") {
        warn("찾기DB에 이미 기록된 탈락일 또는 사유를 확인해 주세요.");
        continue;
      }
      findingPlan = finding.plan(
        source,
        {
          drop: day,
          dropReason: "상신",
        },
        ["drop"],
        ["drop", "dropReason"],
      );
      if (!findingPlan) {
        warn(
          "찾기DB의 탈락일 형식 또는 탈락일·탈락사유 셀의 수식을 확인해 주세요.",
        );
        continue;
      }
      if (!target) {
        const values = details(row);
        for (const [field, value] of Object.entries(values)) {
          const original = finding.get(source, field);
          update[field] = blank(original) ? value : original;
        }
        update.phone = phoneText(explicitPhone || update.phone);
        update.찾B = sourceFoundDate;
        for (const step of findingStages)
          update[step] = finding.date(source, step, day);
      }
    }

    const existingMilestone = table.date(target, stage, day);
    let milestone = foundDate || day;
    // An independently registered 만픽 may already have been imported from a prior run.
    if (isManpik && detailDate && (existingMilestone === detailDate ||
      (!target && closedDates.every((date) => detailDate > date))))
      milestone = detailDate;
    if (milestone > day) {
      warn(`${stage} 날짜가 보고일보다 늦어 누적에 반영하지 않았습니다.`);
      continue;
    }
    if (target && stages.slice(1, index).some((step) => table.date(target, step, day) > milestone)) {
      warn("누적 엑셀의 이전 단계 날짜가 이번 단계 날짜보다 늦습니다.");
      continue;
    }
    if (
      !table.columns[stage] ||
      (existingMilestone && existingMilestone !== milestone)
    ) {
      warn(
        `${table.sheet.name}의 ${stage} 열 또는 이미 기록된 날짜를 확인해 주세요.`,
      );
      continue;
    }
    if (!target && table === teacher) {
      for (const step of stages.slice(3, index)) update[step] = day;
    }
    if (!target && isManpik) update.찾B = milestone;
    update[stage] = milestone;
    if (previousStage <= index) update.stage = stage;
    const plan = table.plan(target, update, stages, [stage, "stage"]);
    if (!plan) {
      warn(
        `${table.sheet.name}의 날짜 형식 또는 단계·단계 날짜 셀의 수식을 확인해 주세요.`,
      );
      continue;
    }
    if (findingPlan) finding.apply(findingPlan);
    table.apply(plan);
  }
}

function cumulativeWorkbook(source, password, result) {
  return updateWorkbook(
    source,
    password,
    [ACTIVITY, FINDING, TEACHER],
    (sheets) => {
      const tables = makeTables(sheets);
      const warnings = [];
      applyActivity(tables.activity, result, warnings);
      applyTargets(tables, result, warnings);
      return {
        counts: {
          활동: tables.activity.changed.size,
          [FINDING]: tables.finding.changed.size,
          [TEACHER]: tables.teacher.changed.size,
        },
        warnings,
      };
    },
  );
}

module.exports = { cumulativeWorkbook };
