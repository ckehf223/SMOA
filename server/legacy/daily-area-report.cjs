"use strict";

const M = require("./model.cjs");
const { parseClock } = require("./clock.cjs");

const datePattern = String.raw`^(?:(\d{4})\s*[./년-]\s*)?(\d{1,2})\s*[./월-]\s*(\d{1,2})\s*(?:일|\.)?(?:\s*\([월화수목금토일](?:요일)?\))?`;
const dateStart = new RegExp(`${datePattern}(?=\\s|$)`, "u");
const slashDateStart = new RegExp(`${datePattern}\\s*[/／]`, "u");
const stageStart =
  /^(찾\s*[ab]|만픽|콜링|합\s*[ab]|영따|복\s*[abc]|복음방|복신|신카(?:\s*접수)?|센터\s*등록|입교)(?=\s|[(:：]|$)/iu;
const activityStart =
  /^(?:[1-4][.．)]\s*)?(적극적?\s*활동자|전도비\s*후원자|소극적?\s*활동자|비활동자)\s*[:：]?\s*(.*)$/u;
const statusType =
  /^(?:[ㅇ○o]\s*)?(신규\s*[/·]\s*유지|신규|유지|탈락)\s*[:：]?$/iu;
const namePattern = /^[\p{L}][\p{L}\p{N}·'-]{1,39}(?:\[[^\]\s]+\])?$/u;
const sexPattern = /^(남|여)(?:자|성)?$|^(기타|미입력)$/u;
const phonePattern =
  /(?<!\d)(?:(?:\+82[- ]?10|01[016789])[- ]?\d{3,4}[- ]?\d{4})(?!\d)/u;
const reasonPattern =
  /(?:^|\s)(연락\s*두절|연락\s*안\s*됨|연락\s*불가|부재|비합|차단|거절|군대|중복\s*섭외|중복|이사|타지역|불참)$/u;

function canonicalStage(label) {
  if (/^(복[ABC]|복음방|복신)$/u.test(label)) return "복음방";
  return label === "신카" ? "신카접수" : label;
}

const usesTeacherField = (stage) => !["찾B", "만픽", "콜링"].includes(stage);

function clean(line) {
  return line
    .replace(/&#(?:x([\da-f]{1,6})|(\d{1,7}));/giu, (_, hex, dec) => {
      const value = hex ? Number.parseInt(hex, 16) : Number(dec);
      return value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .normalize("NFC")
    .replace(/&nbsp;/giu, " ")
    .replace(/[\u200b-\u200d\uFE0F\uFEFF]/gu, "")
    .replace(/\*\*/gu, "")
    .replace(/\\(?=[.．])/gu, "")
    .replace(/[\\\s]+$/gu, "")
    .replace(/^[\s\p{Extended_Pictographic}▪▫·]+/gu, "")
    .replace(/^[<〈＜]\s*|\s*[>〉＞]$/gu, "")
    .trim();
}

function districtTitle(line) {
  return (
    clean(line)
      .match(
        /^(?:구역\s*[:：]\s*)?([\p{L}\p{N}][\p{L}\p{N} ·_-]{0,56}?\s*구역)\s*(?:(?:일일\s*)?(?:보고|활동\s*(?:계획|보고|일보))|일보)?$/u,
      )?.[1]
      .replace(/\s+구역$/u, "구역") || ""
  );
}

function normalizeDate(match, year, reportDate = "") {
  const [, explicitYear, month, day] = match;
  const resolvedYear =
    explicitYear ||
    (reportDate.slice(5, 7) === "01" && Number(month) === 12 ? year - 1 : year);
  const value = [
    resolvedYear,
    month.padStart(2, "0"),
    day.padStart(2, "0"),
  ].join("-");
  try {
    return M.date(value);
  } catch {
    return "";
  }
}

function stageNumber(value, label) {
  const triplet = value.match(/[:：]\s*(\d+)\s*[/／]\s*(\d+)\s*[/／]\s*\d+/u);
  if (triplet)
    return {
      label,
      expected: { 신규: Number(triplet[1]), 탈락: Number(triplet[2]) },
    };
  const textCounts = Object.fromEntries(
    [...value.matchAll(/(신규|탈락)\s*[:：]?\s*(\d+)\s*건/gu)].map(
      ([, type, count]) => [type, Number(count)],
    ),
  );
  return { label, expected: textCounts };
}

function activityStatus(label) {
  if (/^적극/u.test(label)) return 1;
  if (/^전도비/u.test(label)) return 2;
  if (/^소극/u.test(label)) return 3;
  return 4;
}

function activityNames(line) {
  const entries = [
    ...line.matchAll(
      /(?:^|[\s,，;；])([\p{L}][\p{L}\p{N}·'-]{1,39}(?:\[[^\]\s]+\])?)\s*[/／]\s*(?=\S)/gu,
    ),
  ].map(([, name]) => name);
  if (entries.length) return entries;
  const names = line
    .replace(/^\(|\)$/gu, "")
    .split(/[\s,，;；]+/u)
    .filter(Boolean);
  return names.length && names.every((name) => namePattern.test(name))
    ? names
    : [];
}

function parseAge(value = "") {
  const match = value.match(/^(\d{1,3})(?:세|살)?(?:\(\d{1,2}월(?:생)?\))?$/u);
  return match && Number(match[1]) <= 120 ? Number(match[1]) : "";
}

function parseTime(token = "") {
  const value = token.replace(/까지$/u, "");
  if (
    !/^(?:\d{1,4}|\d{1,2}(?:시(?:\d{1,2}분)?|:\d{1,2}|\.\d{1,2}))$/u.test(value)
  )
    return "";
  try {
    if (value.includes(".")) {
      const mins = Math.round(Number(value) * 60);
      return parseClock(
        `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`,
      );
    }
    return parseClock(value);
  } catch {
    return "";
  }
}

function parsePhone(value = "") {
  const digits = value.replace(/\D/gu, "").replace(/^82/u, "0");
  return digits.length
    ? `${digits.slice(0, 3)}-${digits.slice(3, -4)}-${digits.slice(-4)}`
    : "";
}

function takeStatus(tokens, fallback) {
  const explicitIndex = tokens.findIndex((token) =>
    /^(신규|유지|탈락)$/u.test(token),
  );
  return explicitIndex >= 0 ? tokens.splice(explicitIndex, 1)[0] : fallback;
}

function tableCells(value) {
  const fields = (
    value.startsWith("|") && value.endsWith("|") ? value.slice(1, -1) : value
  )
    .split("|")
    .map((field) => field.trim());
  return fields.every((field) => /^:?-{2,}:?$/u.test(field)) ? [] : fields;
}

function tableTarget(cells, reportDate, year, warn) {
  const [
    stageLabel,
    status,
    sourceDate,
    classification,
    method,
    name,
    sex,
    ageText,
    contact,
    residence,
    place,
    timeText,
    introducer,
    teacher,
    reason,
  ] = cells;
  if (status === "유지") return;
  const match = stageLabel.match(stageStart);
  if (
    cells.length !== 15 ||
    !match ||
    !["신규", "탈락"].includes(status) ||
    !namePattern.test(name)
  ) {
    warn("대상자 표의 15개 열과 단계·구분·대상자 이름을 확인해 주세요.");
    return;
  }
  const stage = canonicalStage(match[1].replace(/\s/gu, "").toUpperCase());
  const found = sourceDate.match(dateStart);
  const date =
    found && found[0] === sourceDate
      ? normalizeDate(found, Number(reportDate.slice(0, 4)) || year, reportDate)
      : "";
  if (!date) {
    warn(`${stage} ${status} 행의 찾은 날짜를 확인해 주세요.`);
    if (stage === "찾B" && status === "신규") return;
  }
  if (classification && !/^(비오픈|오픈)$/u.test(classification))
    warn("오픈여부는 오픈 또는 비오픈으로 입력해 주세요.");
  const gender = sex.match(sexPattern)?.slice(1).find(Boolean) || "";
  const age = parseAge(ageText);
  const time = parseTime(timeText);
  const phone = parsePhone(contact.match(phonePattern)?.[0]);
  if (sex && !gender) warn("성별 값을 확인해 주세요.");
  if (ageText && age === "") warn("나이 값을 확인해 주세요.");
  if (timeText && !time) warn("찾기시간을 확인해 주세요.");
  if (contact && !phone) warn("연락처 형식을 확인해 주세요.");
  if (!introducer) warn(`${stage} ${status} 행의 인도자가 비어 있습니다.`);
  return {
    stage,
    status,
    date,
    sourceFoundDate: date,
    classification,
    method,
    name,
    gender,
    age,
    phone,
    residence,
    place,
    time,
    introducer,
    teacher,
    reason,
  };
}

const isSlashPhone = (value) => Boolean(value && value.match(phonePattern)?.[0] === value);
const slashColumns = (text) => text.split(/[/／]/u).map((cell) => cell.trim());
const slashValue = (value) => /^(?:-|–|—)$/u.test(value) ? "" : value;

function slashTarget(text, hasTeacher, warn) {
  const cells = slashColumns(text).map(slashValue);
  if (isSlashPhone(cells[4])) cells.splice(4, 0, "", "");
  else if (isSlashPhone(cells[5])) {
    if (sexPattern.test(cells[4])) cells.splice(5, 0, "");
    else if (parseAge(cells[4]) !== "") cells.splice(4, 0, "");
  }
  // The last field is the optional reason. Accept a final separator after it.
  const maxColumns = hasTeacher ? 13 : 12;
  if (cells.length === maxColumns + 1 && cells.at(-1) === "") cells.pop();
  if (cells.length < maxColumns - 1 || cells.length > maxColumns) {
    warn("/ 구분자와 항목 수를 확인해 주세요. 빈 항목에도 /를 남겨 주세요.");
    return;
  }
  const [
    classification1,
    classification2,
    method,
    name,
    sex,
    ageText,
    contact,
    residence,
    place,
    timeText,
    ...lastFields
  ] = cells;
  const [teacher, introducer, reason = ""] = hasTeacher
    ? lastFields
    : ["", ...lastFields];
  return slashFields({
    classification1, classification2, method, name, gender: sex, age: ageText,
    phone: contact, residence, place, time: timeText, introducer, teacher, reason,
  }, warn);
}

function slashFields({
  classification1 = "", classification2 = "", method = "", name = "", gender: sex = "",
  age: ageText = "", phone: contact = "", residence = "", place = "", time: timeText = "",
  introducer = "", teacher = "", reason = "",
}, warn) {
  const gender = sex.match(sexPattern)?.slice(1).find(Boolean) || "";
  const age = parseAge(ageText);
  const time = parseTime(timeText);
  const phone = isSlashPhone(contact) ? parsePhone(contact) : "";
  if (
    classification1 &&
    !M.PERSON_CLASSIFICATIONS.classification1.includes(classification1)
  )
    warn("분류1 값을 확인해 주세요.");
  if (
    classification2 &&
    classification2 !== "지인" &&
    !M.PERSON_CLASSIFICATIONS.classification2.includes(classification2)
  )
    warn("분류2 값을 확인해 주세요.");
  if (sex && !gender) warn("성별 값을 확인해 주세요.");
  if (ageText && age === "") warn("나이 값을 확인해 주세요.");
  if (contact && !phone) warn("연락처 형식을 확인해 주세요.");
  if (timeText && !time) warn("찾기시간을 확인해 주세요.");
  return {
    classification: "",
    classification1,
    classification2,
    method,
    name,
    gender,
    age,
    phone,
    residence,
    place,
    time,
    introducer,
    teacher,
    reason,
  };
}

function isCustomSlashRow(value) {
  if (/^\(*\s*(?:ex\s*[.)：:]|예시\s*[.)：:])/iu.test(value)) return false;
  const plainDate = value.match(dateStart);
  if (plainDate && !/^\s*[/／]/u.test(value.slice(plainDate[0].length))) return false;
  return /[/／]/u.test(value);
}

function customSlashTarget(text, layout, reportDate, year, fallbackStatus, stage, warn) {
  const cells = slashColumns(text);
  const headings = cells.map((cell) => cell.replace(/\s+/gu, ""));
  if (headings.some((cell) => /^(?:날짜|찾은날짜|찾기날짜|찾B일)$/u.test(cell)) &&
      headings.some((cell) => /^(?:대상자|대상자명|이름|성명)$/u.test(cell))) return;
  const dateIndex = layout.indexOf("date");
  let matchingColumnCount = false;
  // Slash is only part of a value in the configured date position. All other columns stay fixed.
  for (const width of [1, 2, 3]) {
    const count = cells.length - width + 1;
    const trailingSeparator = count === layout.length + 1 && cells.at(-1) === "";
    if (count !== layout.length && !trailingSeparator) continue;
    matchingColumnCount = true;
    const separatorDate = cells.slice(dateIndex, dateIndex + width).join("/");
    const match = separatorDate.match(dateStart);
    if (!match || match[0] !== separatorDate) continue;
    const date = normalizeDate(match, Number(reportDate.slice(0, 4)) || year, reportDate);
    if (!date) continue;
    const values = [...cells.slice(0, dateIndex), date, ...cells.slice(dateIndex + width)];
    const fields = Object.fromEntries(layout.map((field, index) => [field, slashValue(values[index])]));
    const status = fields.status || fallbackStatus;
    if (status === "유지") return;
    if (!["신규", "탈락"].includes(status)) {
      warn(`${stage} 상세 행의 신규·유지·탈락 표기를 확인해 주세요.`);
      return;
    }
    return { row: slashFields(fields, warn), date, status };
  }
  warn(matchingColumnCount
    ? `${stage} 상세 행의 사용자 지정 날짜와 / 구분자를 확인해 주세요.`
    : `${stage} 상세 행의 사용자 지정 / 항목 수를 확인해 주세요. 빈 항목에도 /를 남겨 주세요.`);
}

function fields(text, status, hasTeacher, knownNames) {
  const phone = parsePhone(text.match(phonePattern)?.[0]);
  const tokens = text
    .replace(phonePattern, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .map((value) =>
      /^(?:-|x|×|없음)$/iu.test(value) ? "" : value.replace(/_/gu, " "),
    );
  const classificationIndex = tokens.findIndex((token) =>
    /^(비오픈|오픈)$/u.test(token),
  );
  const classification =
    classificationIndex >= 0 ? tokens.splice(classificationIndex, 1)[0] : "";
  let sexIndex = tokens.findIndex((token) =>
    /^(남|여)(?:자|성)?$/u.test(token),
  );
  if (sexIndex < 0)
    sexIndex = tokens.findIndex((token) => sexPattern.test(token));
  let method = "",
    name = "",
    gender = "",
    age = "",
    residence = "",
    place = "",
    time = "",
    introducer = "",
    teacher = "",
    reason = "";
  if (sexIndex < 0) {
    if (tokens.length >= 3 && !classification) {
      [name, introducer] = tokens;
      method = tokens.at(-1);
      if (hasTeacher && tokens.length > 3) teacher = tokens[2];
    } else {
      name = tokens.at(-1) || "";
      method = tokens.slice(0, -1).join(" ");
    }
    return {
      phone,
      classification,
      method,
      name,
      gender,
      age,
      residence,
      place,
      time,
      introducer,
      teacher,
      reason,
    };
  }

  const front = tokens.slice(0, sexIndex);
  if (!classification && front.length === 3) {
    [name, introducer, method] = front;
  } else {
    name = front.at(-1) || "";
    method = front.slice(0, -1).join(" ");
  }
  gender = tokens[sexIndex].match(sexPattern)?.slice(1).find(Boolean) || "";
  const tail = tokens.slice(sexIndex + 1);
  age = parseAge(tail[0]);
  if (age !== "" || tail[0] === "") tail.shift();

  if (status === "탈락") {
    const explicit = tail.findIndex((value) =>
      /^(?:탈락)?사유[:：]?/u.test(value),
    );
    if (explicit >= 0) {
      reason = tail
        .splice(explicit)
        .join(" ")
        .replace(/^(?:탈락)?사유\s*[:：]?\s*/u, "");
    } else {
      const known = tail.join(" ").match(reasonPattern)?.[1];
      if (known) {
        reason = known;
        tail.splice(tail.length - known.split(/\s+/u).length);
      }
    }
  }

  const timeIndex = tail.findLastIndex((token) => parseTime(token));
  let memberIndex;
  if (timeIndex >= 0) {
    time = parseTime(tail[timeIndex]);
    memberIndex = timeIndex + 1;
  } else if (introducer) {
    memberIndex = tail.length;
  } else {
    const isKnown = (name) =>
      knownNames.has(name) ||
      [...knownNames].some((member) => member.replace(/[A-Z]$/u, "") === name);
    const known = tail.findIndex(
      (token, index) => index > 0 && isKnown(token.replace(/\(.*\)$/u, "")),
    );
    const expected = hasTeacher && tail.length >= 3 ? 2 : 1;
    memberIndex = known >= 0 ? known : Math.max(0, tail.length - expected);
  }

  const location = tail.slice(0, timeIndex >= 0 ? timeIndex : memberIndex);
  const people = tail.slice(memberIndex);
  residence = location.shift() || "";
  place = location.join(" ").trim();
  introducer ||= people.shift() || "";
  if (hasTeacher) teacher = people.shift() || "";
  if (status === "탈락") {
    const annotated = introducer.match(/^(.+?)\(([^)]+)\)$/u);
    if (annotated) [, introducer] = annotated;
    reason ||= annotated?.[2] || people.join(" ");
  }
  return {
    phone,
    classification,
    method,
    name,
    gender,
    age,
    residence,
    place,
    time,
    introducer,
    teacher,
    reason,
  };
}

function parse(text, fallbackYear = new Date().getFullYear(), { slashLayouts = {} } = {}) {
  M.text(text, 1_000_000, true);
  const year = Number(fallbackYear);
  M.assert(
    Number.isInteger(year) && year >= 1900 && year <= 9999,
    "일보의 기준 연도를 확인해 주세요.",
  );
  const input = text.split(/\r\n?|\n/u).map(clean);
  const reports = [];
  const warnings = [];
  let current;
  let section;
  let stage;
  let status;
  let hasTeacher;
  let activityCount;
  let knownNames;
  let summary;
  let hasStage;
  let table;

  const warn = (line, message) =>
    warnings.push(`${current.district} ${line}줄 · ${message}`);
  const finish = () => {
    if (!current) return;
    if (!current.date) {
      warn(
        current.line,
        "보고일을 확인할 수 없어 해당 구역을 변환하지 않았습니다.",
      );
      return;
    }
    const reportedActivities = current.activities;
    const unique = new Map();
    for (const { name, status: code } of reportedActivities)
      unique.set(name, Math.min(unique.get(name) ?? 4, code));
    current.activities = [...new Set([...knownNames, ...unique.keys()])]
      .filter((name) => unique.has(name))
      .map((name) => ({ name, status: unique.get(name) }));
    current.hasActivityReport = current.activities.length > 0 || activityCount === 0;
    const activeCount = current.activities.filter(
      (entry) => entry.status < 4,
    ).length;
    if (activityCount !== undefined && activityCount !== activeCount)
      warn(
        current.line,
        `활동자 총원은 ${activityCount}명이고 활동 유형을 확인한 이름은 ${activeCount}명입니다.`,
      );

    for (const change of current.changes) {
      if (
        change.date &&
        ((["찾B", "만픽"].includes(change.stage) && change.date > current.date) ||
          (change.stage === "찾B" && change.status === "신규" && change.date !== current.date))
      )
        warn(
          change.line,
          `대상자 행의 날짜 ${change.date}가 보고일 ${current.date}과 다릅니다.`,
        );
    }
    for (const { label, expected, actual, line, grouped } of summary) {
      if (grouped) continue;
      for (const [type, count] of Object.entries(expected)) {
        if (count !== actual[type])
          warn(
            line,
            `${label} ${type} 소계는 ${count}건이고 상세 행은 ${actual[type]}건입니다.`,
          );
      }
    }
    if (!hasStage && !current.activities.length && !current.changes.length)
      warn(current.line, "활동자 또는 단계 항목을 확인해 주세요.");
    reports.push(current);
  };

  for (let idx = 0; idx < input.length; idx++) {
    const line = idx + 1;
    const value = input[idx];
    if (!value) continue;
    const district = districtTitle(value);
    if (district) {
      finish();
      current = { date: "", district, activities: [], changes: [], line };
      section = 0;
      stage = null;
      status = "";
      hasTeacher = false;
      activityCount = undefined;
      knownNames = new Set();
      summary = [];
      hasStage = false;
      table = "";
      continue;
    }
    if (!current) continue;

    const dateLabel = value.match(/^날짜\s*[:：]\s*(.*)$/u);
    if (dateLabel || (!current.date && /일보$/u.test(value))) {
      const day = (dateLabel ? dateLabel[1] : value).match(dateStart);
      const date = day ? normalizeDate(day, year) : "";
      if (date && current.date && date !== current.date)
        warn(
          line,
          `같은 구역 일보에 날짜가 두 개 있습니다. 첫 날짜 ${current.date}를 사용했습니다.`,
        );
      else if (!current.date) current.date = date;
      continue;
    }

    if (value === "[활동자]" || value === "[대상자]") {
      table = value;
      continue;
    }
    if (table) {
      const cells = tableCells(value);
      if (!cells.length) continue;
      if (table === "[활동자]") {
        if (cells[0] === "활동여부" && cells[1] === "이름") continue;
        const [code, name] = cells;
        if (
          cells.length === 3 &&
          /^[1-4]$/u.test(code) &&
          namePattern.test(name)
        )
          current.activities.push({ name, status: Number(code) });
        else
          warn(
            line,
            "활동자 표의 활동여부(1~4)·이름·활동내용 열을 확인해 주세요.",
          );
      } else {
        if (cells[0] === "단계" && cells[1] === "구분") continue;
        const change = tableTarget(cells, current.date, year, (message) =>
          warn(line, message),
        );
        if (change) current.changes.push({ ...change, line });
      }
      continue;
    }

    const total = value.match(
      /^활동자\s*(?:수)?\s*[:：]\s*(?:총\s*)?(\d+)\s*명(?:\s*\((.*))?/u,
    );
    if (total) {
      activityCount = Number(total[1]);
      let roster = total[2];
      if (roster === undefined && input[idx + 1]?.startsWith("("))
        roster = input[++idx];
      if (roster !== undefined) {
        while (
          !roster.includes(")") &&
          input[idx + 1] &&
          input[idx + 1]
            .replace(/\)$/u, "")
            .split(/\s+/u)
            .every((name) => namePattern.test(name))
        ) {
          roster += ` ${input[++idx]}`;
        }
        for (const name of activityNames(roster)) knownNames.add(name);
      }
      continue;
    }

    const activity = value.match(activityStart);
    if (activity) {
      section = activityStatus(activity[1]);
      const details = activity[2].replace(/^\d+\s*명\s*/u, "");
      for (const name of activityNames(details))
        current.activities.push({ name, status: section });
      continue;
    }

    const heading = value.match(stageStart);
    if (heading && !(stage && slashLayouts[stage.name] && /^\s*[/／]/u.test(value.slice(heading[0].length)))) {
      hasStage = true;
      section = 0;
      status = "";
      const label = heading[1].replace(/\s/gu, "").toUpperCase();
      if (
        /^복[ABC]$/u.test(label) &&
        stage?.label === "복음방" &&
        !stage.actual.신규 &&
        !stage.actual.탈락
      )
        stage.grouped = true;
      stage = {
        ...stageNumber(value, label),
        name: canonicalStage(label),
        actual: { 신규: 0, 탈락: 0 },
        line,
      };
      summary.push(stage);
      hasTeacher = usesTeacherField(label);
      continue;
    }
    if (/^(찾기(?:\s*건수)?|합자)\s*[:：]/u.test(value)) {
      section = 0;
      stage = null;
      status = "";
      continue;
    }
    if (section) {
      if (
        value.startsWith("(") ||
        /^(구체적\s*활동|활동한\s*항목)/u.test(value)
      )
        continue;
      for (const name of activityNames(value))
        current.activities.push({ name, status: section });
      continue;
    }
    if (!stage) continue;

    const statusLine = value.match(statusType);
    if (statusLine) {
      status = statusLine[1].replace(/\s/gu, "");
      continue;
    }
    if (/^날짜(?:\s|$)/u.test(value)) {
      hasTeacher = /상담사|교사/u.test(value);
      continue;
    }

    const layout = slashLayouts[stage.name];
    const customSlashLayout = Boolean(layout && isCustomSlashRow(value));
    let row, date, rowStatus, slashMatch;
    if (customSlashLayout) {
      const change = customSlashTarget(value, layout, current.date, year, status, stage.name, (message) => warn(line, message));
      if (!change) continue;
      ({ row, date, status: rowStatus } = change);
    } else {
      slashMatch = value.match(slashDateStart);
      const dateMatch = slashMatch || value.match(dateStart);
      if (!dateMatch) continue;
      let rowText = value.slice(dateMatch[0].length).trim();
      if (
        !slashMatch &&
        phonePattern.test(input[idx + 1] || "") &&
        /^(?:\+82[- ]?|01[016789])/u.test(input[idx + 1])
      )
        rowText += ` ${input[++idx]}`;
      const tokens = slashMatch ? [] : rowText.split(/\s+/u);
      rowStatus = slashMatch ? status : takeStatus(tokens, status);
      if (rowStatus === "유지") continue;
      if (!["신규", "탈락"].includes(rowStatus)) {
        warn(line, `${stage.name} 상세 행의 신규·유지·탈락 표기를 확인해 주세요.`);
        continue;
      }
      date = normalizeDate(dateMatch, Number(current.date.slice(0, 4)) || year, current.date);
      row = slashMatch
        ? slashTarget(rowText, usesTeacherField(stage.label), (message) => warn(line, message))
        : fields(tokens.join(" "), rowStatus, hasTeacher, knownNames);
    }
    if (!row) continue;
    if (!date || !namePattern.test(row.name)) {
      warn(
        line,
        `${stage.name} ${rowStatus} 행의 날짜 또는 대상자 이름을 확인해 주세요.`,
      );
      continue;
    }
    if (!row.introducer && (!customSlashLayout || layout.includes("introducer")))
      warn(line, `${stage.name} ${rowStatus} 행의 인도자가 비어 있습니다.`);
    stage.actual[rowStatus]++;
    current.changes.push({
      ...row,
      status: rowStatus,
      stage: stage.name,
      date,
      ...(stage.name === "찾B" ? { sourceFoundDate: date } : {}),
      ...(customSlashLayout ? { customSlashLayout: true } : {}),
      line,
    });
  }
  finish();
  M.assert(
    reports.length,
    warnings[0] || "구역 제목과 보고일이 있는 일보를 입력해 주세요.",
  );
  M.assert(
    reports.reduce(
      (count, report) =>
        count + report.activities.length + report.changes.length,
      0,
    ) <= 10000,
    "한 번에 10,000행까지 변환할 수 있습니다.",
  );
  return { reports, warnings };
}

module.exports = { parse, districtTitle };
